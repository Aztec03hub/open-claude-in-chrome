// browser_batch runner, GIF assembly + recording state machine, shortcuts, and
// the registerTools hook-in against a fake chrome.*.
import { runBatch, validateBatch, looksLikeError } from "../extension/tools/batch.js";
import { encodeGif, planOverlays, frameDelay } from "../extension/tools/gif-encode.js";
import { createGifTool, describeAction, MAX_FRAMES } from "../extension/tools/gif.js";
import { createShortcuts } from "../extension/tools/shortcuts.js";
import { saveGifBlocks } from "../host/gif-save.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };
const T = (text) => ({ content: [{ type: "text", text }] });

console.log("== browser_batch: sequencing and stop-on-error ==");
{
  const log = [];
  const owned = [];
  const handlers = {
    computer: async (a) => { log.push(["computer", a]); return a.action === "screenshot" ? { content: [{ type: "text", text: "shot" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }] } : T("clicked"); },
    navigate: async (a) => { log.push(["navigate", a]); return T("Navigated"); },
    tabs_context_mcp: async (a) => { log.push(["ctx", a]); return T("ctx"); },
    boom: async () => { throw new Error("kaput"); },
    soft: async () => T("Tab 9 is not in the MCP group."),
    browser_batch: async () => T("never"),
  };
  const assertTabOwned = async (s, t) => { owned.push([s, t]); };
  let r = await runBatch({ actions: [
    { name: "navigate", input: { url: "https://a", tabId: 5 } },
    { name: "computer", input: { action: "screenshot", tabId: 5 } },
    { name: "computer", input: { action: "left_click", coordinate: [1, 2], tabId: 5 } },
  ] }, { handlers, sessionId: "s1", assertTabOwned });
  ok(!r.isError && log.length === 3, "all actions run in order");
  ok(r.content.map((c) => c.type).join() === "text,text,image,text", "outputs interleaved in order, images kept");
  ok(/^\[1\/3 navigate\] Navigated/.test(r.content[0].text) && /^\[2\/3 computer:screenshot\] shot/.test(r.content[1].text), "each output is labelled with its index and action");
  ok(owned.length === 3 && owned.every(([s, t]) => s === "s1" && t === 5), "ownership hook called once per action with (sessionId, tabId)");

  log.length = 0; owned.length = 0;
  r = await runBatch({ actions: [
    { name: "tabs_context_mcp", input: { tabId: 99, createIfEmpty: true } },
    { name: "navigate", input: { url: "u", tabId: 5 } },
  ] }, { handlers, sessionId: "s", assertTabOwned });
  ok(log[0][1].tabId === undefined && log[0][1].createIfEmpty === true, "tabs_context_mcp: tabId stripped, other args kept");
  ok(owned.length === 1 && owned[0][1] === 5, "tabs_context_mcp is not ownership-checked");

  log.length = 0;
  r = await runBatch({ actions: [
    { name: "navigate", input: { url: "u", tabId: 5 } },
    { name: "boom", input: { tabId: 5 } },
    { name: "navigate", input: { url: "never", tabId: 5 } },
  ] }, { handlers, assertTabOwned });
  ok(r.isError && /actions\[1\] \(boom\) failed: kaput \(1 completed, 1 remaining\)/.test(r.content.at(-1).text), "thrown error: stops, says 1 completed / 1 remaining");
  ok(log.length === 1, "later actions did not run");
  ok(r.content.length === 2 && /Navigated/.test(r.content[0].text), "outputs of completed actions are still returned");

  r = await runBatch({ actions: [{ name: "navigate", input: { url: "u", tabId: 5 } }, { name: "soft", input: { tabId: 5 } }, { name: "navigate", input: { url: "x", tabId: 5 } }] }, { handlers, assertTabOwned });
  ok(r.isError && /actions\[1\] \(soft\) failed: Tab 9 is not in the MCP group\. \(1 completed, 1 remaining\)/.test(r.content.at(-1).text), "text-shaped failure (handlers return errors as text) also stops the batch");

  const denied = async (s, t) => { if (t === 7) throw new Error("Tab 7 is not in Claude's tab group for this session"); };
  log.length = 0;
  r = await runBatch({ actions: [{ name: "navigate", input: { url: "u", tabId: 5 } }, { name: "navigate", input: { url: "u", tabId: 7 } }] }, { handlers, assertTabOwned: denied });
  ok(r.isError && /not in Claude's tab group/.test(r.content.at(-1).text) && log.length === 1, "ownership failure stops before running that action");

  // Sub-handlers run in the batch's own session, and self-checked tools
  // (tabs_attach_mcp targets a tab the session does not own yet) skip the gate.
  const seen = [];
  const sh = {
    tabs_context_mcp: async (a, sid) => { seen.push(["ctx", sid]); return T("ctx"); },
    tabs_attach_mcp: async (a, sid) => { seen.push(["attach", sid, a.tabId]); return T("attached"); },
  };
  owned.length = 0;
  r = await runBatch({ actions: [
    { name: "tabs_context_mcp", input: {} },
    { name: "tabs_attach_mcp", input: { tabId: 42 } },
  ] }, { handlers: sh, sessionId: "sess-A", assertTabOwned, selfChecked: new Set(["tabs_attach_mcp"]) });
  ok(!r.isError && seen.every((s) => s[1] === "sess-A"), "every sub-handler receives the batch's sessionId");
  ok(owned.length === 0, "self-checked tools are not ownership-gated (attach target is not owned yet)");
}

console.log("== browser_batch: validation ==");
{
  const h = { navigate: async () => T("ok"), browser_batch: async () => T("x") };
  ok(/non-empty array/.test(validateBatch({ actions: [] }, h)) && /non-empty array/.test(validateBatch({}, h)), "empty/missing actions");
  ok(/cannot be nested/.test(validateBatch({ actions: [{ name: "browser_batch", input: {} }] }, h)), "no nesting");
  ok(/unknown tool/.test(validateBatch({ actions: [{ name: "zzz", input: {} }] }, h)), "unknown tool");
  ok(/input must be an object/.test(validateBatch({ actions: [{ name: "navigate" }] }, h)), "missing input");
  ok(/name must be a string/.test(validateBatch({ actions: [{ input: {} }] }, h)), "missing name");
  const r = await runBatch({ actions: [{ name: "navigate", input: { tabId: 1 } }, { name: "browser_batch", input: {} }] }, { handlers: h });
  ok(r.isError && /cannot be nested/.test(r.content[0].text), "invalid batch runs nothing and is an error");
  ok(looksLikeError({ isError: true, content: [] }) && looksLikeError(T("Error: x")) && looksLikeError(T("Could not resolve ref")) && !looksLikeError(T("Clicked at (1,2)")) && !looksLikeError(T("Navigated to https://x")), "looksLikeError heuristics");
}

console.log("== GIF assembly (synthetic frames) ==");
{
  const mk = (w, h, rgb, delay) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set([...rgb, 255], i * 4);
    return { data: d, width: w, height: h, delay };
  };
  const bytes = encodeGif([mk(8, 6, [255, 0, 0], 300), mk(8, 6, [0, 255, 0], 1500), mk(8, 6, [0, 0, 255], 800)]);
  ok(Buffer.from(bytes.subarray(0, 6)).toString() === "GIF89a", "GIF89a header");
  ok(bytes[6] === 8 && bytes[7] === 0 && bytes[8] === 6 && bytes[9] === 0, "logical screen 8x6");
  ok(bytes.at(-1) === 0x3b, "trailer byte");
  let gce = 0, imgs = 0;
  const delays = [];
  for (let i = 0; i < bytes.length - 7; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 4) { gce++; delays.push((bytes[i + 4] | (bytes[i + 5] << 8)) * 10); }
    if (bytes[i] === 0x2c && bytes[i + 5] === 8 && bytes[i + 7] === 6) imgs++;
  }
  ok(gce === 3 && imgs === 3, "three frames, each with a graphic control extension");
  ok(delays.join() === "300,1500,800", `per-frame delays preserved (${delays})`);
  ok(Buffer.from(bytes).includes(Buffer.from("NETSCAPE2.0")), "loop extension present (animated, loops forever)");
  let threw = false; try { encodeGif([]); } catch { threw = true; }
  ok(threw, "no frames -> error");
  threw = false; try { encodeGif([mk(4, 4, [0, 0, 0]), mk(5, 4, [0, 0, 0])]); } catch { threw = true; }
  ok(threw, "mismatched frame sizes -> error");
  ok(frameDelay({ type: "left_click" }) === 1500 && frameDelay({ type: "wait" }) === 300 && frameDelay(null) === 800, "frame delays by action type");
  const ops = planOverlays({ action: { type: "left_click", coordinate: [100, 50], description: "Clicked" } }, 1, 4, {}, 0.5);
  ok(ops.some((o) => o.op === "circle" && o.x === 50 && o.y === 25) && ops.some((o) => o.op === "label") && ops.find((o) => o.op === "bar").frac === 0.5 && ops.some((o) => o.op === "watermark"), "click overlay: scaled circle, label, progress 2/4, watermark");
  const off = planOverlays({ action: { type: "left_click", coordinate: [1, 1], description: "Clicked" } }, 0, 1, { showClickIndicators: false, showActionLabels: false, showProgressBar: false, showWatermark: false });
  ok(off.length === 0, "all overlays can be switched off");
  const drag = planOverlays({ action: { type: "left_click_drag", start: [1, 2], coordinate: [30, 40] } }, 0, 1);
  ok(drag.some((o) => o.op === "arrow" && o.x2 === 30) && !drag.some((o) => o.op === "circle"), "drag draws an arrow, not a click circle");
}

