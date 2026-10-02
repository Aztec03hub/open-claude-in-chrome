// Session tab model (extension/sessions.js) against a fake chrome.* object.
import { createSessions, sidOf } from "../extension/sessions.js";
let fail = 0; const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

function fakeChrome(tabs0 = []) {
  const st = { tabs: tabs0.map((t) => ({ groupId: -1, active: false, ...t })), groups: {}, nextTab: 500, nextGroup: 900, nextWin: 50, store: {}, calls: [], focusedWindow: 1 };
  const rec = (n, a) => st.calls.push({ n, a });
  const chrome = {
    tabs: {
      update: async (id, o) => { rec("tabs.update", { id, ...o }); const t = st.tabs.find((x) => x.id === id); Object.assign(t, o); return { ...t }; },
      get: async (id) => { const t = st.tabs.find((x) => x.id === id); if (!t) throw new Error("no tab"); return { ...t }; },
      query: async (q) => st.tabs.filter((t) => (q.groupId === undefined || t.groupId === q.groupId)).map((t) => ({ ...t })),
      create: async (o) => { rec("tabs.create", o); const t = { id: st.nextTab++, windowId: o.windowId ?? 1, active: !!o.active, groupId: -1 }; st.tabs.push(t); return { ...t }; },
      // Chrome semantics: a NEW group goes in createProperties.windowId, else the
      // focused ("current") window, and the tab is moved there. Grouping unpins.
      group: async (o) => {
        rec("tabs.group", o);
        const t = st.tabs.find((x) => x.id === o.tabIds[0]);
        const gid = o.groupId ?? st.nextGroup++;
        if (o.groupId === undefined) st.groups[gid] = { id: gid, windowId: o.createProperties?.windowId ?? st.focusedWindow };
        t.windowId = st.groups[gid].windowId; t.pinned = false;
        t.groupId = gid; return gid;
      },
      ungroup: async (id) => { rec("tabs.ungroup", id); const t = st.tabs.find((x) => x.id === id); t.groupId = -1; },
      remove: async (ids) => { rec("tabs.remove", ids); st.tabs = st.tabs.filter((t) => ![].concat(ids).includes(t.id)); }
    },
    tabGroups: {
      get: async (gid) => { const g = st.groups[gid]; if (!g || !st.tabs.some((t) => t.groupId === gid)) throw new Error("no group"); return g; },
      update: async (gid, o) => { rec("tabGroups.update", { gid, ...o }); Object.assign(st.groups[gid], o); }
    },
    windows: { create: async (o) => { rec("windows.create", o); const w = st.nextWin++; const t = { id: st.nextTab++, windowId: w, active: true, groupId: -1 }; st.tabs.push(t); return { id: w, tabs: [{ ...t }] }; } },
    storage: { session: { get: async () => ({ ...st.store }), set: async (v) => Object.assign(st.store, v) } }
  };
  return { chrome, st };
}
const userGroup = (st, id, windowId) => { st.groups[id] = { id, windowId, title: "Work" }; };
const mk = (tabs, opts) => { const f = fakeChrome(tabs); return { ...f, S: createSessions(f.chrome, opts) }; };

console.log("== session id ==");
ok(sidOf(undefined) === "default" && sidOf("") === "default" && sidOf("a") === "a", "missing session_id falls back to default");

console.log("== create: own window, not selected, one blank tab (#28) ==");
{
  const { S, st } = mk();
  const { tab, groupId } = await S.createTab("A");
  ok(st.calls.filter((c) => c.n === "windows.create").length === 1 && st.tabs.length === 1, "first tab reuses the window's tab (no extra blank)");
  ok(st.calls.find((c) => c.n === "windows.create").a.focused === false, "window not focused");
  ok(tab.windowId !== 1 && st.tabs.find((t) => t.id === tab.id).windowId === tab.windowId && st.groups[groupId].windowId === tab.windowId, "new tab stays in the window just created, not the focused one");
  ok(st.groups[groupId].title === "Claude", "first session titled Claude");
  const t2 = await S.createTab("A");
  const c = st.calls.find((c) => c.n === "tabs.create");
  ok(c.a.active === false && c.a.windowId === tab.windowId, "next tab: active:false, in the group's own window");
  ok(!st.calls.some((c) => c.n === "tabs.update" || c.n === "windows.update"), "no tab selected / window raised");
  ok((await S.ownedTabs("A")).length === 2 && t2.groupId === groupId, "both tabs in one group");
}

