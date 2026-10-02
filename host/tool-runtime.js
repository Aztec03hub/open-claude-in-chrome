// Shared runtime for open-claude-in-chrome tools.
//
// Joins the browser bridge as a client and exposes a single
// `callTool(name, args)` entry point. The bridge is owned by the native host,
// which Chrome starts and stops with the extension, so this process never has
// to own anything, elect anything, or care who else is attached.
//
// It used to be far more than this: every consumer raced to bind a TCP port,
// and the winner multiplexed all the others through itself. That made an
// ordinary Claude Code session load-bearing for the whole machine. All of it —
// the election, the yield protocol, the peer-classification sniff, the
// self-promotion path, the pidfile — existed to manage a role nobody should
// have had, and went away with it.
//
// This used to live inline in mcp-server.js; it's extracted so that other
// in-process consumers (the codemode + hybrid servers) can call tools
// without going through a child mcp-server.js + stdio MCP roundtrip.

import net from "node:net";
import crypto from "node:crypto";

import { getPipePath } from "./endpoint.js";
import { noteActivity } from "./parent-watch.js";
import { isWsl, windowsPipePath, connectViaWindowsNode, reconnectDelay } from "./wsl-transport.js";
import { filesFromPaths } from "./file-upload.js";
import { findWithModel } from "./find-model.js";
import { saveGifBlocks } from "./gif-save.js";

// Under WSL the host's pipe is a Windows named pipe, reached through a Windows
// node.exe relay child (wsl-transport.js).
// A unix-path OCIC_PIPE is an explicit native override (test harnesses): no relay.
const WSL = isWsl() && !(process.env.OCIC_PIPE && !process.env.OCIC_PIPE.startsWith("\\\\.\\pipe\\"));
const PIPE_PATH = WSL ? windowsPipePath() : getPipePath();

// One id per MCP server process. The extension scopes the tabs a session owns
// by it; a session_end message releases them.
export const SESSION_ID = process.env.OCIC_SESSION_ID || crypto.randomUUID();

const REQUEST_TIMEOUT_MS = 60_000;
// The host dies and respawns whenever Chrome recycles the service worker, and
// background.js reconnects 250ms later. A call landing in that window should
// wait for the bridge to come back rather than fail.
const LINK_GRACE_MS = 5_000;
const RECONNECT_MS = Number(process.env.OCIC_RECONNECT_MS) || (WSL ? 1000 : 500); // each WSL retry spawns node.exe
const RECONNECT_MAX_MS = Number(process.env.OCIC_RECONNECT_MAX_MS) || 30_000;
let reconnectFailures = 0;
const nextReconnectMs = () =>
  reconnectDelay(reconnectFailures++, { wsl: WSL, hasPending: pendingRequests.size > 0, base: RECONNECT_MS, max: RECONNECT_MAX_MS });

let started = false;
let socket = null;
let readBuffer = Buffer.alloc(0);
let reconnectTimer = null;
let warnedNoRelay = false;
let shuttingDown = false;
let requestIdCounter = 0;

const pendingRequests = new Map(); // id -> { resolve, reject, timer, sent }

// Returned when the bridge drops with a request still in flight. Deliberately
// does NOT claim the action failed: the request may have reached the browser
// and run, with only the response lost. The wording has to leave the agent able
// to act — verify, then decide — rather than blindly retry.
const HOST_DROPPED_ERROR =
  "Browser connection dropped after the request was sent, so its result is unknown. " +
  "The action may have ALREADY taken effect in the browser. Do not blindly retry: " +
  "check the current page state first (e.g. take a screenshot or read the page), " +
  "then repeat the action only if it did not happen.";

const NO_BRIDGE_ERROR =
  "Browser extension is not connected. Make sure a supported Chromium browser " +
  "is running with the Open Claude in Chrome extension installed and enabled.";

// Unsolicited upstream events from the extension (not tool responses): the
// imitation-learning recorder posts { type: "recording_complete", ... } when
// a recording finishes. Subscribers (the channel-enabled MCP server) get
// notified so they can inject a channel event into the Claude Code session.
const recordingEventSubscribers = new Set();
export function onRecordingEvent(cb) {
  recordingEventSubscribers.add(cb);
  return () => recordingEventSubscribers.delete(cb);
}
function emitRecordingEvent(msg) {
  for (const cb of recordingEventSubscribers) {
    try {
      cb(msg);
    } catch {}
  }
}

