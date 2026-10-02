// Finish lane: read_page viewport/truncation, get_page_text, form_input select,
// network failures, JS dialogs, upload_image coordinate drop, global isError.
// content.js is run for real inside a fake window/document.
import fs from "node:fs";
import path from "node:path";
import { createInFlight } from "../extension/tools/inflight.js";
import { createDialogLog, handleDialogOpening, maybeHandleDialog, withDialogNotes, shouldAccept, describeDialog } from "../extension/tools/dialogs.js";
import { failedRecord, formatNetworkLine, isCrossDomain } from "../extension/tools/network.js";
import { dropFileInPage, mimeFromBase64 } from "../extension/tools/upload.js";
import { createIndicator, paintIndicator, INDICATOR_ID } from "../extension/tools/indicator.js";
import { looksLikeError } from "../extension/tools/batch.js";
import { err } from "../extension/tools/result.js";
import { extractFunction, extractMethod, compile, ROOT } from "./_extract.mjs";

const realTimers = { setTimeout, clearTimeout };
let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// ---- fake DOM -------------------------------------------------------------
function el(tag, { attrs = {}, rect, children = [], text = "", ...props } = {}) {
  const e = {
    nodeType: 1, tagName: tag.toUpperCase(), children, shadowRoot: null, id: "", tabIndex: -1,
    onclick: null, contentEditable: "inherit", offsetParent: {}, innerText: text, textContent: text,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    getBoundingClientRect: () => rect || { top: 0, bottom: 10, left: 0, right: 10 },
    closest: () => null, scrollIntoView() {}, dispatchEvent() {}, ...props,
  };
  return e;
}
const VIEW = { top: 0, bottom: 20, left: 0, right: 50 };
const BELOW = { top: 5000, bottom: 5020, left: 0, right: 50 };
const body = el("body", { children: [] });
const doc = { body, title: "T", querySelectorAll: () => [], getElementById: () => null, querySelector: () => null };
globalThis.window = { innerWidth: 800, innerHeight: 600 };
globalThis.document = doc;
globalThis.location = { href: "http://x/" };
globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", position: "static" });
globalThis.CSS = { escape: (x) => x };
globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };
globalThis.HTMLTextAreaElement = class {}; globalThis.HTMLInputElement = class {};
new Function(fs.readFileSync(path.join(ROOT, "extension", "content.js"), "utf8"))();
const api = window.__unblockedChrome;

console.log("== read_page: interactive filter is viewport-only, all is not ==");
const inView = el("button", { text: "Here", rect: VIEW });
const offView = el("button", { text: "There", rect: BELOW });
body.children = [inView, offView];
const inter = api.generateAccessibilityTree({ filter: "interactive" });
ok(inter.includes('"Here"') && !inter.includes('"There"'), "interactive: off-viewport button omitted");
const all = api.generateAccessibilityTree({ filter: "all" });
ok(all.includes('"Here"') && all.includes('"There"'), "all: whole page");
const refId = /\[(ref_\d+)\]/.exec(api.generateAccessibilityTree({ filter: "all" }).split("\n").find((l) => l.includes("There")))[1];
ok(api.generateAccessibilityTree({ filter: "interactive", ref_id: refId }).includes('"There"'), "ref_id lifts the viewport restriction");

console.log("== read_page: truncation at a line boundary with the official note ==");
body.children = Array.from({ length: 30 }, (_, i) => el("button", { text: `Button number ${i}`, rect: VIEW }));
const full = api.generateAccessibilityTree({ filter: "all", max_chars: 1e9 });
const cut = api.generateAccessibilityTree({ filter: "all", max_chars: 200 });
const note = cut.slice(cut.lastIndexOf("\n[output truncated"));
ok(note.startsWith(`\n[output truncated at 200 of ${full.length} characters. Pass a larger max_chars (default 50000) to see more, or use ref_id or a smaller depth to focus.]`), "official note incl. full size");
const kept = cut.slice(0, cut.lastIndexOf("\n[output truncated"));
ok(kept.length <= 200 && full.startsWith(kept) && full[kept.length] === "\n", "cut falls on a line boundary");
ok(!api.generateAccessibilityTree({ filter: "all" }).includes("truncated"), "short output untouched");

