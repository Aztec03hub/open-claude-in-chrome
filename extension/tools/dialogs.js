// JS dialogs (alert / confirm / prompt / beforeunload) block the page's renderer
// until answered, which would wedge every CDP command after them. On
// Page.javascriptDialogOpening we answer immediately and remember what we did,
// so the next tool result for that tab can say so (the agent never sees a
// dialog otherwise).
//
// Policy: alert is accepted (nothing to decide); confirm, prompt and
// beforeunload are dismissed, which is the official extension's default for
// beforeunload (stay on the page) and the non-destructive answer for the rest.

const MAX_NOTES = 20;

export function shouldAccept(type) {
  return type === "alert";
}

export function describeDialog(params, accept) {
  const type = (params && params.type) || "dialog";
  const msg = String((params && params.message) || "").slice(0, 200);
  const url = params && params.url ? ` on ${params.url}` : "";
  return `${type}${msg ? ` "${msg}"` : ""}${url} was ${accept ? "accepted" : "dismissed"} automatically`;
}

export function createDialogLog() {
  const byTab = new Map();
  // Dialogs that opened while no agent call was driving the tab: left for the
  // user, but remembered, because a later agent call on that tab would block
  // behind it until it timed out.
  const pending = new Map(); // tabId -> Page.javascriptDialogOpening params
  return {
    setPending(tabId, params) {
      pending.set(tabId, params);
    },
    takePending(tabId) {
      const p = pending.get(tabId);
      pending.delete(tabId);
      return p;
    },
    clearPending(tabId) {
      pending.delete(tabId);
    },
    record(tabId, note) {
      const list = byTab.get(tabId) || [];
      list.push(note);
      if (list.length > MAX_NOTES) list.splice(0, list.length - MAX_NOTES);
      byTab.set(tabId, list);
    },
    /** Returns and clears the pending notes for a tab. */
    drain(tabId) {
      const list = byTab.get(tabId) || [];
      byTab.delete(tabId);
      return list;
    },
    forget(tabId) {
      byTab.delete(tabId);
      pending.delete(tabId);
    },
  };
}

/** Handle one Page.javascriptDialogOpening event. sendCommand(method, params) -> Promise. */
export async function handleDialogOpening(tabId, params, { sendCommand, log }) {
  const accept = shouldAccept(params && params.type);
  const note = describeDialog(params, accept);
  try {
    await sendCommand("Page.handleJavaScriptDialog", { accept });
    log.record(tabId, note);
  } catch {
    // Dialog already gone (page navigated / user answered it / debugger detached):
    // do not claim it was handled.
    log.record(tabId, `${note.replace(/ was (accepted|dismissed) automatically$/, "")} could not be answered automatically (it may already be closed)`);
  }
  return accept;
}

/**
 * Page.javascriptDialogOpening policy: answer the dialog only while a tool call
 * for this tab is in flight (or just ended, see inflight.js). Otherwise it is
 * the user's dialog in the user's tab and is left for them. Returns whether we handled it.
 */
export async function maybeHandleDialog(tabId, params, { inFlight, sendCommand, log }) {
  if (!inFlight.active(tabId)) {
    log.setPending(tabId, params);
    return false;
  }
  await handleDialogOpening(tabId, params, { sendCommand, log });
  return true;
}

/**
 * An agent call is starting on this tab. A dialog the page opened while nobody
 * was driving it is still up and would block every CDP command of the call, so
 * the agent is now the one driving: answer it with the usual policy and report it.
 * (Page.javascriptDialogClosed clears it first when the user answered it.)
 */
export async function answerPendingDialog(tabId, { sendCommand, log }) {
  const params = log.takePending(tabId);
  if (!params) return false;
  await handleDialogOpening(tabId, params, { sendCommand, log });
  return true;
}

/** Append pending dialog notes to a tool result (no-op when there are none). */
export function withDialogNotes(result, notes) {
  if (!notes || notes.length === 0 || !result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: [...result.content, { type: "text", text: `[JS dialog handled: ${notes.join("; ")}]` }],
  };
}
