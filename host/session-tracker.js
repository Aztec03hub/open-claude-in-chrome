// Which MCP sessions (session_id) still have a connected client, so the
// extension can end the ones whose client vanished without saying goodbye
// (kill -9, WSL shut down) and keep the ones that are merely quiet.
//
// - a client's session_ids come from its client_hello and its tool_requests;
// - when a client's socket closes, each of its sessions gets a grace period
//   (a relay drop followed by a reconnect with the same id must not end the
//   session); if nobody re-claims it in time, session_end goes to the extension;
// - alive() is broadcast periodically so the extension's idle clock never
//   expires for a session that is still connected.

// L5: must stay at least two WSL reconnect-backoff ceilings (wsl-transport.js
// reconnectDelay max, 20 s), or a quiet client that is merely backing off gets
// its session ended while it is still running.
export const DEFAULT_GRACE_MS = 120_000;

export function createSessionTracker({ send, graceMs = DEFAULT_GRACE_MS } = {}) {
  const byClient = new Map(); // clientId -> Set<sid>
  const pending = new Map(); // sid -> timer

  const claimed = (sid) => [...byClient.values()].some((set) => set.has(sid));

  return {
    seen(clientId, sid) {
      // A client that never sends a session_id is the extension's "default" session.
      sid = sid || "default";
      let set = byClient.get(clientId);
      if (!set) byClient.set(clientId, (set = new Set()));
      set.add(sid);
      const t = pending.get(sid);
      if (t) { clearTimeout(t); pending.delete(sid); }
    },
    /** The client itself ended the session (session_end already forwarded). */
    ended(sid) {
      for (const set of byClient.values()) set.delete(sid);
      const t = pending.get(sid);
      if (t) { clearTimeout(t); pending.delete(sid); }
    },
    closed(clientId) {
      const set = byClient.get(clientId);
      byClient.delete(clientId);
      for (const sid of set || []) {
        if (claimed(sid) || pending.has(sid)) continue;
        const t = setTimeout(() => {
          pending.delete(sid);
          if (!claimed(sid)) send({ type: "session_end", session_id: sid });
        }, graceMs);
        t.unref?.();
        pending.set(sid, t);
      }
    },
    /** Sessions with a connected client, plus those inside their grace period. */
    alive() {
      return [...new Set([...byClient.values()].flatMap((s) => [...s]).concat([...pending.keys()]))];
    },
    stop() {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    }
  };
}