console.log("== gif_creator state machine ==");
{
  const store = {};
  const storage = {
    get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.filter((x) => x in store).map((x) => [x, store[x]])) : k in store ? { [k]: store[k] } : {}),
    set: async (o) => Object.assign(store, o),
    remove: async (ks) => ks.forEach((k) => delete store[k]),
  };
  const tabs = { 1: { id: 1, groupId: 10 }, 2: { id: 2, groupId: 10 }, 3: { id: 3, groupId: 11 } };
  let shots = 0;
  const downloads = [], drops = [];
  const mkTool = () => createGifTool({
    storage, getTab: async (id) => tabs[id], capture: async () => `frame${++shots}`,
    render: async (frames, o) => ({ bytes: new Uint8Array([71, 73, 70, frames.length]), width: 8, height: 6, o }),
    download: async (b, f) => { downloads.push(f); return `Downloaded "${f}"`; },
    drop: async (t, b, f, c) => { drops.push([t, f, c]); return `Successfully dropped ${f}`; },
  });
  const g = mkTool();
  const txt = (r) => r.content[0].text;
  ok(/No frames/.test(txt(await g.handler({ action: "export", tabId: 1, download: true }))), "export with nothing recorded -> error");
  await g.afterAction(1, "computer", { action: "left_click", coordinate: [1, 1] });
  ok(g._state.frames.size === 0, "actions are ignored while not recording");
  ok(/Started recording/.test(txt(await g.handler({ action: "start_recording", tabId: 1 }))), "start_recording");
  ok(g._state.frames.get("g10").length === 1, "start captures the initial state as frame 1");
  ok(/already active/.test(txt(await g.handler({ action: "start_recording", tabId: 2 }))), "recording is scoped to the tab group (tab 2 shares tab 1's group)");
  await g.afterAction(2, "computer", { action: "left_click", coordinate: [5, 6] });
  await g.afterAction(1, "navigate", { url: "https://x" });
  await g.afterAction(3, "computer", { action: "left_click", coordinate: [5, 6] });
  const frames = g._state.frames.get("g10");
  ok(frames.length === 3 && !g._state.frames.has("g11"), "frames captured per action on the recorded group only");
  ok(frames[1].action.type === "left_click" && frames[1].action.coordinate[0] === 5 && frames[2].action.description === "Navigated to https://x", "frames carry the action for overlays");
  ok(/Captured 4 frames/.test(txt(await g.handler({ action: "stop_recording", tabId: 1 }))), "stop_recording takes a final frame and reports the count");
  await g.afterAction(1, "computer", { action: "left_click" });
  ok(g._state.frames.get("g10").length === 4, "no capture after stop");
  // survive a service-worker restart: a fresh instance hydrates from storage
  const g2 = mkTool();
  let r = await g2.handler({ action: "export", tabId: 1, download: true, filename: "out.gif" });
  ok(/Successfully exported GIF with 4 frames/.test(txt(r)) && /Downloaded "out.gif"/.test(txt(r)) && downloads[0] === "out.gif", "export after a worker restart still has the frames; download path used");
  ok(/Recording cleared/.test(txt(r)) && /No frames/.test(txt(await g2.handler({ action: "export", tabId: 1, download: true }))), "export clears the recording");
  ok(!Object.keys(store).some((k) => k.startsWith("ocic_gif_f_")), "stored frames are removed on clear");

  await g2.handler({ action: "start_recording", tabId: 1 });
  r = await g2.handler({ action: "export", tabId: 1 });
  const img = r.content.find((c) => c.type === "image");
  ok(img && img.mimeType === "image/gif" && Buffer.from(img.data, "base64")[3] === 1, "export without download/coordinate returns the GIF bytes (MCP server saves them)");
  await g2.handler({ action: "start_recording", tabId: 1 });
  r = await g2.handler({ action: "export", tabId: 1, coordinate: [10, 20], filename: "d.gif" });
  ok(drops.length === 1 && drops[0][0] === 1 && drops[0][2][0] === 10 && /dropped d\.gif/.test(txt(r)), "export with coordinate drops onto the page");
  await g2.handler({ action: "start_recording", tabId: 1 });
  ok(/Cleared 1 frame/.test(txt(await g2.handler({ action: "clear", tabId: 1 }))) && /No frames to clear/.test(txt(await g2.handler({ action: "clear", tabId: 1 }))), "clear");
  ok(/Unknown action/.test(txt(await g2.handler({ action: "zzz", tabId: 1 }))), "unknown action");
  await g2.handler({ action: "start_recording", tabId: 1 });
  for (let i = 0; i < 70; i++) await g2.afterAction(1, "computer", { action: "wait" });
  ok(g2._state.frames.get("g10").length === MAX_FRAMES, `capped at ${MAX_FRAMES} frames`);
  ok(describeAction("computer", { action: "type", text: "hi" }).description === 'Typed: "hi"' && describeAction("navigate", { url: "u" }).type === "navigate" && describeAction("read_page", {}) === null, "describeAction");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gifsave-"));
  const saved = saveGifBlocks({ content: [{ type: "text", text: "ok" }, { type: "image", mimeType: "image/gif", data: Buffer.from("GIF89a").toString("base64") }] }, dir);
  const file = saved.content[1].text.replace("GIF saved to ", "");
  ok(saved.content[1].type === "text" && fs.readFileSync(file, "latin1") === "GIF89a" && file.startsWith(dir), "MCP side writes the GIF to disk and returns its path");
  const plain = { content: [{ type: "image", mimeType: "image/jpeg", data: "AA" }] };
  ok(saveGifBlocks(plain, dir) === plain, "non-gif results untouched");
}

