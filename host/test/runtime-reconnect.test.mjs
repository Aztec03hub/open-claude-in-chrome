// tool-runtime end to end: L3 (WSL reconnect backoff + immediate retry for a
// waiting caller) and L8 (a gif_creator export inside browser_batch is saved to a file).
// Run: node host/test/runtime-reconnect.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(here, "..", "tool-runtime.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "occ-rt-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runChild(script, env) {
  const p = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env } });
  let stdout = "";
  p.stdout.on("data", (d) => (stdout += d));
  p.stderr.on("data", () => {});
  const done = new Promise((r) => p.on("close", () => r(stdout)));
  return { p, done };
}

function fakeHost(sock, reply) {
  const srv = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.type === "tool_request") c.write(JSON.stringify({ id: msg.id, type: "tool_response", result: reply(msg) }) + "\n");
      }
    });
  });
  return new Promise((r) => srv.listen(sock, () => r(srv)));
}

test("L8: a gif_creator export inside browser_batch is saved to a file, not returned as image bytes", async () => {
  const sock = path.join(tmp, "h.sock");
  const gifDir = path.join(tmp, "gifs");
  const srv = await fakeHost(sock, () => ({
    content: [{ type: "text", text: "[1/1 gif_creator:export] exported" }, { type: "image", mimeType: "image/gif", data: Buffer.from("GIF89a-test").toString("base64") }]
  }));
  const script = `import { init, callTool, shutdown } from ${JSON.stringify(RUNTIME)};
    await init();
    const r = await callTool("browser_batch", { actions: [{ name: "gif_creator", input: { action: "export", tabId: 1 } }] });
    console.log(JSON.stringify(r)); shutdown(); process.exit(0);`;
  const { done } = runChild(script, { OCIC_WSL: "0", OCIC_PIPE: sock, OCIC_GIF_DIR: gifDir });
  let out;
  try { out = JSON.parse(await done); } finally { srv.close(); }
  assert.ok(!out.content.some((c) => c.type === "image"), "no raw GIF block reaches the client");
  const note = out.content.find((c) => /GIF saved to/.test(c.text || ""));
  assert.ok(note, "a 'GIF saved to <path>' note replaces it");
  assert.equal(fs.readFileSync(note.text.replace("GIF saved to ", "")).toString(), "GIF89a-test");
});

test("L3: WSL relay attempts back off while Chrome is closed, and a waiting caller retries at once", async () => {
  const spawnLog = path.join(tmp, "spawns.log");
  const flag = path.join(tmp, "chrome-up");
  const sock = path.join(tmp, "w.sock");
  // Fake "node.exe": logs each launch; fails until the flag exists, then relays to a unix socket.
  const fakeNode = path.join(tmp, "fake-node.sh");
  fs.writeFileSync(
    fakeNode,
    `#!/bin/sh\necho x >> "${spawnLog}"\n[ -f "${flag}" ] || exit 1\nexec "${process.execPath}" "$1" "$2" "${sock}"\n`,
    { mode: 0o755 }
  );
  const srv = await fakeHost(sock, () => "pong");
  const script = `import { init, callTool, shutdown } from ${JSON.stringify(RUNTIME)};
    await init();
    await new Promise((r) => setTimeout(r, 1700));
    const t0 = Date.now();
    const r = await callTool("tabs_context_mcp", {});
    console.log(JSON.stringify({ r, ms: Date.now() - t0 })); shutdown(); process.exit(0);`;
  const { done, p } = runChild(script, { OCIC_WSL: "1", OCIC_WIN_NODE: fakeNode, USER: "u", OCIC_RECONNECT_MS: "200", OCIC_RECONNECT_MAX_MS: "4000" });
  const killTimer = setTimeout(() => p.kill(), 15_000); // never hang the suite on a failing mutant
  await sleep(1650);
  const spawnsWhileDown = fs.readFileSync(spawnLog, "utf-8").trim().split("\n").length;
  // constant 200 ms would be ~8 launches by now; 200,400,800 gives 4 (t=0, .2, .6, 1.4)
  try { assert.ok(spawnsWhileDown <= 5, `backoff: ${spawnsWhileDown} launches in 1.65 s`); } catch (e) { p.kill(); srv.close(); clearTimeout(killTimer); throw e; }
  fs.writeFileSync(flag, "1"); // Chrome is back; the next scheduled attempt is ~1.6 s away
  let out;
  try { out = JSON.parse(await done); } finally { srv.close(); clearTimeout(killTimer); }
  assert.match(JSON.stringify(out.r), /pong/);
  assert.ok(out.ms < 900, `the waiting caller triggered an immediate attempt (${out.ms} ms)`);
});