const linkIsUp = () => socket && !socket.destroyed && socket.readyState === "open";

// Wait for the bridge to come back, for callers that arrived while the host was
// being respawned.
function waitForLink(maxMs) {
  if (linkIsUp()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (linkIsUp()) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - startedAt >= maxMs) {
        clearInterval(poll);
        resolve(false);
      }
    }, 100);
  });
}

function handleMessage(msg) {
  if (msg.type === "client_ack") return;
  if (msg.type === "recording_complete") {
    emitRecordingEvent(msg);
    return;
  }
  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve, reject, timer } = pendingRequests.get(msg.id);
    clearTimeout(timer);
    pendingRequests.delete(msg.id);
    if (msg.type === "tool_error") {
      reject(new Error(msg.error || "Tool execution failed"));
    } else {
      resolve(msg.result);
    }
  }
}

function connect() {
  if (shuttingDown) return;
  reconnectTimer = null;

  let sock;
  try {
    sock = WSL ? connectViaWindowsNode() : net.createConnection(PIPE_PATH);
  } catch (err) {
    if (!warnedNoRelay) process.stderr.write(`Cannot reach the Windows bridge: ${err.message}\n`);
    warnedNoRelay = true;
    if (!shuttingDown && !reconnectTimer) reconnectTimer = setTimeout(connect, nextReconnectMs());
    return;
  }
  socket = sock;
  readBuffer = Buffer.alloc(0);
  let established = false;

  sock.on("connect", () => {
    established = true;
    reconnectFailures = 0;
    sock.write(JSON.stringify({ type: "client_hello", session_id: SESSION_ID }) + "\n");
    process.stderr.write(`Joined the browser bridge at ${PIPE_PATH}\n`);
  });

  sock.on("data", (chunk) => {
    readBuffer = Buffer.concat([readBuffer, chunk]);
    let idx;
    while ((idx = readBuffer.indexOf(10)) !== -1) {
      const line = readBuffer.subarray(0, idx).toString("utf-8").trim();
      readBuffer = readBuffer.subarray(idx + 1);
      if (!line) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
  });

  // Nothing to report for a connect that simply found no host: that is the
  // ordinary state when the browser is not running, and the close handler
  // schedules the retry.
  sock.on("error", (err) => {
    if (established) process.stderr.write(`Bridge error: ${err.message}\n`);
  });

  sock.on("close", () => {
    if (socket === sock) socket = null;
    failPending();
    if (!shuttingDown && !reconnectTimer) {
      reconnectTimer = setTimeout(connect, nextReconnectMs());
    }
  });
}

// Settle everything in flight when the link drops.
//
// A request that was actually written may have reached the browser and run,
// with only its response lost — replaying it would silently double-execute the
// action (a click clicks twice) while the agent sees one successful call. There
// is no way to tell "never ran" from "ran, response lost" at this layer, so
// those fail loudly and let the agent decide with page context. A request still
// waiting for the link never went anywhere, so it can say so plainly.
function failPending() {
  if (pendingRequests.size === 0) return;
  for (const [, entry] of pendingRequests) {
    clearTimeout(entry.timer);
    entry.reject(new Error(entry.sent ? HOST_DROPPED_ERROR : NO_BRIDGE_ERROR));
  }
  pendingRequests.clear();
}

function sendToExtension(tool, args) {
  return new Promise((resolve, reject) => {
    const id = String(++requestIdCounter);
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Tool request timed out after 60s"));
    }, REQUEST_TIMEOUT_MS);
    const entry = { resolve, reject, timer, sent: false };
    pendingRequests.set(id, entry);

    const line = JSON.stringify({ id, type: "tool_request", tool, args, session_id: SESSION_ID }) + "\n";

    if (linkIsUp()) {
      entry.sent = true;
      socket.write(line);
      return;
    }

    // Idle backoff may have parked the next attempt far away; a caller is
    // waiting now, so try immediately.
    if (reconnectTimer && !socket && !shuttingDown) {
      clearTimeout(reconnectTimer);
      connect();
    }

    waitForLink(LINK_GRACE_MS).then((ok) => {
      // Only dispatch if still pending: the entry is gone once the promise has
      // settled some other way, and sending then would run an action nobody is
      // waiting on.
      if (!pendingRequests.has(id)) return;
      if (ok && linkIsUp()) {
        entry.sent = true;
        socket.write(line);
        return;
      }
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(new Error(NO_BRIDGE_ERROR));
    });
  });
}