console.log("== shortcuts ==");
{
  const store = {};
  const s = createShortcuts({ get: async (k) => (k in store ? { [k]: store[k] } : {}), set: async (o) => Object.assign(store, o) });
  const j = (r) => JSON.parse(r.content[0].text);
  ok(j(await s.shortcuts_list()).shortcuts.length === 0, "empty list");
  const saved = await s.shortcuts_save({ command: "/summarize", prompt: "Summarize this page. Focus: $ARGS", description: "sum" });
  ok(/Saved shortcut "summarize"/.test(saved.content[0].text), "save strips leading slash");
  const list = j(await s.shortcuts_list()).shortcuts;
  ok(list.length === 1 && list[0].command === "summarize" && list[0].description === "sum" && list[0].isWorkflow === false && list[0].id, "list returns id/command/description/isWorkflow");
  let r = await s.shortcuts_execute({ command: "summarize", arguments: "prices" });
  ok(/Focus: prices/.test(r.content[0].text) && /no side panel/.test(r.content[0].text), "execute by command expands $ARGS and says how it differs");
  r = await s.shortcuts_execute({ shortcutId: list[0].id });
  ok(/Focus: *\n?$/.test(r.content[0].text) && !r.content[0].text.includes("$ARGS"), "execute by id; $ARGS blanked when no arguments");
  r = await s.shortcuts_execute({ command: "/nope" });
  ok(r.isError && /Shortcut not found/.test(r.content[0].text), "unknown shortcut");
  ok((await s.shortcuts_execute({})).isError, "needs shortcutId or command");
  await s.shortcuts_save({ command: "summarize", prompt: "v2" });
  ok(j(await s.shortcuts_list()).shortcuts.length === 1 && (await s.shortcuts_execute({ command: "summarize" })).content[0].text.endsWith("v2"), "same command updates in place");
  ok(/Deleted/.test((await s.shortcuts_save({ command: "summarize" })).content[0].text) && j(await s.shortcuts_list()).shortcuts.length === 0, "delete");
  ok((await s.shortcuts_save({ command: "x" })).isError, "deleting a missing shortcut is an error");
}