console.log("== isolation + error names valid ids ==");
{
  const { S, st } = mk();
  const a = await S.createTab("A"); const b = await S.createTab("B");
  ok(st.groups[a.groupId].title === "Claude" && st.groups[b.groupId].title === "Claude 2", "distinct titles");
  ok(st.groups[a.groupId].color !== st.groups[b.groupId].color, "distinct colours");
  ok((await S.assertTabOwned("A", a.tab.id)).id === a.tab.id, "owner passes");
  const e = await rejects(S.assertTabOwned("A", b.tab.id));
  ok(e === `Tab ${b.tab.id} is not in this session's tab group. Valid tab IDs are: ${a.tab.id}.`, `error text: ${e}`);
  ok(/Valid tab IDs are: \(none\)/.test(await rejects(S.assertTabOwned("C", a.tab.id))), "session with no group: (none)");
  ok((await S.assertTabOwned("A", String(a.tab.id))).id === a.tab.id, "string tabId coerced");
}

console.log("== concurrent creates make ONE group ==");
{
  const { S, st } = mk();
  await Promise.all([S.createTab("A"), S.createTab("A"), S.createTab("A")]);
  ok(st.calls.filter((c) => c.n === "windows.create").length === 1 && S.sessions.get("A").groupIds.length === 1, "serialised: one window, one group");
}

console.log("== attach: group from the user's own tab, nothing created ==");
{
  const { S, st } = mk([{ id: 1, windowId: 7, title: "Inbox", url: "https://mail.example/x", active: true }, { id: 2, windowId: 7, title: "Docs", url: "https://docs.example", active: true }, { id: 3, windowId: 8, title: "Docs two", url: "https://docs.example/2", active: true }]);
  const r = await S.attach("A", { match: "INBOX" });
  ok(r.tab.id === 1 && st.tabs.find((t) => t.id === 1).groupId === r.groupId, "matched case-insensitively and grouped");
  ok(!st.calls.some((c) => ["windows.create", "tabs.create", "tabs.remove"].includes(c.n)), "no window, no tab created, nothing closed");
  ok(st.tabs.find((t) => t.id === 1).windowId === 7 && st.tabs.length === 3, "tab stays in its window (focused window is 1, not 7)");
  ok(st.calls.find((c) => c.n === "tabs.group").a.createProperties.windowId === 7, "tabs.group got createProperties.windowId = the tab's window");
  ok((await S.attach("A", { tabId: 1 })).already === true, "re-attach is a no-op");
  const e = await rejects(S.attach("A", { match: "docs" }));
  ok(/matches 2 tabs/.test(e) && /2:/.test(e) && /3:/.test(e), "ambiguous match lists candidates");
  ok((await S.attach("A", { match: "docs two" })).tab.id === 3, "unique match");
  ok((await S.ownedTabs("A")).length === 2 && S.sessions.get("A").groupIds.length === 2, "second window gets its own group (tab not moved)");
  ok(/No open tab matches/.test(await rejects(S.attach("A", { match: "zzz" }))), "no match errors");
  const f = mk([{ id: 1, windowId: 1, title: "x a" }, { id: 2, windowId: 1, title: "x b", active: true }]);
  ok((await f.S.attach("A", { match: "x" })).tab.id === 2, "several matches: prefers the active one");
  ok(/another session/.test(await rejects(S.attach("B", { tabId: 1 }))), "refuses tab owned by another session");
  const r2 = await S.attach("B", { tabId: 1, steal: true });
  ok(r2.stolenFrom === "A" && (await S.ownedTabs("B")).map((t) => t.id).join() === "1", "steal:true takes it");
  ok(!(await S.ownedTabs("A")).some((t) => t.id === 1), "previous owner lost it");
}

console.log("== context: attached tabs listed, nothing created ==");
{
  const { S, st } = mk([{ id: 1, windowId: 7, title: "T", url: "u", active: true }]);
  await S.attach("A", { tabId: 1 });
  st.calls.length = 0;
  const c = await S.context("A", true);
  ok(c.tabs.length === 1 && !st.calls.some((x) => x.n === "windows.create" || x.n === "tabs.create"), "createIfEmpty with attached tabs creates nothing");
  const n = await S.context("Z", false);
  ok(n.tabs.length === 0 && n.groupId === null, "no group, no create");
  ok((await S.context("Z", true)).tabs.length === 1, "createIfEmpty creates a fresh group");
}

