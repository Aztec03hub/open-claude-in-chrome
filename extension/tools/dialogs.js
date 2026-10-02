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
  return {
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
    },
  };
}

/** Handle one Page.javascriptDialogOpening event. sendCommand(method, params) -> Promise. */
export async function handleDialogOpening(tabId, params, { sendCommand, log }) {
  const accept = shouldAccept(params && params.type);
  log.record(tabId, describeDialog(params, accept));
  try {
    await sendCommand("Page.handleJavaScriptDialog", { accept });
  } catch {
    // dialog already gone (page navigated / user answered it): nothing to do
  }
  return accept;
}

/** Append pending dialog notes to a tool result (no-op when there are none). */
export function withDialogNotes(result, notes) {
  if (!notes || notes.length === 0 || !result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: [...result.content, { type: "text", text: `[JS dialog handled: ${notes.join("; ")}]` }],
  };
}
