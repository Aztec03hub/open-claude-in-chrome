// M2 (session liveness) and H1 (native message size cap) in the real native-host.
// Run: node host/test/session-tracker.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createSessionTracker, DEFAULT_GRACE_MS } from "../session-tracker.js";
import { reconnectDelay } from "../wsl-transport.js";

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native-host.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("tracker: close ends the session after the grace period, a re-claim cancels it", async () => {
  const sent = [];
  const t = createSessionTracker({ send: (m) => sent.push(m), graceMs: 40 });
  t.seen("1", "A"); t.seen("2", "B");
  assert.deepEqual(t.alive().sort(), ["A", "B"]);
  t.closed("1"); t.closed("2");
  t.seen("3", "B"); // B's client reconnected inside the grace window
  await sleep(90);
  assert.deepEqual(sent, [{ type: "session_end", session_id: "A" }]);
  assert.deepEqual(t.alive(), ["B"]);
  t.closed("3");
  t.ended("B"); // client said goodbye itself: no duplicate session_end
  await sleep(90);
  assert.equal(sent.length, 1);
  t.stop();
});

test("tracker (L5): the default grace outlasts two WSL reconnect-backoff ceilings", () => {
  const ceiling = reconnectDelay(99, { wsl: true });
  assert.ok(DEFAULT_GRACE_MS >= 2 * ceiling, `grace ${DEFAULT_GRACE_MS} < 2 x backoff ceiling ${ceiling}`);
  assert.ok(ceiling <= 20_000, "backoff ceiling stays below the old 60 s grace window");
  // Cumulative wait before the 7th attempt (the one that used to land after 60 s) is well inside the grace.
  let t = 0; for (let f = 0; f < 7; f++) t += reconnectDelay(f, { wsl: true });
  assert.ok(t < DEFAULT_GRACE_MS, `7 attempts take ${t} ms`);
});

test("tracker (L5): a client that never sends a session_id keeps the 'default' session alive", () => {
  const t = createSessionTracker({ send() {}, graceMs: 40 });
  t.seen("1", undefined);
  assert.deepEqual(t.alive(), ["default"]);
  t.stop();
});

function startHost() {
  const sock = path.join(os.tmpdir(), `ocic-st-${process.pid}-${Date.now()}.sock`);
  const proc = spawn(process.execPath, [HOST], {
    env: { ...process.env, OCIC_PIPE: sock, OCIC_SESSION_GRACE_MS: "250", OCIC_ALIVE_MS: "100" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const out = [];
  let buf = Buffer.alloc(0);
  proc.stdout.on("data", (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      out.push(JSON.parse(buf.subarray(4, 4 + len).toString()));
      buf = buf.subarray(4 + len);
    }
  });
  proc.stderr.on("data", () => {});
  return { proc, sock, out };
}

async function client(sock, sid) {
  for (let i = 0; i < 50; i++) {
    try {
      const s = await new Promise((res, rej) => {
        const c = net.createConnection(sock);
        c.once("connect", () => res(c));
        c.once("error", rej);
      });
      const lines = [];
      let b = "";
      s.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\n")) >= 0) { lines.push(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); } });
      s.on("error", () => {});
      s.write(JSON.stringify({ type: "client_hello", session_id: sid }) + "\n");
      return { s, lines };
    } catch { await sleep(100); }
  }
  throw new Error("host never listened");
}

test("host: alive sessions are reported; a killed client's session is ended; a reconnect inside the grace is not", async () => {
  const { proc, sock, out } = startHost();
  try {
    const a = await client(sock, "S-dead");
    const b = await client(sock, "S-flaky");
    await sleep(300);
    assert.ok(out.some((m) => m.type === "sessions_alive" && m.session_ids.includes("S-dead") && m.session_ids.includes("S-flaky")), "alive heartbeat lists both");
    a.s.destroy(); // kill -9 equivalent: socket just closes, no session_end
    b.s.destroy();
    const b2 = await client(sock, "S-flaky"); // relay blip: same session id comes back
    await sleep(700);
    assert.deepEqual(out.filter((m) => m.type === "session_end").map((m) => m.session_id), ["S-dead"]);
    assert.ok(out.at(-1).type === "sessions_alive" && out.at(-1).session_ids.join() === "S-flaky", "only the live one is still reported");
    b2.s.destroy();
  } finally {
    proc.kill();
  }
});

test("host (H1): an oversized tool_request is refused for that caller only, the port survives", async () => {
  const { proc, sock, out } = startHost();
  try {
    const c = await client(sock, "S-big");
    c.s.write(JSON.stringify({ id: "1", type: "tool_request", tool: "file_upload", args: { files: [{ base64: "A".repeat(1_200_000) }] }, session_id: "S-big" }) + "\n");
    c.s.write(JSON.stringify({ id: "2", type: "tool_request", tool: "tabs_context_mcp", args: {}, session_id: "S-big" }) + "\n");
    await sleep(500);
    const err = c.lines.find((m) => m.id === "1");
    assert.equal(err.type, "tool_error");
    assert.match(err.error, /limit for a single message to the browser; nothing was sent/);
    assert.ok(!out.some((m) => m.type === "tool_request" && m.tool === "file_upload"), "oversized frame never written to Chrome");
    assert.ok(out.some((m) => m.type === "tool_request" && m.tool === "tabs_context_mcp"), "later small request still goes through");
    assert.equal(proc.exitCode, null, "host still running");
    c.s.destroy();
  } finally {
    proc.kill();
  }
});
