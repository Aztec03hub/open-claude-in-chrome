// Output scrubbing for javascript_tool, modelled on the official extension's
// result sanitiser: cookie/query strings, JWTs and values under sensitive keys
// never reach the model.
//
// Deliberately NOT ported: the official also blocks any 20+ char base64-looking
// string and any 32+ char hex string. That hides ordinary ids and hashes from a
// tool whose job is to read page state; add it back if leaks of that shape matter.

const SENSITIVE_KEY =
  /password|passwd|token|secret|api[_-]?key|authorization|auth(?!or)|credential|private[_-]?key|access[_-]?key|bearer|oauth|session|cookie/i;

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_DEPTH = 5;
const MAX_ITEMS = 100;
const MAX_STRING = 1000;

/** Recursively redact a JSON-able value. */
export function scrubValue(v, depth = 0) {
  if (depth > MAX_DEPTH) return "[TRUNCATED: Max depth exceeded]";
  if (typeof v === "string") {
    if (v.includes("=") && (v.includes(";") || v.includes("&"))) return "[BLOCKED: Cookie/query string data]";
    if (JWT.test(v)) return "[BLOCKED: JWT token]";
    if (v.length > MAX_STRING) return v.slice(0, MAX_STRING) + "[TRUNCATED]";
    return v;
  }
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ITEMS).map((x) => scrubValue(x, depth + 1));
    if (v.length > MAX_ITEMS) out.push(`[TRUNCATED: ${v.length - MAX_ITEMS} more items]`);
    return out;
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[BLOCKED: Sensitive key]" : scrubValue(x, depth + 1);
    }
    return out;
  }
  return v;
}