console.log("== no main-tab fragility ==");
{
  const { S, st } = mk([{ id: 1, windowId: 7 }, { id: 2, windowId: 7 }]);
  await S.attach("A", { tabId: 1 }); await S.attach("A", { tabId: 2 });
  await S.detach("A", 1);
  ok(st.tabs.find((t) => t.id === 1).groupId === -1 && st.tabs.some((t) => t.id === 1), "detach ungroups, never closes");
  ok((await S.ownedTabs("A")).map((t) => t.id).join() === "2", "other tab stays grouped");
  ok(/not in this session/.test(await rejects(S.detach("A", 1))), "detach of non-owned refused");
  await S.close("A", [2]);
  ok((await S.ownedTabs("A")).length === 0 && S.sessions.get("A").groupIds.length === 0, "last tab closed: group forgotten");
  ok((await S.context("A", true)).tabs.length === 1, "createIfEmpty makes a fresh group afterwards");
}

console.log("== close only own tabs ==");
{
  const { S, st } = mk([{ id: 1, windowId: 7 }]);
  const a = await S.createTab("A");
  const r = await S.close("A", [a.tab.id, 1]);
  ok(r.closed.join() === String(a.tab.id) && r.skipped.join() === "1" && st.tabs.some((t) => t.id === 1), "foreign tab skipped, not closed");
}

console.log("== session_end: close created, only ungroup attached ==");
{
  const released = [];
  const { S, st } = mk([{ id: 1, windowId: 7, title: "mine" }], { onRelease: async (id) => released.push(id) });
  await S.attach("A", { tabId: 1 });
  const made = await S.createTab("A");
  const r = await S.endSession("A");
  ok(r.closed.join() === String(made.tab.id) && r.ungrouped.join() === "1", "created closed, attached ungrouped");
  ok(st.tabs.length === 1 && st.tabs[0].id === 1 && st.tabs[0].groupId === -1, "user's tab survives, ungrouped");
  ok(released.length === 2, "debugger release hook ran for both");
  ok(S.sessions.size === 0, "session forgotten");
  ok((await S.endSession("nope")).closed.length === 0, "ending an unknown session is a no-op");
}

console.log("== idle sweep (M2: runs with the host connected; live sessions never swept) ==");
{
  let t = 1000;
  const { S, st } = mk([], { now: () => t });
  await S.createTab("A"); await S.createTab("B");
  t += 29 * 60000;
  ok((await S.sweepIdle()).length === 0, "not idle yet");
  t += 2 * 60000;
  await S.noteAlive(["B", "nobody"]); // host says B's client is still connected
  ok(!S.sessions.has("nobody"), "noteAlive never creates a session");
  ok((await S.sweepIdle()).join() === "A" && st.tabs.length === 1, "A (silent 31 min) ended and its tab closed; B (alive) kept");
  await S.touch("B"); t += 29 * 60000;
  ok((await S.sweepIdle()).length === 0, "recent request keeps a session");
}

console.log("== persistence + reconcile ==");
{
  const { chrome, st, S } = mk([{ id: 1, windowId: 7 }]);
  const a = await S.createTab("A"); await S.attach("A", { tabId: 1 });
  const b = await S.createTab("B");
  const S2 = createSessions(chrome); // service worker restart: fresh memory, same storage
  ok((await S2.ownedTabs("A")).map((t) => t.id).sort().join() === [1, a.tab.id].sort().join(), "map restored from storage.session");
  ok(S2.sessions.get("A").attached.has(1) && S2.sessions.get("A").created.has(a.tab.id), "created/attached tracking restored");
  st.tabs = st.tabs.filter((t) => t.id !== b.tab.id); // B's tab vanished while the worker slept
  const S3 = createSessions(chrome);
  await S3.load();
  ok(!S3.sessions.has("B") && S3.sessions.has("A"), "dead session dropped on reconcile");
  const C = await S3.createTab("C");
  ok(st.groups[C.groupId].title === "Claude 2", "freed index reused");
}

