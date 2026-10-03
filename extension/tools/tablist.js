// tabs_list_all output. A real browser can have hundreds of tabs with very long
// URLs (live test: 421 tabs came to 224 KB and blew the MCP result limit), so
// print one compact line per tab, shorten long URLs, and allow a filter.

export const MAX_URL = 120;
export const MAX_TITLE = 80;
export const DEFAULT_LIMIT = 200;

export function shortUrl(url) {
  const u = String(url || "");
  if (u.length <= MAX_URL) return u;
  // Query strings and fragments are what make URLs long; keep the location.
  const bare = u.replace(/[?#].*$/, "");
  const cut = bare.length <= MAX_URL - 6 ? bare : bare.slice(0, MAX_URL - 7) + "…";
  return cut + (bare !== u ? "?…" : "");
}

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

/**
 * tabs: [{tabId, windowId, title, url, active, session, mine}] from sessions.listAll.
 * match: case-insensitive substring of the FULL url or title. limit: max lines.
 */
export function formatTabList(tabs, { match, limit = DEFAULT_LIMIT } = {}) {
  const needle = typeof match === "string" && match.trim() ? match.trim().toLowerCase() : null;
  const hits = needle
    ? tabs.filter((t) => String(t.url || "").toLowerCase().includes(needle) || String(t.title || "").toLowerCase().includes(needle))
    : tabs;
  const shown = hits.slice(0, Math.max(1, limit));
  const lines = shown.map(
    (t) =>
      `${t.tabId} w${t.windowId}${t.active ? " [active]" : ""}${t.session ? ` [session ${t.session}${t.mine ? ", yours" : ""}]` : ""} ` +
      `"${clip(String(t.title || ""), MAX_TITLE)}" ${shortUrl(t.url)}`
  );
  const head = needle
    ? `${hits.length} of ${tabs.length} open tabs match "${match}"`
    : `${tabs.length} open tabs`;
  const more = hits.length > shown.length ? `\n… ${hits.length - shown.length} more; narrow with match or raise limit.` : "";
  return `${head} (tabId, window, title, url):\n${lines.join("\n")}${more}`;
}
