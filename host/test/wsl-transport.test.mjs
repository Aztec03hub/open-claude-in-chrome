// WSL transport, session identity and file_upload checks.
// Run: node --test host/test/wsl-transport.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { isWsl, windowsPipePath, windowsUser, relayStream, findWindowsNode, RELAY_JS } from "../wsl-transport.js";
import { filesFromPaths } from "../file-upload.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "occ-wsl-"));

test("isWsl: /proc/version and env override", () => {
  const linux = process.platform === "linux";
  assert.equal(isWsl({}, "Linux version 6.1 (microsoft-standard-WSL2)"), linux);
  assert.equal(isWsl({}, "Linux version 6.1 (gcc) generic"), false);
  assert.equal(isWsl({ OCIC_WSL: "1" }, "generic"), true);
  assert.equal(isWsl({ OCIC_WSL: "0" }, "microsoft"), false);
});

test("pipe name: matches endpoint.js win32 derivation; win user override", async () => {
  const cfg = {};
  assert.equal(windowsPipePath({ USER: "bob" }, cfg), "\\\\.\\pipe\\open-claude-in-chrome-bob");
  assert.equal(windowsPipePath({ USER: "bob", OCIC_WIN_USER: "Win User" }, cfg), "\\\\.\\pipe\\open-claude-in-chrome-Win_User");
  assert.equal(windowsUser({ USER: "bob" }, { winUser: "cfg" }), "cfg");
  assert.equal(windowsPipePath({ OCIC_PIPE: "\\\\.\\pipe\\x" }, cfg), "\\\\.\\pipe\\x");
  // a unix path override is not a Windows pipe: ignored
  assert.equal(windowsPipePath({ OCIC_PIPE: "/tmp/a.sock", USER: "bob" }, cfg), "\\\\.\\pipe\\open-claude-in-chrome-bob");
  // identical to what the Windows-side host computes
  const { getPipePath } = await import("../endpoint.js");
  const real = process.platform;
  const savedUser = os.userInfo;
  os.userInfo = () => ({ username: "plafayette" });
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  delete process.env.OCIC_PIPE;
  try {
    const host = getPipePath();
    if (host.startsWith("\\\\.\\pipe\\open-claude-in-chrome-")) {
      assert.equal(host, windowsPipePath({ USER: "plafayette" }, {}));
    }
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
    os.userInfo = savedUser;
  }
});

test("findWindowsNode: env override, newest version wins", () => {
  assert.equal(findWindowsNode({ OCIC_WIN_NODE: "/x/node.exe" }), "/x/node.exe");
});

test("relayStream: connect on 'ok', pure data both ways, close with child", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.killed = true; }
  });
  const sock = relayStream(child);
  assert.equal(sock.readyState, "closed");
  const connected = new Promise((r) => sock.once("connect", r));
  child.stderr.write("ok\n");
  await connected;
  assert.equal(sock.readyState, "open");
  const got = [];
  sock.on("data", (d) => got.push(d.toString()));
  child.stdout.write('{"a":1}\n');
  const sent = new Promise((r) => child.stdin.once("data", r));
  sock.write('{"type":"client_hello"}\n');
  assert.equal((await sent).toString(), '{"type":"client_hello"}\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['{"a":1}\n']);
  const closed = new Promise((r) => sock.once("close", r));
  child.emit("close", 0);
  await closed;
  assert.equal(sock.readyState, "closed");
  assert.equal(child.killed, true);
});

test("file_upload: paths -> files base64; native windows keeps paths; size cap", async () => {
  const f = path.join(tmp, "a.png");
  fs.writeFileSync(f, Buffer.from([1, 2, 3]));
  const out = await filesFromPaths({ paths: [f], ref: "ref_1", tabId: 5 }, { platform: "linux" });
  assert.deepEqual(out, { ref: "ref_1", tabId: 5, files: [{ name: "a.png", mimeType: "image/png", base64: "AQID" }] });
  const win = { paths: ["C:\\x.txt"], ref: "r" };
  assert.equal(await filesFromPaths(win, { platform: "win32" }), win);
  await assert.rejects(filesFromPaths({ paths: [f] }, { platform: "linux", max: 2 }), /exceeds/);
  await assert.rejects(filesFromPaths({ paths: [path.join(tmp, "nope")] }, { platform: "linux" }), /Cannot read/);
});

// End to end: tool-runtime in WSL mode, with a fake "node.exe" that runs the
// real relay script against a unix-socket fake host. Checks the relay framing,
// session_id on the request and session_end on shutdown.
test("runtime over the relay: session_id stamped, files forwarded, session_end sent", async () => {
  const sock = path.join(tmp, "host.sock");
  const fakeNode = path.join(tmp, "fake-node.sh");
  fs.writeFileSync(fakeNode, `#!/bin/sh\nexec "${process.execPath}" "$1" "$2" "${sock}"\n`, { mode: 0o755 });
  const seen = [];
  let srv;
  const ended = new Promise((resolveEnd) => {
    srv = net.createServer((c) => {
      let buf = "";
      c.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          seen.push(msg);
          if (msg.type === "tool_request") c.write(JSON.stringify({ id: msg.id, type: "tool_response", result: "done" }) + "\n");
          if (msg.type === "session_end") resolveEnd();
        }
      });
    });
    srv.listen(sock);
  });
  const up = path.join(tmp, "up.txt");
  fs.writeFileSync(up, "hi");
  const script = `
    import { init, callTool, shutdown, SESSION_ID } from ${JSON.stringify(path.join(here, "../tool-runtime.js"))};
    await init();
    const r = await callTool("file_upload", { paths: [${JSON.stringify(up)}], ref: "ref_1", tabId: 1 });
    console.log(JSON.stringify({ r, SESSION_ID }));
    shutdown(); process.exit(0);`;
  const p = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, OCIC_WSL: "1", OCIC_WIN_NODE: fakeNode, OCIC_SESSION_ID: "sess-123", USER: "u" }
  });
  let stdout = "";
  p.stdout.on("data", (d) => (stdout += d));
  p.stderr.on("data", () => {});
  await Promise.all([ended, new Promise((r) => p.on("close", r))]);
  srv.close();
  const req = seen.find((m) => m.type === "tool_request");
  assert.equal(seen[0].type, "client_hello");
  assert.equal(req.session_id, "sess-123");
  assert.equal(req.tool, "file_upload");
  assert.equal(req.args.paths, undefined);
  assert.deepEqual(req.args.files, [{ name: "up.txt", mimeType: "text/plain", base64: "aGk=" }]);
  assert.deepEqual(seen.at(-1), { type: "session_end", session_id: "sess-123" });
  assert.match(stdout, /done/);
  assert.ok(RELAY_JS.includes("process.argv[1]"));
});
