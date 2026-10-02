// WSL -> Windows bridge transport.
//
// The native host runs on Windows (spawned by Windows Chrome) and listens on a
// Windows named pipe, which a Linux process cannot open. When the MCP server
// runs under WSL we spawn a Windows node.exe that connects to the pipe and
// relays its stdin/stdout, and use that child's stdio as the connection (same
// idea as chrome-wsl-bridge/bridge.py). No daemon: the child lives and dies
// with the connection.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";

// Runs under Windows node.exe. Prints "ok" on STDERR once the pipe is open, so
// the data stream stays pure protocol.
export const RELAY_JS =
  "const s=require('net').connect(process.argv[1]);" +
  "s.on('connect',()=>process.stderr.write('ok\\n'));" +
  "s.on('error',e=>{process.stderr.write('pipe: '+e.message+'\\n');process.exit(1)});" +
  "process.stdin.pipe(s);s.pipe(process.stdout);" +
  "s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end());";

// OCIC_WSL=1/0 forces; otherwise /proc/version mentioning "microsoft".
export function isWsl(env = process.env, procVersion) {
  if (env.OCIC_WSL === "1") return true;
  if (env.OCIC_WSL === "0") return false;
  if (process.platform !== "linux") return false;
  try {
    procVersion ??= fs.readFileSync("/proc/version", "utf-8");
  } catch {
    return false;
  }
  return /microsoft/i.test(procVersion);
}

function configFile() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".config", "open-claude-in-chrome", "config.json"), "utf-8")
    );
  } catch {
    return {};
  }
}

// The Windows account name: env OCIC_WIN_USER, config.json "winUser", else the
// WSL $USER.
export function windowsUser(env = process.env, config = configFile()) {
  return env.OCIC_WIN_USER || config.winUser || env.USER || "default";
}

// Must match endpoint.js getPipePath() on win32 (same sanitising and cap).
// A full pipe path in OCIC_PIPE / config "pipe" is honoured only if it is a
// Windows pipe; a unix path there is meant for the native-POSIX case.
export function windowsPipePath(env = process.env, config = configFile()) {
  for (const p of [env.OCIC_PIPE, config.pipe]) if (p && p.startsWith("\\\\.\\pipe\\")) return p;
  const user = windowsUser(env, config).replace(/[^\w.-]/g, "_").slice(0, 32);
  return `\\\\.\\pipe\\open-claude-in-chrome-${user}`;
}

function versionKey(p) {
  return (p.match(/v(\d+)\.(\d+)\.(\d+)/)?.slice(1) ?? [0, 0, 0]).map((n) => String(n).padStart(6, "0")).join(".");
}

// Newest fnm node.exe, else Program Files; env OCIC_WIN_NODE overrides.
export function findWindowsNode(env = process.env, user = windowsUser(env)) {
  if (env.OCIC_WIN_NODE) return env.OCIC_WIN_NODE;
  const root = `/mnt/c/Users/${user}/AppData/Roaming/fnm/node-versions`;
  let found = [];
  try {
    found = fs
      .readdirSync(root)
      .map((v) => path.join(root, v, "installation", "node.exe"))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => versionKey(a).localeCompare(versionKey(b)));
  } catch {}
  if (!found.length && fs.existsSync("/mnt/c/Program Files/nodejs/node.exe")) {
    found = ["/mnt/c/Program Files/nodejs/node.exe"];
  }
  if (!found.length) throw new Error("no Windows node.exe found (set OCIC_WIN_NODE)");
  return found[found.length - 1];
}

/**
 * A net.Socket-like duplex over a relay child. Emits "connect" once the child
 * reports the pipe is open; closes when the child goes away. `child` needs
 * stdin/stdout/stderr streams, kill() and "close"/"error" events.
 */
export function relayStream(child) {
  let open = false;
  const sock = new Duplex({
    read() {},
    write(chunk, enc, cb) {
      child.stdin.write(chunk, cb);
    },
    final(cb) {
      child.stdin.end();
      cb();
    },
    destroy(err, cb) {
      try {
        child.kill();
      } catch {}
      cb(err);
    }
  });
  Object.defineProperty(sock, "readyState", { get: () => (open && !sock.destroyed ? "open" : "closed") });
  child.stdout.on("data", (d) => sock.push(d));
  child.stdout.on("end", () => sock.push(null));
  child.stdin.on("error", () => {});
  child.stderr.on("data", (d) => {
    if (!open && String(d).includes("ok")) {
      open = true;
      sock.emit("connect");
    }
  });
  child.on("error", (e) => sock.destroy(e));
  child.on("close", () => sock.destroy());
  return sock;
}

export function connectViaWindowsNode(env = process.env, spawnFn = spawn) {
  const node = findWindowsNode(env);
  const child = spawnFn(node, ["-e", RELAY_JS, windowsPipePath(env)], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  return relayStream(child);
}