console.log("== H2/L10: group created in the tab's window while ANOTHER window is focused ==");
{
  const { S, st } = mk([{ id: 1, windowId: 7, title: "Gmail" }]);
  st.focusedWindow = 1;
  await S.attach("A", { tabId: 1 });
  ok(st.tabs.find((t) => t.id === 1).windowId === 7, "attached tab not pulled into the focused window");
  const made = await S.createTab("B");
  ok(made.tab.windowId === 50 && st.groups[made.groupId].windowId === 50, "created tab not pulled out of its fresh window");
}

console.log("== L2: concurrent context(createIfEmpty) makes one tab ==");
{
  const { S, st } = mk();
  const rs = await Promise.all([S.context("A", true), S.context("A", true), S.context("A", true)]);
  ok(st.tabs.length === 1 && rs.every((r) => r.tabs.length === 1), "one tab, every caller sees it");
}

console.log("== L7: touch before load cannot steal a restored session's index ==");
{
  const { chrome, S } = mk();
  await S.createTab("A"); // A holds index 1 in storage
  const S2 = createSessions(chrome); // worker restart
  S2.touch("B"); // arrives before load()
  await Promise.resolve();
  ok(!S2.sessions.has("B"), "touch before load() registers nothing (no index taken from an unloaded map)");
  await S2.load(); await S2.createTab("B");
  ok(S2.sessions.get("A").index === 1 && S2.sessions.get("B").index === 2, "restored A keeps 1, new B gets 2");
}

console.log("== M8: attach remembers the user's group + pin; detach and session end restore them ==");
{
  const mkw = () => {
    const m = mk([{ id: 1, windowId: 7, groupId: 300, title: "Jira" }, { id: 2, windowId: 7, groupId: 300, title: "Wiki" }, { id: 3, windowId: 7, pinned: true, title: "Mail" }, { id: 4, windowId: 7, groupId: 301, title: "Gone" }]);
    userGroup(m.st, 300, 7); userGroup(m.st, 301, 7);
    return m;
  };
  const { S, st } = mkw();
  await S.attach("A", { tabId: 1 }); await S.attach("A", { tabId: 3 });
  ok(st.tabs.find((t) => t.id === 1).groupId !== 300 && st.tabs.find((t) => t.id === 3).pinned === false, "attach moved it (precondition: grouping unpinned the pinned tab)");
  await S.detach("A", 1);
  ok(st.tabs.find((t) => t.id === 1).groupId === 300, "detach: back in the user's own group");
  await S.detach("A", 3);
  ok(st.tabs.find((t) => t.id === 3).pinned === true && st.tabs.find((t) => t.id === 3).groupId === -1, "detach: pinned again, not grouped");
  const m2 = mkw();
  await m2.S.attach("A", { tabId: 1 }); await m2.S.attach("A", { tabId: 3 }); await m2.S.attach("A", { tabId: 4 });
  delete m2.st.groups[301]; // the user's group no longer exists
  await m2.S.endSession("A");
  const g = (id) => m2.st.tabs.find((t) => t.id === id);
  ok(g(1).groupId === 300 && g(3).pinned === true && g(4).groupId === -1, "session end: group restored, re-pinned, vanished group falls back to ungrouped");
  const m3 = mkw();
  await m3.S.attach("A", { tabId: 1 }); await m3.S.attach("B", { tabId: 1, steal: true }); await m3.S.detach("B", 1);
  ok(m3.st.tabs.find((t) => t.id === 1).groupId === 300, "steal passes the original group on to the new owner");
  const m4 = mkw(); const S4b = createSessions(m4.chrome);
  await m4.S.attach("A", { tabId: 3 });
  await S4b.endSession("A");
  ok(m4.st.tabs.find((t) => t.id === 3).pinned === true, "restore info survives a worker restart");
}

console.log("== listAll ==");
{
  const { S } = mk([{ id: 1, windowId: 7, title: "u", url: "x" }]);
  await S.attach("A", { tabId: 1 }); await S.createTab("B");
  const l = await S.listAll("A");
  ok(l.length === 2 && l.find((t) => t.tabId === 1).session === "Claude" && l.find((t) => t.tabId === 1).mine, "owner + mine reported");
  const other = l.find((t) => t.tabId !== 1);
  ok(other.session === "Claude 2" && !other.mine && !JSON.stringify(l).includes('"B"'), "other session's tab flagged by group title, raw session id not leaked");
}

process.exit(fail ? 1 : 0);
