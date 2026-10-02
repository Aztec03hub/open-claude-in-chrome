// Key table, output scrubbing, javascript_tool wrapping, console exceptions,
// secret-field redaction (shipped content.js function), file upload validation.
import { buildKeyEvents, parseKeyCombo, resolveKey, MOD } from "../extension/tools/keys.js";
import { scrubValue } from "../extension/tools/scrub.js";
import { runJavascript, wrapRepl, wrapIife, formatEvalResult, clampTimeout, MAX_OUTPUT } from "../extension/tools/js-exec.js";
import { formatExceptionEntry } from "../extension/tools/console.js";
import { validateFiles, setFilesInPage } from "../extension/tools/upload.js";
import { extractFunction, ROOT } from "./_extract.mjs";
import path from "node:path";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

console.log("== keys: Enter is keyCode 13 with text \\r (was 69, no text) ==");
const enter = buildKeyEvents("Enter");
ok(enter.down.windowsVirtualKeyCode === 13 && enter.down.code === "Enter" && enter.down.key === "Enter", "Enter -> 13/Enter/Enter");
ok(enter.down.text === "\r" && enter.down.type === "keyDown", "Enter keyDown carries text \\r (submits forms)");
ok(enter.up.type === "keyUp" && enter.up.windowsVirtualKeyCode === 13, "keyUp has the same keyCode");
ok(buildKeyEvents("return").down.windowsVirtualKeyCode === 13, "alias return");
const tab = buildKeyEvents("Tab");
ok(tab.down.windowsVirtualKeyCode === 9 && tab.down.type === "rawKeyDown" && tab.down.text === undefined, "Tab: 9, rawKeyDown, no text");
ok(buildKeyEvents("space").down.text === " " && resolveKey(" ").code === "Space", "Space");
ok(buildKeyEvents("Escape").down.windowsVirtualKeyCode === 27 && buildKeyEvents("esc").down.key === "Escape", "Escape");
ok(buildKeyEvents("ArrowDown").down.windowsVirtualKeyCode === 40, "ArrowDown 40");
ok(buildKeyEvents("F5").down.windowsVirtualKeyCode === 116 && buildKeyEvents("f12").down.windowsVirtualKeyCode === 123, "F5 / F12");
ok(buildKeyEvents("1").down.code === "Digit1" && buildKeyEvents("1").down.windowsVirtualKeyCode === 49, "digit 1 -> Digit1/49 (was Key1)");
ok(buildKeyEvents("a").down.code === "KeyA" && buildKeyEvents("a").down.windowsVirtualKeyCode === 65 && buildKeyEvents("a").down.text === "a", "a -> KeyA/65/'a'");
ok(buildKeyEvents("!").down.code === "Digit1" && buildKeyEvents("?").down.code === "Slash", "shifted symbols map to their physical key");

console.log("== keys: modifier combos ==");
const ca = buildKeyEvents("ctrl+a");
ok(ca.down.modifiers === MOD.ctrl && ca.down.windowsVirtualKeyCode === 65, "ctrl+a: modifiers=2, keyCode 65");
ok(ca.down.text === undefined && ca.down.type === "rawKeyDown", "ctrl+a must not type an 'a'");
const cs = buildKeyEvents("ctrl+shift+Tab");
ok(cs.down.modifiers === (MOD.ctrl | MOD.shift), "ctrl+shift+Tab modifiers=10");
const meta = buildKeyEvents("cmd+a");
ok(meta.down.modifiers === MOD.meta && JSON.stringify(meta.down.commands) === '["selectAll"]', "cmd+a carries the selectAll editing command");
ok(JSON.stringify(buildKeyEvents("cmd+shift+z").down.commands) === '["redo"]', "cmd+shift+z -> redo");
ok(buildKeyEvents("ctrl+a").down.commands === undefined, "no editing commands without meta");
ok(buildKeyEvents("shift+a").down.key === "A" && buildKeyEvents("shift+a").down.text === "A", "shift+a produces 'A'");
ok(buildKeyEvents("alt+ArrowLeft").down.modifiers === MOD.alt, "alt+ArrowLeft");
ok(buildKeyEvents("ctrl++").down.key === "+", "ctrl++ is ctrl and the plus key");
ok(buildKeyEvents("Control+Enter").down.modifiers === MOD.ctrl, "Control alias");
ok(buildKeyEvents("nonsensekey") === null && parseKeyCombo("") === null, "unknown key -> null (caller reports it)");
ok(resolveKey("Enter") !== resolveKey("Enter"), "resolveKey returns fresh copies (mutation-safe)");

