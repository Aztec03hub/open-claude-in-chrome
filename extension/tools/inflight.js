// Which tabs have a tool call in flight right now (plus a short grace window
// after it ends). The debugger stays attached between calls, so without this the
// dialog auto-handler would also answer dialogs the USER triggers in a tab the
// session merely attached (a "Leave site?" on closing it, a confirm() on a
// delete button). Only dialogs that open during an agent action are ours to answer.

export const DIALOG_GRACE_MS = 2000;

export function createInFlight({ now = Date.now, graceMs = DIALOG_GRACE_MS } = {}) {
  const counts = new Map(); // tabId -> running calls
  const graceUntil = new Map(); // tabId -> ms timestamp
  return {
    begin(tabId) {
      if (typeof tabId !== "number") return;
      counts.set(tabId, (counts.get(tabId) || 0) + 1);
    },
    end(tabId) {
      if (typeof tabId !== "number") return;
      const n = (counts.get(tabId) || 0) - 1;
      if (n > 0) counts.set(tabId, n);
      else counts.delete(tabId);
      graceUntil.set(tabId, now() + graceMs);
    },
    active(tabId) {
      return (counts.get(tabId) || 0) > 0 || now() < (graceUntil.get(tabId) || 0);
    },
    forget(tabId) {
      counts.delete(tabId);
      graceUntil.delete(tabId);
    },
  };
}