console.log("== get_page_text: official format, largest match, max_chars ==");
const small = el("article", { text: "tiny article body here" });
const big = el("article", { text: "line one of the big article\n".repeat(20) });
doc.querySelectorAll = (sel) => (sel === "article" ? [small, big] : []);
let r = JSON.parse(api.getPageText({}));
ok(r.sourceTag === "article" && r.text.startsWith("line one") , "largest article chosen by innerText");
r = JSON.parse(api.getPageText({ max_chars: 100 }));
ok(/\n\n\[output truncated at 100 of \d+ characters\. Pass a larger max_chars \(default 50000\) to see more, or use read_page with a ref_id to focus on a smaller section\.\]$/.test(r.text), "truncation note");
ok(r.text.split("\n\n[output")[0].length <= 100, "text cut within max_chars");
doc.querySelectorAll = () => [];
body.innerText = "  ";
r = JSON.parse(api.getPageText({}));
ok(r.error === "No text content found. Page may contain only images, videos, or canvas-based content.", "error when no text");

console.log("== form_input select ==");
const opts = [{ value: "a", text: "Alpha", textContent: "Alpha" }, { value: "b", text: "Beta", textContent: "Beta" }];
const sel = el("select", { options: opts, value: "a", type: "select-one" });
body.children = [sel];
const selRef = /\[(ref_\d+)\]/.exec(api.generateAccessibilityTree({ filter: "all" }))[1];
let fr = api.setFormValue(selRef, "Gamma");
ok(fr.error === 'Option "Gamma" not found. Available options: "Alpha" (value: "a"), "Beta" (value: "b")', "missing option lists the valid ones");
fr = api.setFormValue(selRef, "Beta");
ok(fr.success && fr.message === 'Selected option "Beta" in dropdown (previous: "a")' && sel.value === "b", "select by text");
fr = api.setFormValue(selRef, "a");
ok(fr.success && sel.value === "a", "select by value");
const cb = el("input", { type: "checkbox", checked: false, click() { this.checked = !this.checked; } });
body.children = [cb];
const cbRef = /\[(ref_\d+)\]/.exec(api.generateAccessibilityTree({ filter: "all" }))[1];
ok(api.setFormValue(cbRef, "maybe").error === "Checkbox requires boolean value (true/false)", "checkbox rejects non-boolean");
ok(api.setFormValue(cbRef, true).checked === true, "checkbox boolean works");

console.log("== network: failed requests ==");
const rec = failedRecord({ requestId: "1", errorText: "net::ERR_NAME_NOT_RESOLVED" }, { url: "http://x/a", method: "POST", timestamp: 5 });
ok(rec.status === 503 && rec.failed && rec.url === "http://x/a" && rec.method === "POST", "keeps url/method, status 503");
ok(formatNetworkLine(rec) === "POST http://x/a → 503 (FAILED: net::ERR_NAME_NOT_RESOLVED)", "line shows the reason");
ok(failedRecord({ errorText: "x" }, null).url === "(unknown url)", "failure with no prior record does not crash");
ok(formatNetworkLine({ method: "GET", url: "u", status: 200, mimeType: "text/html" }) === "GET u → 200 [text/html]", "ok line unchanged");
ok(formatNetworkLine({ method: "GET", url: "u", status: 0 }) === "GET u (pending)", "pending line unchanged");

console.log("== dialogs ==");
ok(shouldAccept("alert") && !shouldAccept("confirm") && !shouldAccept("prompt") && !shouldAccept("beforeunload"), "policy");
const log = createDialogLog();
const sent = [];
await handleDialogOpening(7, { type: "beforeunload", message: "Leave?", url: "http://x/" }, { sendCommand: async (m, p) => sent.push([m, p]), log });
ok(sent[0][0] === "Page.handleJavaScriptDialog" && sent[0][1].accept === false, "beforeunload dismissed via CDP");
await handleDialogOpening(7, { type: "alert", message: "hi" }, { sendCommand: async (m, p) => sent.push([m, p]), log });
ok(sent[1][1].accept === true, "alert accepted");
await handleDialogOpening(7, { type: "confirm", message: "x" }, { sendCommand: async () => { throw new Error("gone"); }, log });
ok(log.drain(8).length === 0, "other tabs unaffected");
const notes = log.drain(7);
ok(notes.length === 3 && notes[0] === 'beforeunload "Leave?" on http://x/ was dismissed automatically', "notes recorded even if the CDP call fails");
ok(log.drain(7).length === 0, "drain clears");
const res = withDialogNotes({ content: [{ type: "text", text: "ok" }] }, ["a", "b"]);
ok(res.content.length === 2 && res.content[1].text === "[JS dialog handled: a; b]", "note appended to result");
ok(withDialogNotes({ content: [] }, []).content.length === 0 && withDialogNotes(null, ["a"]) === null, "no-ops");
ok(describeDialog({ type: "alert", message: "m" }, true) === 'alert "m" was accepted automatically', "describe");

