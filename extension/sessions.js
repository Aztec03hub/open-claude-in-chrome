// Per-session tab ownership. One Chrome tab group per MCP session (keyed by the
// session_id the host stamps on every tool request; absent = "default").
//
// Pure logic over an injected `chrome` object so it can be unit-tested with a
// fake. Nothing here touches module-level state or the real chrome.* global.
//
// Model: a session owns a set of groupIds (one per window it works in, because
// a Chrome tab group lives in exactly one window and we never move a user's tab
// between windows). A tab is owned by a session iff its live groupId is one of
// the session's groupIds. Separately we remember, per tab, whether the session
// CREATED it (may close on session end) or ATTACHED it (only ever ungroup).

export const DEFAULT_SESSION = "default";
export const STORAGE_KEY = "ocic_sessions_v1";
export const IDLE_MS = 30 * 60 * 1000;
const COLORS = ["blue", "orange", "green", "purple", "pink", "cyan", "yellow", "red", "grey"];

export const sidOf = (raw) => (raw === undefined || raw === null || raw === "" ? DEFAULT_SESSION : String(raw));
const titleFor = (index) => (index === 1 ? "Claude" : `Claude ${index}`);
const colorFor = (index) => COLORS[(index - 1) % COLORS.length];

export function createSessions(chrome, { now = Date.now, onRelease = async () => {} } = {}) {
  // sid -> { index, groupIds: number[], created: Set<tabId>, attached: Set<tabId>, lastSeen }
  const sessions = new Map();
  const locks = new Map();
  let loaded = null;

  // Mutating operations on one session run one at a time, so two concurrent
  // tabs_create_mcp calls cannot both decide "no group yet" and make two.
  function serial(sid, fn) {
    const run = (locks.get(sid) || Promise.resolve()).then(fn, fn);
    locks.set(sid, run.catch(() => {}));
    return run;
  }

  async function persist() {
    const out = {};
    for (const [sid, s] of sessions) {
      out[sid] = { index: s.index, groupIds: s.groupIds, created: [...s.created], attached: [...s.attached], lastSeen: s.lastSeen };
    }
    try { await chrome.storage.session.set({ [STORAGE_KEY]: out }); } catch {}
  }

  function get(sid, create = true) {
    let s = sessions.get(sid);
    if (!s && create) {
      const used = new Set([...sessions.values()].map((x) => x.index));
      let index = 1;
      while (used.has(index)) index++;
      s = { index, groupIds: [], created: new Set(), attached: new Set(), lastSeen: now() };
      sessions.set(sid, s);
    }
    return s;
  }

  // Live groups of a session: drops (and forgets) groups that no longer exist
  // or have no tabs left. Returns [{ groupId, windowId, tabs }].
  async function liveGroups(sid) {
    const s = get(sid, false);
    if (!s) return [];
    const live = [];
    for (const gid of s.groupIds) {
      try {
        const g = await chrome.tabGroups.get(gid);
        const tabs = await chrome.tabs.query({ groupId: gid });
        if (tabs.length) live.push({ groupId: gid, windowId: g.windowId, tabs });
      } catch {}
    }
    if (live.length !== s.groupIds.length) {
      s.groupIds = live.map((g) => g.groupId);
      await persist();
    }
    return live;
  }

  // Startup / service-worker-restart recovery: reload the persisted map, then
  // reconcile it against the live browser.
  function load() {
    if (!loaded) {
      loaded = (async () => {
        let saved = {};
        try { saved = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY] || {}; } catch {}
        for (const [sid, r] of Object.entries(saved)) {
          sessions.set(sid, {
            index: r.index, groupIds: r.groupIds || [], created: new Set(r.created || []),
            attached: new Set(r.attached || []), lastSeen: r.lastSeen || now()
          });
        }
        for (const [sid, s] of [...sessions]) {
          const live = await liveGroups(sid);
          const ids = new Set(live.flatMap((g) => g.tabs.map((t) => t.id)));
          s.created = new Set([...s.created].filter((t) => ids.has(t)));
          s.attached = new Set([...s.attached].filter((t) => ids.has(t)));
          if (!live.length) sessions.delete(sid);
        }
        await persist();
      })();
    }
    return loaded;
  }

  const touch = (sid) => { const s = get(sid); s.lastSeen = now(); };

  async function ownedTabs(sid) {
    await load();
    return (await liveGroups(sid)).flatMap((g) => g.tabs);
  }

  const validIds = async (sid) => (await ownedTabs(sid)).map((t) => t.id);

  // The single ownership gate. Resolves to the live tab, or throws the
  // official-style error naming the valid ids.
  async function assertTabOwned(sid, tabId) {
    await load();
    const id = typeof tabId === "string" && tabId.trim() !== "" ? Number(tabId) : tabId;
    const owned = await ownedTabs(sid);
    const hit = owned.find((t) => t.id === id);
    if (hit) return hit;
    const valid = owned.map((t) => t.id);
    throw new Error(
      `Tab ${tabId} is not in this session's tab group. Valid tab IDs are: ${valid.length ? valid.join(", ") : "(none)"}.` +
      (valid.length ? "" : " Use tabs_context_mcp {createIfEmpty:true} to create a tab or tabs_attach_mcp to take over an existing one.")
    );
  }

  async function newGroup(sid, tabId) {
    const s = get(sid);
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    try { await chrome.tabGroups.update(groupId, { title: titleFor(s.index), color: colorFor(s.index) }); } catch {}
    s.groupIds.push(groupId);
    return groupId;
  }

  // Create a tab the session owns. First tab of a session gets its own window
  // (not focused); later tabs go in the session's most recent group's window,
  // never selected.
  function createTab(sid) {
    return serial(sid, async () => {
      await load();
      touch(sid);
      const s = get(sid);
      const groups = await liveGroups(sid);
      let tab, groupId;
      if (!groups.length) {
        const win = await chrome.windows.create({ focused: false, url: "about:blank" });
        tab = win.tabs[0];
        groupId = await newGroup(sid, tab.id);
      } else {
        const g = groups[groups.length - 1];
        tab = await chrome.tabs.create({ active: false, windowId: g.windowId });
        groupId = await chrome.tabs.group({ tabIds: [tab.id], groupId: g.groupId });
      }
      s.created.add(tab.id);
      await persist();
      return { tab, groupId };
    });
  }

  // tabs_context_mcp: list owned tabs; only create when nothing is owned.
  async function context(sid, createIfEmpty) {
    await load();
    touch(sid);
    let groups = await liveGroups(sid);
    if (!groups.length && createIfEmpty) {
      await createTab(sid);
      groups = await liveGroups(sid);
    }
    return { tabs: groups.flatMap((g) => g.tabs), groupId: groups.length ? groups[0].groupId : null };
  }

  // Who owns this live groupId, if anyone.
  function ownerOfGroup(groupId) {
    if (groupId === undefined || groupId < 0) return null;
    for (const [sid, s] of sessions) if (s.groupIds.includes(groupId)) return sid;
    return null;
  }

  async function resolveAttachTarget({ tabId, match }) {
    if (tabId !== undefined && tabId !== null) {
      try { return await chrome.tabs.get(Number(tabId)); }
      catch { throw new Error(`Tab ${tabId} does not exist. Use tabs_list_all to see open tabs.`); }
    }
    const needle = String(match ?? "").toLowerCase();
    if (!needle) throw new Error("Provide tabId or match (a substring of the tab's url or title).");
    const all = await chrome.tabs.query({});
    const hits = all.filter((t) => (t.url || "").toLowerCase().includes(needle) || (t.title || "").toLowerCase().includes(needle));
    if (hits.length === 0) throw new Error(`No open tab matches "${match}". Use tabs_list_all to see open tabs.`);
    if (hits.length === 1) return hits[0];
    const active = hits.filter((t) => t.active);
    if (active.length === 1) return active[0];
    const list = hits.map((t) => `${t.id}: "${t.title || ""}" (${t.url || ""})`).join("; ");
    throw new Error(`"${match}" matches ${hits.length} tabs, none uniquely active. Pass tabId. Candidates: ${list}`);
  }

  // Put an EXISTING tab under this session. No new tab, no new window, no
  // reload; the tab stays in its own window (a group per window).
  function attach(sid, { tabId, match, steal } = {}) {
    return serial(sid, async () => {
      await load();
      touch(sid);
      const tab = await resolveAttachTarget({ tabId, match });
      const s = get(sid);
      const owner = ownerOfGroup(tab.groupId);
      if (owner === sid) return { tab, groupId: tab.groupId, already: true };
      if (owner && !steal) {
        throw new Error(`Tab ${tab.id} belongs to another session's tab group. Pass steal:true to take it over.`);
      }
      const mine = (await liveGroups(sid)).find((g) => g.windowId === tab.windowId);
      let groupId;
      if (mine) groupId = await chrome.tabs.group({ tabIds: [tab.id], groupId: mine.groupId });
      else groupId = await newGroup(sid, tab.id);
      if (owner) {
        const o = sessions.get(owner);
        o.created.delete(tab.id);
        o.attached.delete(tab.id);
      }
      s.attached.add(tab.id);
      s.created.delete(tab.id);
      await persist();
      return { tab, groupId, stolenFrom: owner };
    });
  }

  // Release a tab: ungroup, never close.
  function detach(sid, tabId) {
    return serial(sid, async () => {
      const tab = await assertTabOwned(sid, tabId);
      await chrome.tabs.ungroup(tab.id);
      const s = get(sid);
      s.created.delete(tab.id);
      s.attached.delete(tab.id);
      await onRelease(tab.id);
      await liveGroups(sid);
      await persist();
      return tab;
    });
  }

  // tabs_close_mcp: close owned tabs only. Returns { closed, skipped }.
  function close(sid, ids) {
    return serial(sid, async () => {
      const owned = new Set(await validIds(sid));
      const closed = [], skipped = [];
      for (const raw of ids) {
        const id = typeof raw === "string" ? Number(raw) : raw;
        (owned.has(id) ? closed : skipped).push(id);
      }
      for (const id of closed) await onRelease(id);
      if (closed.length) await chrome.tabs.remove(closed);
      const s = get(sid);
      for (const id of closed) { s.created.delete(id); s.attached.delete(id); }
      await liveGroups(sid);
      await persist();
      return { closed, skipped };
    });
  }

  // Every open tab with the session (if any) that owns it.
  async function listAll(sid) {
    await load();
    const all = await chrome.tabs.query({});
    for (const s of sessions.keys()) await liveGroups(s);
    return all.map((t) => {
      const owner = ownerOfGroup(t.groupId);
      return {
        tabId: t.id, windowId: t.windowId, title: t.title || "", url: t.url || "", active: !!t.active,
        session: owner, mine: owner === sid
      };
    });
  }

  // Session over: close what it created, only ungroup what it attached.
  function endSession(sid) {
    return serial(sid, async () => {
      await load();
      const s = get(sid, false);
      if (!s) return { closed: [], ungrouped: [] };
      const owned = new Set(await validIds(sid));
      const closed = [], ungrouped = [];
      for (const id of s.created) if (owned.has(id)) closed.push(id);
      for (const id of s.attached) if (owned.has(id)) ungrouped.push(id);
      for (const id of [...closed, ...ungrouped]) await onRelease(id);
      for (const id of ungrouped) { try { await chrome.tabs.ungroup(id); } catch {} }
      if (closed.length) { try { await chrome.tabs.remove(closed); } catch {} }
      sessions.delete(sid);
      await persist();
      return { closed, ungrouped };
    });
  }

  // Backstop for a session whose client vanished without session_end.
  async function sweepIdle(hostConnected, idleMs = IDLE_MS) {
    if (hostConnected) return [];
    await load();
    const ended = [];
    for (const [sid, s] of [...sessions]) {
      if (now() - s.lastSeen >= idleMs) { await endSession(sid); ended.push(sid); }
    }
    return ended;
  }

  // chrome.tabs.onRemoved: forget the tab; groups prune lazily via liveGroups.
  async function onTabRemoved(tabId) {
    await load();
    let dirty = false;
    for (const s of sessions.values()) {
      dirty = s.created.delete(tabId) || s.attached.delete(tabId) || dirty;
    }
    if (dirty) await persist();
  }

  // Any session's tab? (set_tab_focus etc. already passed the session gate.)
  async function isManaged(tabId) {
    await load();
    try { return ownerOfGroup((await chrome.tabs.get(tabId)).groupId) !== null; } catch { return false; }
  }

  async function allManagedTabIds() {
    await load();
    const out = [];
    for (const sid of sessions.keys()) out.push(...(await validIds(sid)));
    return out;
  }

  return {
    sessions, load, touch, ownedTabs, assertTabOwned, createTab, context, attach, detach, close,
    listAll, endSession, sweepIdle, onTabRemoved, isManaged, allManagedTabIds
  };
}
