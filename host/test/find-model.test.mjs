// find: prompt building, reply parsing/validation, fallback to substring match,
// and the claude CLI wrapper (fake child process). Run: node host/test/find-model.test.mjs
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { buildFindPrompt, parseFindResponse, formatFindResult, findWithModel, askHaiku } from "../find-model.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const TREE = [
  'textbox "Search" [ref_1] type="text"',
  'button "Sign in" [ref_2] type="submit"',
  'link "Pricing" [ref_3] href="https://x/p"',
].join("\n") + "\n\nViewport: 1280x800";

console.log("== prompt ==");
const p = buildFindPrompt("login button", TREE);
ok(p.includes('The user wants to find: "login button"') && p.includes(TREE) && p.includes("FOUND: <total_number_of_matching_elements>") && p.includes("MORE: Use a more specific query"), "prompt carries query, tree and the output contract");

console.log("== parsing ==");
let r = parseFindResponse("FOUND: 2\nSHOWING: 2\n---\nref_2 | button | Sign in | submit | the login control\nref_1 | textbox | Search | text | not it", TREE);
ok(r.parsed && r.found === 2 && r.matches.length === 2 && r.matches[0].ref === "ref_2" && r.matches[0].description === "the login control", "parses matches in model order");
r = parseFindResponse("FOUND: 3\nref_2 | button | Sign in | submit | ok\nref_99 | button | Ghost | submit | hallucinated\nMORE: Use a more specific query to see additional results", TREE);
ok(r.matches.length === 1 && r.matches[0].ref === "ref_2", "refs that are not in the page tree are dropped");
ok(r.more === true, "MORE line detected");
r = parseFindResponse("FOUND: 0\nERROR: nothing like that on this page", TREE);
ok(r.parsed && r.found === 0 && r.error === "nothing like that on this page", "FOUND: 0 + ERROR");
ok(!parseFindResponse("I think it is the blue button", TREE).parsed, "free text is not a parse");
r = parseFindResponse("FOUND: 1\nref_1 | textbox | Search\nref_3 | link | Pricing | link | x", TREE);
ok(r.matches.length === 1 && r.matches[0].ref === "ref_3", "lines with fewer than 4 fields are ignored");
const out = formatFindResult({ found: 25, more: true, matches: [{ ref: "ref_2", role: "button", name: "Sign in", type: "submit", description: "login" }] });
ok(/Found 25 matching elements \(showing first 1, use a more specific query/.test(out) && out.includes('- ref_2: button "Sign in" (submit) - login'), "result format matches the official one");

console.log("== findWithModel ==");
{
  const calls = [];
  const call = async (tool, args) => { calls.push([tool, args]); return tool === "read_page" ? { content: [{ type: "text", text: TREE }] } : { content: [{ type: "text", text: "Found 1 element(s) matching \"q\":\n\n[ref_9] x" }] }; };
  let res = await findWithModel({ query: "login", tabId: 4 }, call, async () => "FOUND: 1\nSHOWING: 1\n---\nref_2 | button | Sign in | submit | login");
  ok(calls.length === 1 && calls[0][0] === "read_page" && calls[0][1].tabId === 4 && calls[0][1].filter === "all", "reads the accessibility tree (filter all) from the extension");
  ok(res.content[0].text.startsWith("Found 1 matching element") && res.content[0].text.includes("ref_2") && !res.content[0].text.includes("unavailable"), "model path result, no fallback note");
  ok(!res.content[0].text.includes("Viewport"), "viewport suffix not part of the tree sent");

  calls.length = 0;
  res = await findWithModel({ query: "login", tabId: 4 }, call, async () => { throw new Error("claude CLI not found (claude)"); });
  ok(calls.map((c) => c[0]).join() === "read_page,find", "CLI failure -> falls back to the extension's substring find");
  ok(res.content[0].text.startsWith("[find: model-backed search unavailable (claude CLI not found (claude)); used substring match instead]") && res.content[0].text.includes("[ref_9] x"), "fallback is announced in the result and keeps the substring output");

  calls.length = 0;
  res = await findWithModel({ query: "x", tabId: 4 }, call, async () => "nope, free text");
  ok(calls.at(-1)[0] === "find" && /expected format/.test(res.content[0].text), "unparseable model reply -> fallback");

  res = await findWithModel({ query: "x", tabId: 4 }, call, async () => "FOUND: 2\nref_77 | a | b | c | d");
  ok(calls.at(-1)[0] === "find" || /No matching/.test(res.content[0].text), "only hallucinated refs -> no phantom matches");

  res = await findWithModel({ query: "x", tabId: 4 }, call, async () => "FOUND: 0\nERROR: no cart here");
  ok(res.content[0].text === "no cart here", "model says nothing matches -> that is the answer, no fallback");

  const bad = async (t) => (t === "read_page" ? { content: [{ type: "text", text: "Tab 4 is not in the MCP group." }] } : T());
  res = await findWithModel({ query: "x", tabId: 4 }, bad, async () => { throw new Error("must not be called"); });
  ok(/is not in the MCP group/.test(res.content[0].text), "group error from read_page is returned as is");

  const empty = async (t) => (t === "read_page" ? { content: [{ type: "text", text: "Error: Could not generate accessibility tree" }] } : { content: [{ type: "text", text: "No elements found" }] });
  res = await findWithModel({ query: "x", tabId: 4 }, empty, async () => { throw new Error("must not be called"); });
  ok(/no readable accessibility tree/.test(res.content[0].text), "no tree -> fallback without calling the model");

  const strRes = async (t) => (t === "read_page" ? TREE : "plain string result");
  res = await findWithModel({ query: "x", tabId: 4 }, strRes, async () => { throw new Error("boom"); });
  ok(typeof res === "string" && res.endsWith("plain string result") && res.includes("unavailable (boom)"), "string results from the extension are handled");
}

function T() { return { content: [{ type: "text", text: "" }] }; }

console.log("== askHaiku (fake CLI) ==");
function fakeSpawn({ stdout = "", stderr = "", code = 0, hang = false, error } = {}) {
  const seen = {};
  const impl = (bin, args, opts) => {
    seen.bin = bin; seen.args = args; seen.opts = opts;
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
    c.stdin.on("data", (d) => (seen.stdin = (seen.stdin || "") + d));
    c.kill = (sig) => { seen.killed = sig; c.emit("close", null); };
    setImmediate(() => {
      if (error) return c.emit("error", error);
      if (hang) return;
      c.stdout.end(stdout); c.stderr.end(stderr);
      setImmediate(() => c.emit("close", code));
    });
    return c;
  };
  return { impl, seen };
}
{
  let f = fakeSpawn({ stdout: JSON.stringify({ result: "FOUND: 0", is_error: false }) });
  let res = await askHaiku("PROMPT", { spawnImpl: f.impl, bin: "claude" });
  ok(res === "FOUND: 0" && f.seen.stdin === "PROMPT", "prompt goes over stdin, result field returned");
  const a = f.seen.args;
  ok(a.includes("-p") && a[a.indexOf("--model") + 1] === "haiku" && a[a.indexOf("--output-format") + 1] === "json", "claude -p --model haiku --output-format json");
  ok(a[a.indexOf("--tools") + 1] === "" && a.includes("--strict-mcp-config") && a.includes("--no-session-persistence"), "no tools, no MCP servers, no session saved (no recursion into this server)");

  const fail1 = async (opts, re, name) => { try { await askHaiku("p", { bin: "claude", timeoutMs: 50, ...opts }); ok(false, name + " (resolved)"); } catch (e) { ok(re.test(e.message), `${name}: ${e.message}`); } };
  await fail1({ spawnImpl: fakeSpawn({ error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) }).impl }, /claude CLI not found/, "missing CLI");
  await fail1({ spawnImpl: fakeSpawn({ code: 1, stderr: "login required" }).impl }, /exited 1: login required/, "non-zero exit");
  await fail1({ spawnImpl: fakeSpawn({ stdout: JSON.stringify({ result: "Credit balance is too low", is_error: true }) }).impl }, /claude CLI error/, "is_error reply");
  await fail1({ spawnImpl: fakeSpawn({ stdout: "not json" }).impl }, /non-JSON/, "garbage output");
  const h = fakeSpawn({ hang: true });
  await fail1({ spawnImpl: h.impl }, /timed out after 0\.05s/, "hung CLI");
  ok(h.seen.killed === "SIGKILL", "hung CLI is killed");
}

console.log(fail === 0 ? "\nALL FIND-MODEL TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
