// gif_creator: per-tab-group frame recording and export. Everything that touches
// the browser (tabs, screenshots, canvas, downloads, page drops) is injected, so
// the state machine is testable. See gif-render.js for the browser-side wiring.
//
// Differences from the official tool, on purpose:
//  - start_recording / stop_recording capture a frame themselves (the official
//    tool asks the agent to take a screenshot instead).
//  - A click contributes one frame (after the click, with the indicator drawn on
//    it); the official one adds a before-click copy too.
//  - export with neither `download` nor `coordinate` returns the GIF to the MCP
//    server, which saves it to a file on ITS machine and reports the path.

export const MAX_FRAMES = 50;
const META_KEY = "ocic_gif_meta_v1";
const frameKey = (group, n) => `ocic_gif_f_${group}_${n}`;

/** What happened, for the overlay label / indicator. */
export function describeAction(tool, args) {
  if (tool === "navigate") return { type: "navigate", description: `Navigated to ${args.url}` };
  if (tool !== "computer") return null;
  const t = args.action;
  const a = { type: t };
  if (Array.isArray(args.coordinate)) a.coordinate = args.coordinate;
  if (Array.isArray(args.start_coordinate)) a.start = args.start_coordinate;
  if (/click/.test(t) && t !== "left_click_drag") a.description = "Clicked";
  else if (t === "type") a.description = `Typed: "${String(args.text ?? "").slice(0, 40)}"`;
  else if (t === "key") a.description = `Pressed key: ${args.text}`;
  else if (t === "scroll" || t === "scroll_to") a.description = "Scrolled";
  else if (t === "left_click_drag") a.description = "Dragged";
  else if (t === "screenshot" || t === "wait") return { type: t };
  else a.description = t;
  return a;
}

export function createGifTool({ storage, getTab, capture, render, download, drop, now = Date.now }) {
  const frames = new Map(); // groupKey -> [{ base64, action, ts }]
  const recording = new Set();
  let hydrated = null;

  const groupKeyOf = (tab) => (tab.groupId >= 0 ? `g${tab.groupId}` : `t${tab.id}`);

  const persistMeta = () =>
    storage.set({ [META_KEY]: { recording: [...recording], counts: Object.fromEntries([...frames].map(([k, v]) => [k, v.length])) } });

  // The service worker can be evicted mid-recording; frames live in storage.session.
  function hydrate() {
    hydrated ||= (async () => {
      try {
        const { [META_KEY]: meta } = await storage.get(META_KEY);
        if (!meta) return;
        for (const k of meta.recording || []) recording.add(k);
        for (const [k, n] of Object.entries(meta.counts || {})) {
          const keys = Array.from({ length: n }, (_, i) => frameKey(k, i));
          const got = await storage.get(keys);
          frames.set(k, keys.map((fk) => got[fk]).filter(Boolean));
        }
      } catch {}
    })();
    return hydrated;
  }

  async function addFrame(key, base64, action) {
    const list = frames.get(key) || [];
    if (list.length >= MAX_FRAMES) return false;
    const f = { base64, action: action || null, ts: now() };
    list.push(f);
    frames.set(key, list);
    // Persisting is best-effort: storage.session is capped (~10 MB), 50 JPEG
    // frames can exceed it. The in-memory copy is what export uses; storage only
    // lets a recording survive service-worker eviction.
    try {
      await storage.set({ [frameKey(key, list.length - 1)]: f });
      await persistMeta();
    } catch {}
    return true;
  }

  async function dropGroup(key) {
    const n = (frames.get(key) || []).length;
    frames.delete(key);
    recording.delete(key);
    await storage.remove(Array.from({ length: n }, (_, i) => frameKey(key, i))).catch(() => {});
    await persistMeta();
  }

  async function grab(tabId, key, action) {
    try {
      await addFrame(key, await capture(tabId), action);
      return true;
    } catch {
      return false;
    }
  }

  /** Call after a successful computer/navigate action. No-op unless recording. */
  async function afterAction(tabId, tool, args) {
    await hydrate();
    let tab;
    try { tab = await getTab(tabId); } catch { return; }
    const key = groupKeyOf(tab);
    if (!recording.has(key)) return;
    await grab(tabId, key, describeAction(tool, args));
  }

  async function handler(args) {
    const text = (output) => ({ content: [{ type: "text", text: output }] });
    const err = (m) => ({ content: [{ type: "text", text: `Failed to execute gif_creator: ${m}` }], isError: true });
    if (!args || !args.action) return err("action parameter is required");
    await hydrate();
    const tab = await getTab(args.tabId);
    const key = groupKeyOf(tab);

    switch (args.action) {
      case "start_recording": {
        if (recording.has(key)) return text("Recording is already active for this tab group. Use 'stop_recording' to stop or 'export' to generate GIF.");
        await dropGroup(key);
        recording.add(key);
        await persistMeta();
        await grab(args.tabId, key, { type: "screenshot" });
        return text(`Started recording browser actions for this tab group. All computer and navigate tool actions will now be captured (max ${MAX_FRAMES} frames). The current page was captured as the first frame. Previous frames cleared.`);
      }
      case "stop_recording": {
        if (!recording.has(key)) return text("Recording is not active for this tab group. Use 'start_recording' to begin capturing.");
        await grab(args.tabId, key, { type: "screenshot" });
        recording.delete(key);
        await persistMeta();
        const n = (frames.get(key) || []).length;
        return text(`Stopped recording for this tab group. Captured ${n} frame${n === 1 ? "" : "s"} (the final page state is the last frame). Use 'export' to generate GIF or 'clear' to discard.`);
      }
      case "clear": {
        const n = (frames.get(key) || []).length;
        if (n === 0 && !recording.has(key)) return text("No frames to clear for this tab group.");
        await dropGroup(key);
        return text(`Cleared ${n} frame${n === 1 ? "" : "s"} for this tab group. Recording stopped.`);
      }
      case "export": {
        const list = frames.get(key) || [];
        if (list.length === 0) return err("No frames recorded for this tab group. Use 'start_recording' and perform browser actions first.");
        const out = await render(list, args.options || {});
        const filename = args.filename || `recording-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.gif`;
        const kb = Math.round(out.bytes.length / 1024);
        const dims = `Dimensions: ${out.width}x${out.height}.`;
        let msg;
        let content;
        if (args.download === true) {
          msg = `Successfully exported GIF with ${list.length} frames. ${await download(out.bytes, filename)} (${kb}KB). ${dims}`;
        } else if (Array.isArray(args.coordinate) && args.coordinate.length === 2) {
          msg = `Successfully exported GIF with ${list.length} frames. ${await drop(args.tabId, out.bytes, filename, args.coordinate)}. ${dims}`;
        } else {
          msg = `Successfully exported GIF with ${list.length} frames (${kb}KB). ${dims} Filename: ${filename}`;
          content = { type: "image", mimeType: "image/gif", data: toBase64(out.bytes) };
        }
        await dropGroup(key);
        return { content: [{ type: "text", text: `${msg} Recording cleared.` }, ...(content ? [content] : [])] };
      }
      default:
        return err(`Unknown action: ${args.action}. Must be one of: start_recording, stop_recording, export, clear`);
    }
  }

  return { handler, afterAction, _state: { frames, recording } };
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
