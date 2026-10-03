// javascript_tool evaluation: top-level await, `return`, a hard timeout and
// scrubbed output, built on one injected `evaluate(expression, replMode, timeoutMs)`
// so it is testable without a browser.
//
//  - First try: `{ <code> }` with replMode, so top-level `await` works and the
//    completion value of the last statement is the result.
//  - If that is a SyntaxError "Illegal return statement" (the code used `return`),
//    retry as the body of an async IIFE so `return x` works.
//  - Runtime.evaluate's own `timeout` terminates runaway scripts (a plain
//    Promise.race would return while the script kept running).

import { scrubValue, scrubMessage } from "./scrub.js";

export const DEFAULT_TIMEOUT_MS = 30000;
export const MAX_TIMEOUT_MS = 55000; // the MCP request itself dies at 60 s
export const MAX_OUTPUT = 51200;

export function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), 100), MAX_TIMEOUT_MS);
}

export const wrapRepl = (code) => `{${code}\n}`;
export const wrapIife = (code) => `(async()=>{\n${code}\n})()`;

function isIllegalReturn(exceptionDetails) {
  const ex = exceptionDetails && exceptionDetails.exception;
  if (!ex || ex.className !== "SyntaxError") return false;
  return /Illegal return statement/.test(ex.description || "");
}

/** Turn a CDP Runtime.evaluate result into { text, isError }. */
export function formatEvalResult(res, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails.exception;
    const desc = (ex && (ex.description || ex.value)) || res.exceptionDetails.text || "Unknown error";
    const msg = /execution (was )?terminated/i.test(String(desc))
      ? `Execution timeout: Code exceeded ${timeoutMs / 1000}-second limit`
      : scrubMessage(desc);
    return { text: `Error: ${msg}`, isError: true };
  }
  const r = res.result;
  let out;
  if (!r || r.type === "undefined") out = "undefined";
  else if (r.type === "object" && r.subtype === "null") out = "null";
  else if (r.type === "function") out = r.description || "[Function]";
  else if (r.type === "object" && r.subtype === "node") out = r.description || "[DOM Node]";
  else if (r.value !== undefined) {
    const v = scrubValue(r.value);
    out = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } else out = r.description || String(r.value);
  if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + "\n[OUTPUT TRUNCATED: Exceeded 50KB limit]";
  return { text: out, isError: false };
}

/**
 * Run `code`; returns { text, isError }. `evaluate` must call Runtime.evaluate
 * with returnByValue and awaitPromise and resolve to the raw CDP result.
 */
export async function runJavascript({ code, timeoutMs, evaluate }) {
  const t = clampTimeout(timeoutMs);
  // Runtime.evaluate's `timeout` only bounds synchronous execution: time spent
  // awaiting a promise does not count (live 2026-10-02: timeout:2 waited out a
  // 5 s await). So the whole call also races a wall-clock deadline. A pending
  // promise left behind is harmless; a busy loop is still killed by CDP's timeout.
  const deadline = Date.now() + t;
  const timedOut = { text: `Error: Execution timeout: Code exceeded ${t / 1000}-second limit`, isError: true };
  const within = async (p) => {
    let timer;
    const left = Math.max(0, deadline - Date.now());
    try {
      return await Promise.race([p, new Promise((r) => { timer = setTimeout(() => r(null), left); })]);
    } finally {
      clearTimeout(timer);
    }
  };
  let res = await within(evaluate(wrapRepl(code), true, t));
  if (res === null) return timedOut;
  if (isIllegalReturn(res.exceptionDetails)) {
    res = await within(evaluate(wrapIife(code), false, Math.max(100, deadline - Date.now())));
    if (res === null) return timedOut;
  }
  return formatEvalResult(res, t);
}