console.log("== M1: only dialogs during an agent call (+2 s grace) are auto-answered ==");
{
  let clock = 1000;
  const inFlight = createInFlight({ now: () => clock });
  const dlog = createDialogLog();
  const cmds = [];
  const run = (tab, type = "beforeunload") => maybeHandleDialog(tab, { type, message: "Leave site?" }, { inFlight, sendCommand: async (m, p) => cmds.push([tab, m, p]), log: dlog });
  ok((await run(5)) === false && cmds.length === 0 && dlog.drain(5).length === 0, "no call in flight: the user's dialog is left alone (nothing sent, no note)");
  inFlight.begin(5);
  ok((await run(5)) === true && cmds.length === 1 && cmds[0][2].accept === false, "call in flight: dialog answered");
  ok((await run(6)) === false, "a call on tab 5 does not make tab 6's dialogs ours");
  inFlight.end(5);
  clock += 1500;
  ok((await run(5, "alert")) === true, "inside the grace window right after the call: still answered (late dialog from the action)");
  clock += 600;
  ok((await run(5, "confirm")) === false && cmds.length === 2, "after the grace window: left for the user again");
  inFlight.begin(5); inFlight.begin(5); inFlight.end(5);
  ok(inFlight.active(5), "two overlapping calls: still in flight after one ends");
  inFlight.forget(5);
  clock += 5000;
  ok(!inFlight.active(5), "forget() on tab close clears it");
}