console.log("== scrub ==");
ok(scrubValue("a=1; b=2") === "[BLOCKED: Cookie/query string data]", "cookie string");
ok(scrubValue("x=1&y=2") === "[BLOCKED: Cookie/query string data]", "query string");
ok(scrubValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk") === "[BLOCKED: JWT token]" && scrubValue("aaa.bbb.ccc") === "aaa.bbb.ccc", "JWT (real shape only)");
const sc = scrubValue({ user: "bob", password: "hunter2", nested: { apiToken: "t", Authorization: "Bearer x", session_id: "s", cookie: "c", ok: 1 }, author: "keep" });
ok(sc.user === "bob" && sc.password === "[BLOCKED: Sensitive key]", "password key blocked, others kept");
ok(sc.nested.apiToken === "[BLOCKED: Sensitive key]" && sc.nested.Authorization === "[BLOCKED: Sensitive key]" && sc.nested.session_id === "[BLOCKED: Sensitive key]" && sc.nested.cookie === "[BLOCKED: Sensitive key]", "token/authorization/session/cookie keys blocked (nested, case-insensitive)");
ok(sc.nested.ok === 1 && sc.author === "keep", "'author' is not mistaken for 'auth'");
ok(scrubValue("hello world") === "hello world" && scrubValue(42) === 42 && scrubValue(null) === null, "plain values untouched");
ok(scrubValue(Array.from({ length: 150 }, (_, i) => i)).length === 101, "arrays capped at 100 items + note");
ok(scrubValue("x".repeat(1500)).endsWith("[TRUNCATED]"), "long strings truncated");
let deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
ok(JSON.stringify(scrubValue(deep)).includes("Max depth"), "depth limited");

console.log("== javascript_tool: wrapping + retry ==");
ok(wrapRepl("await x") === "{await x\n}", "repl wrapper is a block (top-level await)");
ok(wrapIife("return 1").startsWith("(async()=>{"), "IIFE wrapper is async");
const calls = [];
const illegal = { exceptionDetails: { exception: { className: "SyntaxError", description: "SyntaxError: Illegal return statement" } } };
let r = await runJavascript({
  code: "return 5",
  evaluate: async (expr, repl, t) => { calls.push({ expr, repl, t }); return calls.length === 1 ? illegal : { result: { type: "number", value: 5 } }; }
});
ok(calls.length === 2 && calls[0].repl === true && calls[1].repl === false, "Illegal return -> retried once as async IIFE without replMode");
ok(calls[1].expr === wrapIife("return 5") && r.text === "5" && !r.isError, "retry result returned");
calls.length = 0;
r = await runJavascript({ code: "await 1", evaluate: async (e, rp, t) => { calls.push(t); return { result: { type: "number", value: 1 } }; } });
ok(calls.length === 1 && calls[0] === 30000 && r.text === "1", "default timeout 30 s, single evaluate");
r = await runJavascript({ code: "1", timeoutMs: 5000, evaluate: async (e, rp, t) => { calls.push(t); return { result: { type: "number", value: 1 } }; } });
ok(calls[calls.length - 1] === 5000, "timeout is configurable");
ok(clampTimeout(999999) === 55000 && clampTimeout(-1) === 30000 && clampTimeout("x") === 30000 && clampTimeout(10) === 100, "timeout clamped");
r = await runJavascript({ code: "while(1);", timeoutMs: 1000, evaluate: async () => ({ exceptionDetails: { exception: { description: "Error: Execution was terminated" } } }) });
ok(r.isError && /Execution timeout: Code exceeded 1-second limit/.test(r.text), "terminated script reports a timeout");
r = await runJavascript({ code: "x", evaluate: async () => ({ exceptionDetails: { exception: { className: "ReferenceError", description: "ReferenceError: x is not defined" } } }) });
ok(r.isError && /ReferenceError: x is not defined/.test(r.text), "runtime errors surfaced, no retry on non-return errors");
ok(formatEvalResult({ result: { type: "undefined" } }).text === "undefined", "undefined");
ok(formatEvalResult({ result: { type: "object", subtype: "null" } }).text === "null", "null");
ok(formatEvalResult({ result: { type: "object", value: { token: "abc", n: 1 } } }).text.includes("[BLOCKED: Sensitive key]"), "object results are scrubbed");
ok(formatEvalResult({ result: { type: "string", value: "sid=1; theme=dark" } }).text === "[BLOCKED: Cookie/query string data]", "document.cookie-shaped output is blocked");
ok(formatEvalResult({ result: { type: "object", subtype: "node", description: "div#a" } }).text === "div#a", "DOM node by description");
const big = formatEvalResult({ result: { type: "string", value: "y".repeat(1200) } });
ok(big.text.length === 1000 + "[TRUNCATED]".length, "single string capped at 1000 chars by scrub");
ok(formatEvalResult({ result: { type: "object", value: Object.fromEntries(Array.from({ length: 99 }, (_, i) => ["k" + i, "v".repeat(900)])) } }).text.length <= MAX_OUTPUT + 60, "overall output capped near 50KB");

console.log("== M4: scrubbing blocks secrets, not ordinary values ==");
const fe = (value) => formatEvalResult({ result: { type: "string", value } }).text;
ok(fe("www.example.com") === "www.example.com" && fe("1.2.3") === "1.2.3" && fe("example.co.uk") === "example.co.uk", "hostnames / versions are not JWTs");
ok(fe("https://x.test/p?a=1&b=2;c=3") === "https://x.test/p?a=1&b=2;c=3", "a URL with a query string passes");
ok(fe('<div class="a" style="color:red;top:0">x</div>') === '<div class="a" style="color:red;top:0">x</div>', "HTML with = and ; passes");
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
ok(fe(jwt) === "[BLOCKED: JWT token]", "a real JWT is still blocked");
ok(fe("sid=abc123") === "[BLOCKED: Cookie/query string data]" && fe("a=1; b=2") === "[BLOCKED: Cookie/query string data]", "document.cookie with ONE cookie is blocked (was leaked)");
const thrown = formatEvalResult({ exceptionDetails: { exception: { className: "Error", description: "Error: sid=abc123\n    at <anonymous>:1:7" } } });
ok(thrown.isError && !thrown.text.includes("abc123") && /Error: .*BLOCKED: Cookie/.test(thrown.text) && /at <anonymous>/.test(thrown.text), "throw new Error(document.cookie) does not leak the cookie; stack kept");
ok(formatEvalResult({ exceptionDetails: { exception: { description: `Error: ${jwt}` } } }).text.includes("BLOCKED: JWT"), "JWT in an exception message is blocked");
ok(formatEvalResult({ exceptionDetails: { exception: { className: "TypeError", description: "TypeError: Cannot read properties of null (reading 'x')\n    at f" } } }).text === "Error: TypeError: Cannot read properties of null (reading 'x')\n    at f", "ordinary exception text unchanged");

console.log("== console: uncaught exceptions ==");
const ex = formatExceptionEntry({ exceptionDetails: { text: "Uncaught", url: "https://x/a.js", exception: { description: "TypeError: boom\n    at f (https://x/a.js:3:9)" } } }, 7);
ok(ex.level === "exception" && ex.timestamp === 7 && ex.text.startsWith("TypeError: boom") && ex.url === "https://x/a.js", "exception entry level/text/url");
const ex2 = formatExceptionEntry({ exceptionDetails: { text: "Uncaught", exception: { type: "string", value: "thrown string" }, stackTrace: { callFrames: [{ functionName: "g", url: "u.js", lineNumber: 0, columnNumber: 4 }] } } });
ok(/thrown string/.test(ex2.text) && /at g \(u\.js:1:5\)/.test(ex2.text), "primitive throw gets a stack from callFrames");
const ex3 = formatExceptionEntry({ exceptionDetails: { text: "Uncaught (in promise)", exception: { description: "Error: nope" } } });
ok(/^Unhandled promise rejection: Error: nope/.test(ex3.text), "unhandled rejection is labelled");
ok(["error", "exception"].includes(ex.level), "level is one onlyErrors keeps");

console.log("== read_page secret redaction (shipped content.js function) ==");
const src = extractFunction("isSensitiveInput", path.join(ROOT, "extension", "content.js"));
const isSensitive = new Function(src + "; return isSensitiveInput;")();
const el = (tag, type, ac) => ({ tagName: tag.toUpperCase(), type, getAttribute: (n) => (n === "autocomplete" ? ac ?? null : null) });
ok(isSensitive(el("input", "password")), "password input");
ok(isSensitive(el("input", "text", "current-password")) && isSensitive(el("input", "text", "new-password")), "autocomplete current/new-password");
ok(isSensitive(el("input", "text", "cc-number")) && isSensitive(el("input", "text", "cc-exp")) && isSensitive(el("input", "tel", "off cc-csc")), "cc-* autocomplete");
ok(isSensitive(el("input", "text", "one-time-code")), "one-time-code");
ok(!isSensitive(el("input", "text", "email")) && !isSensitive(el("input", "text")) && !isSensitive(el("div", "")), "ordinary fields not redacted");

console.log("== file_upload files validation ==");
ok(validateFiles([]).error && validateFiles(undefined).error, "empty / missing files rejected");
ok(validateFiles([{ name: "a.txt" }]).error, "missing base64 rejected");
const vf = validateFiles([{ name: "../x/a.txt", base64: "aGk=" }]);
ok(vf.files[0].name === ".._x_a.txt" && vf.files[0].mimeType === "application/octet-stream", "name sanitised, default mime");
// setFilesInPage against a fake DOM
const added = [];
globalThis.document = { querySelector: () => fakeInput };
globalThis.HTMLInputElement = class {};
globalThis.DataTransfer = class { constructor() { this.items = { add: (f) => added.push(f) }; } get files() { return { length: added.length }; } };
globalThis.File = class { constructor(parts, name, o) { this.parts = parts; this.name = name; this.type = o.type; } };
const events = [];
const fakeInput = Object.assign(new HTMLInputElement(), { type: "file", multiple: false, dispatchEvent: (e) => events.push(e.type) });
globalThis.Event = class { constructor(t) { this.type = t; } };
let res = setFilesInPage("[x]", [{ name: "a.txt", mimeType: "text/plain", base64: "aGk=" }]);
ok(res.ok && res.count === 1 && added[0].name === "a.txt" && added[0].type === "text/plain" && Buffer.from(added[0].parts[0]).toString() === "hi", "bytes decoded into a File with name and type");
ok(events.join() === "input,change", "input then change events fired");
res = setFilesInPage("[x]", [{ name: "a", mimeType: "", base64: "" }, { name: "b", mimeType: "", base64: "" }]);
ok(!res.ok && /multiple/.test(res.error), "multiple files into a single-file input refused");

console.log(fail === 0 ? "\nALL TOOLS KEYS/SCRUB TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
