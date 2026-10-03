// tabs_list_all formatting: compact, filterable, bounded (live test 2026-10-02:
// 421 real tabs produced 224 KB and exceeded the MCP result limit).
// Run: node test/tablist.test.mjs
import { formatTabList, shortUrl, MAX_URL } from "../extension/tools/tablist.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const longUrl = "https://example.sharepoint.com/:w:/g/personal/x/Doc?e=6tF2bq&" + "p=".padEnd(400, "z");
const tabs = [];
for (let i = 0; i < 421; i++) {
  tabs.push({ tabId: 1000 + i, windowId: 7, title: `Tab ${i} ` + "t".repeat(200), url: longUrl, active: false, session: null, mine: false });
}
tabs.push({ tabId: 5, windowId: 9, title: "Review Details", url: "https://www.paycomonline.net/v4/ee/review/19195", active: true, session: "Claude", mine: true });

const all = formatTabList(tabs);
ok(all.length < 60000, `all 422 tabs fit well under the result limit (${all.length} chars)`);
ok(/^422 open tabs/.test(all) && /more; narrow with match/.test(all), "default limit caps the listing and says how many more");
ok(!all.includes("z".repeat(50)), "long query strings are not printed");
ok(shortUrl(longUrl).length <= MAX_URL && shortUrl(longUrl).startsWith("https://example.sharepoint.com/:w:/g/personal/x/Doc"), "shortUrl keeps the location, drops the query");
ok(shortUrl("https://a.b/c?d=1") === "https://a.b/c?d=1", "short URLs untouched");

const m = formatTabList(tabs, { match: "PAYCOM" });
ok(/^1 of 422 open tabs match "PAYCOM"/.test(m) && /5 w9 \[active\] \[session Claude, yours\] "Review Details" https:\/\/www\.paycomonline\.net/.test(m), "match filters on the full url, case-insensitive, with flags");
ok(formatTabList(tabs, { match: "6tF2bq" }).startsWith("421 of 422"), "match sees the full (unshortened) url");
ok(formatTabList(tabs, { limit: 3 }).split("\n").length === 5, "limit is honoured (header + 3 lines + more-note)");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