console.log("== wiring in the shipped dispatcher (H3, M1) ==");
{
  const disp = extractFunction("handleToolRequest");
  ok(!/await\s+indicator\.touch/.test(disp) && /indicator\.touch\(args\.tabId\)/.test(disp), "H3: handleToolRequest does not await the indicator injection");
  ok(/inFlight\.begin\(args\.tabId\)/.test(disp) && /finally\s*\{[^}]*inFlight\.end\(args\.tabId\)/.test(disp), "M1: a tool call marks its tab in flight and always un-marks it");
  const bg = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
  ok(/maybeHandleDialog\(tabId, params, \{\s*inFlight,/.test(bg) && !/[^e]handleDialogOpening\(tabId/.test(bg), "M1: the debugger event path goes through maybeHandleDialog with inFlight");
  ok(/registerTools\(\{[^}]*finish: finishResult, inFlight/.test(bg), "L9: browser_batch gets the finish hook and inFlight");
}

console.log("== upload_image coordinate: drop in page ==");
ok(mimeFromBase64("/9j/4AAQ") === "image/jpeg" && mimeFromBase64("iVBORw0K") === "image/png" && mimeFromBase64("data:image/png;base64,xx") === "image/jpeg", "mime sniff");
const events = [];
globalThis.atob = (b) => Buffer.from(b, "base64").toString("binary");
globalThis.DataTransfer = class { constructor() { this.items = { add: (f) => (this.file = f) }; } };
globalThis.File = class { constructor(p, name, o) { this.name = name; this.type = o.type; this.size = p[0].length; } };
globalThis.DragEvent = class { constructor(type, o) { this.type = type; Object.assign(this, o); } };
let at = null;
document.elementFromPoint = (x, y) => (at = { x, y }, { tagName: "DIV", dispatchEvent: (e) => events.push(e) });
const dr = dropFileInPage(Buffer.from("hello").toString("base64"), "i.png", "image/png", 10, 20);
ok(dr.ok && dr.tag === "div" && at.x === 10 && at.y === 20, "targets the element at the point");
ok(events.map((e) => e.type).join() === "dragenter,dragover,drop" && events[2].dataTransfer.file.name === "i.png" && events[2].clientX === 10, "dragenter, dragover, drop with the file");
document.elementFromPoint = () => null;
ok(dropFileInPage("aGk=", "i.png", "image/png", 1, 2).ok === false, "no element at point is reported");

console.log("== upload_image validation (shipped handler) ==");
const upload = compile(
  `const h = { ${extractMethod("upload_image")} };`,
  { err, isInGroup: async () => true, screenshotStore: new Map([["s1", "/9j/AAAA"]]), mimeFromBase64, dropFileInPage,
    chrome: { scripting: { executeScript: async ({ args }) => [{ result: { ok: true, tag: "canvas", kb: 1, args } }] } } },
  "h"
).upload_image;
const txt = (x) => x.content[0].text;
ok(/imageId parameter is required/.test(txt(await upload({ tabId: 1 }))), "imageId required");
ok(/Either ref or coordinate parameter is required/.test(txt(await upload({ tabId: 1, imageId: "s1" }))), "ref or coordinate required");
ok(/not both/.test(txt(await upload({ tabId: 1, imageId: "s1", ref: "r", coordinate: [1, 2] }))), "not both");
ok(/not found/.test(txt(await upload({ tabId: 1, imageId: "zz", coordinate: [1, 2] }))), "unknown image id");
ok(/coordinate must be/.test(txt(await upload({ tabId: 1, imageId: "s1", coordinate: [1] }))), "bad coordinate");
ok(/Successfully dropped image.png \(1KB\) on <canvas> at \(3, 4\)/.test(txt(await upload({ tabId: 1, imageId: "s1", coordinate: [3, 4] }))), "coordinate drop reports target");

console.log("== global isError (shipped finishResult) ==");
const finishResult = compile(
  extractFunction("finishResult"),
  { looksLikeError, withDialogNotes, dialogLog: { drain: (t) => (t === 5 ? ["boom"] : []) } },
  "finishResult"
);
const t = (s) => ({ content: [{ type: "text", text: s }] });
ok(finishResult(t("Error: handling docs - MDN"), {}).isError === undefined && finishResult(t("Invalid email"), {}).isError === undefined, "M3: finishResult never infers an error from wording");
ok(finishResult(t("Network requests (1):\nGET u → 200"), {}).isError === undefined, "plain success untouched");
ok(finishResult({ ...t("[1/2 a] ok"), isError: true }, {}).isError === true, "existing isError kept (browser_batch failure)");
ok(finishResult(t("ok"), { tabId: 5 }).content[1].text === "[JS dialog handled: boom]", "dialog notes appended for the tab");
ok(finishResult(t("ok"), { tabId: 6 }).content.length === 1, "no notes for other tab");

console.log("== M3: handlers flag their own failures (isError), no text inference ==");
{
  const refused = async () => { throw new Error("Tab 5 belongs to another session's tab group. Pass steal:true to take it over."); };
  const h = compile(
    `const h = { ${extractMethod("tabs_attach_mcp")}, ${extractMethod("tabs_detach_mcp")} };`,
    { err, sessionTabs: { attach: refused, detach: refused, context: async () => ({ tabs: [], groupId: null }) }, formatTabContext: () => t("x") }, "h");
  const a = await h.tabs_attach_mcp({ tabId: 5 }, "s");
  ok(a.isError === true && /belongs to another session/.test(a.content[0].text), "tabs_attach_mcp refusal is isError (was invisible to batch stop-on-error)");
  ok((await h.tabs_detach_mcp({ tabId: 5 }, "s")).isError === true, "tabs_detach_mcp refusal is isError");
  // Regression net over EVERY handler: a failure-shaped text return must go through err().
  const src = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
  const bare = src.match(/return \{ content: \[\{ type: "text", text: [`"](Error\b|Failed\b|Could not\b|Unknown\b|Invalid\b|No element found\b|Tab \$\{[^}]*\} is not in the MCP group|[a-z_]+ (is|are) required|[a-z_]+ requires )[^\n]*/g) || [];
  ok(bare.length === 0, `no failure-shaped result in background.js bypasses err() (${bare.length} found${bare[0] ? ": " + bare[0].slice(0, 90) : ""})`);
}

console.log("== cross-domain navigation ==");
ok(isCrossDomain("https://a.com/x", "https://b.com/") && !isCrossDomain("https://a.com/x", "https://a.com/y"), "host compare");
ok(!isCrossDomain("about:blank", "https://a.com/") && !isCrossDomain("", "https://a.com/"), "no clear from a blank/unknown start");

console.log("== agent indicator ==");
const nodes = new Map();
const timers = [];
globalThis.setTimeout = (f, ms) => (timers.push([f, ms]), timers.length);
globalThis.clearTimeout = () => {};
document.getElementById = (id) => nodes.get(id) || null;
document.createElement = () => ({ style: {}, setAttribute() {}, animate() {}, remove() { nodes.delete(this.id); } });
document.documentElement = { appendChild: (e) => nodes.set(e.id, e) };
ok(paintIndicator(true, INDICATOR_ID, 4000) === true && nodes.has(INDICATOR_ID), "shows the overlay");
paintIndicator(true, INDICATOR_ID, 4000);
ok(nodes.size === 1 && timers.at(-1)[1] === 4000, "second call refreshes, no duplicate, self-removal timer set");
timers.at(-1)[0]();
ok(!nodes.has(INDICATOR_ID), "removes itself after the linger time");
paintIndicator(true, INDICATOR_ID, 4000);
paintIndicator(false, INDICATOR_ID, 4000);
ok(!nodes.has(INDICATOR_ID), "hide removes it");
const calls = [];
const ind = createIndicator(async (t, show) => { calls.push([t, show]); if (t === 99) throw new Error("chrome:// refuses"); });
const val = await ind.hidden(1, async () => { calls.push("shot"); return 42; });
ok(val === 42 && JSON.stringify(calls) === JSON.stringify([[1, false], "shot", [1, true]]), "hidden around a screenshot, shown after");
let threw = false;
try { await ind.touch(99); await ind.hidden(99, async () => 1); } catch { threw = true; }
ok(!threw, "injection failure never fails a tool");

console.log("== H3: a blocked tab (modal dialog / busy renderer) cannot hold the indicator hostage ==");
{
  globalThis.setTimeout = realTimers.setTimeout; globalThis.clearTimeout = realTimers.clearTimeout;
  const hung = createIndicator(() => new Promise(() => {}), { boundMs: 50 }); // executeScript that never settles
  const t0 = Date.now();
  await hung.touch(1);
  ok(Date.now() - t0 < 500, `touch returns after the bound even though the injection never settles (${Date.now() - t0} ms)`);
  const ran = [];
  const t1 = Date.now();
  const v = await hung.hidden(1, async () => (ran.push("shot"), 7));
  ok(v === 7 && ran.length === 1 && Date.now() - t1 < 1000, `hidden(): the wrapped screenshot still runs and returns (${Date.now() - t1} ms)`);
}

console.log("== navigate without tabId (shipped handler) ==");
const navCalls = [];
const mkNav = (tabs) => compile(
  `const h = { ${extractMethod("navigate")} };`,
  { err, sessionTabs: { createdTab: async (sid) => (navCalls.push([sid]), tabs[0] || {}) }, isInGroup: async (t) => t === 7,
    chrome: { tabs: { update: async () => {}, get: async () => ({ id: 7, url: "https://a.com/", status: "complete", groupId: 1 }), query: async () => [{ id: 7, url: "https://a.com/" }],
      onUpdated: { addListener: (f) => f(7, { status: "complete" }), removeListener() {} } } } },
  "h"
).navigate;
const navOk = await mkNav([{ id: 7 }])({ url: "a.com" }, "sess");
ok(navCalls[0][0] === "sess", "L5: asks the session for a tab IT CREATED (never tabs[0] of everything it owns)");
ok(/^Navigated to https:\/\/a\.com\//.test(txt(navOk)), "navigates that tab");
ok(/^Error: no tab available/.test(txt(await mkNav([])({ url: "a.com" }, "sess"))) && (await mkNav([])({ url: "a.com" }, "sess")).isError === true, "clear error (isError) when the session has no tab");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