console.log("== registerTools hook-in (fake chrome) ==");
{
  const calls = [];
  const sess = {};
  globalThis.chrome = {
    storage: { session: { get: async () => ({}), set: async (o) => Object.assign(sess, o), remove: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
    tabs: { get: async (id) => ({ id, groupId: 5 }) },
    downloads: { download: async (o) => { calls.push(o); return 1; } },
    scripting: { executeScript: async () => [] },
  };
  const { registerTools } = await import("../extension/tools/register.js");
  const store = new Map([["a", "x"]]);
  const toolHandlers = {
    computer: async (a) => T(`did ${a.action}`),
    navigate: async (a) => T(`nav ${a.url}`),
    isInGroupProbe: async () => T("n/a"),
  };
  registerTools({
    toolHandlers, isInGroup: async (id) => id !== 99,
    takeScreenshot: async () => ({ base64: "QQ==", imageId: "img1" }), screenshotStore: { delete: (k) => store.delete(k) },
    assertTabOwned: async (sid, id) => { if (id === 99) throw new Error(`Tab ${id} is not in this session's tab group.`); },
    selfChecked: new Set(["tabs_attach_mcp"]),
  });
  for (const n of ["gif_creator", "shortcuts_list", "shortcuts_execute", "shortcuts_save", "browser_batch"]) ok(typeof toolHandlers[n] === "function", `${n} registered`);
  let r = await toolHandlers.gif_creator({ action: "start_recording", tabId: 1 });
  ok(/Started recording/.test(r.content[0].text), "gif_creator start via the registered handler");
  r = await toolHandlers.browser_batch({ actions: [{ name: "navigate", input: { url: "https://a", tabId: 1 } }, { name: "computer", input: { action: "left_click", tabId: 1 } }] }, { sessionId: "h1" });
  ok(!r.isError && r.content.length === 2, "browser_batch through the real handler table");
  r = await toolHandlers.gif_creator({ action: "stop_recording", tabId: 1 });
  ok(/Captured 4 frames/.test(r.content[0].text), "navigate + click inside the batch each added a frame (1 start + 2 actions + 1 stop)");
  r = await toolHandlers.gif_creator({ action: "clear", tabId: 99 });
  ok(/not in the MCP group/.test(r.content[0].text), "gif_creator group-guarded");
}

console.log(fail === 0 ? "\nALL TOOLS BATCH/GIF/SHORTCUTS TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
