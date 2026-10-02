// One hook-in for background.js: builds the handlers for the tools implemented
// in this directory and wraps computer/navigate so a running GIF recording
// captures a frame after each action. background.js calls
//   registerTools({ toolHandlers, isInGroup, takeScreenshot, screenshotStore, assertTabOwned, selfChecked, finish, inFlight })
// once, after toolHandlers is defined. Handlers are called as (args, sessionId).

import { runBatch, looksLikeError } from "./batch.js";
import { err } from "./result.js";
import { createGifTool, toBase64 } from "./gif.js";
import { renderGif, dropGifInPage } from "./gif-render.js";
import { createShortcuts } from "./shortcuts.js";

export function registerTools({ toolHandlers, isInGroup, takeScreenshot, screenshotStore, assertTabOwned, selfChecked, finish, inFlight }) {
  const gif = createGifTool({
    storage: chrome.storage.session,
    getTab: (id) => chrome.tabs.get(id),
    capture: async (tabId) => {
      const { base64, imageId } = await takeScreenshot(tabId);
      // A recorder frame must not push the agent's own screenshots out of the
      // 10-slot store (upload_image looks them up by id).
      screenshotStore.delete(imageId);
      return base64;
    },
    render: renderGif,
    download: async (bytes, filename) => {
      await chrome.downloads.download({ url: "data:image/gif;base64," + toBase64(bytes), filename, saveAs: false });
      return `Downloaded "${filename}" to the browser's download folder`;
    },
    drop: async (tabId, bytes, filename, [x, y]) => {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: dropGifInPage,
        args: [toBase64(bytes), filename, Math.round(x), Math.round(y)],
      });
      if (!res || !res[0] || !res[0].result) throw new Error("Failed to upload GIF to page");
      return res[0].result;
    },
  });

  const shortcuts = createShortcuts(chrome.storage.local);

  // Frame capture after each computer / navigate action, whichever way it was
  // invoked (directly or inside browser_batch).
  for (const name of ["computer", "navigate"]) {
    const orig = toolHandlers[name];
    toolHandlers[name] = async (args, sid) => {
      const result = await orig.call(toolHandlers, args, sid);
      if (args && typeof args.tabId === "number" && !looksLikeError(result)) {
        await gif.afterAction(args.tabId, name, args).catch(() => {});
      }
      return result;
    };
  }

  const guarded = (fn) => async (args, sid) => {
    if (args && typeof args.tabId === "number" && !(await isInGroup(args.tabId))) {
      return err(`Tab ${args.tabId} is not in the MCP group.`);
    }
    return fn(args, sid);
  };

  Object.assign(toolHandlers, {
    gif_creator: guarded((args) => gif.handler(args)),
    shortcuts_list: guarded(() => shortcuts.shortcuts_list()),
    shortcuts_execute: guarded((args) => shortcuts.shortcuts_execute(args)),
    shortcuts_save: (args) => shortcuts.shortcuts_save(args),
    browser_batch: (args, sid) => runBatch(args, { handlers: toolHandlers, sessionId: sid, assertTabOwned, selfChecked, finish, inFlight }),
  });
}