// --- Public API ---

/**
 * Join the browser bridge. Returns as soon as the first connection attempt has
 * been made — deliberately not once it succeeds, because the MCP server has to
 * come up and advertise its tools whether or not a browser is running. Calls
 * made before the bridge is up get the grace period in sendToExtension.
 */
export async function init() {
  if (started) return;
  started = true;
  connect();
}

/**
 * Coerce stringified params that some MCP clients send as strings into
 * the types the extension expects (numbers, arrays). Mutates and
 * returns args.
 */
export function coerceArgs(args) {
  if (!args || typeof args !== "object") return args;
  if (typeof args.tabId === "string") args.tabId = Number(args.tabId);
  if (typeof args.coordinate === "string") {
    try {
      args.coordinate = JSON.parse(args.coordinate);
    } catch {}
  }
  if (typeof args.start_coordinate === "string") {
    try {
      args.start_coordinate = JSON.parse(args.start_coordinate);
    } catch {}
  }
  if (typeof args.region === "string") {
    try {
      args.region = JSON.parse(args.region);
    } catch {}
  }
  return args;
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

/**
 * Call a tool on the extension. Returns an MCP CallToolResult envelope
 * (with text/image/etc. content blocks).
 *
 * Args are coerced (string→number/array) before the call so this is
 * safe to invoke directly with values straight off the MCP wire.
 */
export async function callTool(toolName, args) {
  noteActivity();
  try {
    let coerced = coerceArgs(args ?? {});
    if (toolName === "file_upload") coerced = await filesFromPaths(coerced, { wsl: WSL });
    // browser_batch carries nested tool inputs; coerce each the same way, and
    // map nested file_upload paths to Windows paths like the top level.
    if (toolName === "browser_batch" && Array.isArray(coerced.actions)) {
      for (const a of coerced.actions) {
        if (!a || typeof a.input !== "object") continue;
        coerceArgs(a.input);
        if (a.name === "file_upload") a.input = await filesFromPaths(a.input, { wsl: WSL });
      }
    }
    // `find` is model-backed: the model call runs here (WSL side), not in the browser.
    const result =
      toolName === "find" && !process.env.OCIC_FIND_SUBSTRING
        ? await findWithModel(coerced, sendToExtension)
        : await sendToExtension(toolName, coerced);
    if (typeof result === "string") return textResult(result);
    // Extension-side error results arrive already flagged (handleToolRequest).
    // gif_creator export returns the GIF bytes; keep them as a file here.
    // browser_batch can contain a gif_creator export; saveGifBlocks is a no-op without GIF blocks.
    if (result && result.content) {
      if (toolName !== "gif_creator" && toolName !== "browser_batch") return result;
      // The requested export filenames, in the order the GIFs come back.
      const names =
        toolName === "gif_creator"
          ? [coerced.filename]
          : (coerced.actions || [])
              .filter((a) => a && a.name === "gif_creator" && a.input && a.input.action === "export")
              .map((a) => a.input.filename);
      return saveGifBlocks(result, undefined, names);
    }
    return textResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return { ...textResult(`Error: ${err.message}`), isError: true };
  }
}

/**
 * Tear down the connection and pending requests. Idempotent.
 * The caller (process owner) handles process.exit().
 */
export function shutdown() {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  for (const [, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error("Server shutting down"));
  }
  pendingRequests.clear();
  if (socket && !socket.destroyed) {
    // end(), not destroy(): destroy could drop the session_end still buffered.
    if (linkIsUp()) {
      socket.write(JSON.stringify({ type: "session_end", session_id: SESSION_ID }) + "\n");
      socket.end();
    } else socket.destroy();
  }
  socket = null;
}
