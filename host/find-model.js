// Model-backed `find`, done on the MCP-server side so no API key is needed:
// fetch the page's accessibility tree from the extension (read_page), ask Haiku
// through the locally installed Claude Code CLI (headless, prompt on stdin) which
// elements match the natural-language query, validate the refs it names, and
// format them like the official tool. If the CLI is missing or fails, fall back
// to the extension's substring `find` and say so in the result.

import { spawn } from "node:child_process";
import os from "node:os";

export const CLAUDE_TIMEOUT_MS = 30_000;
const TREE_CHARS = 80_000;

/** Same wording as the official extension's find prompt. */
export function buildFindPrompt(query, tree) {
  return (
    `You are helping find elements on a web page. The user wants to find: "${query}"\n\n` +
    `Here is the accessibility tree of the page:\n${tree}\n\n` +
    `Find ALL elements that match the user's query. Return up to 20 most relevant matches, ordered by relevance.\n\n` +
    `Return your findings in this exact format (one line per matching element):\n\n` +
    `FOUND: <total_number_of_matching_elements>\nSHOWING: <number_shown_up_to_20>\n---\n` +
    `ref_X | role | name | type | reason why this matches\nref_Y | role | name | type | reason why this matches\n...\n\n` +
    `If there are more than 20 matches, add this line at the end:\nMORE: Use a more specific query to see additional results\n\n` +
    `If no matching elements are found, return only:\nFOUND: 0\nERROR: explanation of why no elements were found`
  );
}

const oneLine = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * Parse the model's reply. Refs it invents (not present in `tree`) are dropped.
 * `parsed` is false when the reply has no FOUND line at all (caller falls back).
 */
export function parseFindResponse(text, tree) {
  const valid = new Set((tree.match(/\[ref_\d+\]/g) || []).map((r) => r.slice(1, -1)));
  const out = { parsed: false, found: 0, matches: [], more: false, error: undefined };
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("FOUND:")) {
      out.parsed = true;
      out.found = parseInt(line.slice(6).trim(), 10) || 0;
    } else if (line.startsWith("ERROR:")) out.error = line.slice(6).trim();
    else if (line.startsWith("MORE:")) out.more = true;
    else if (line.startsWith("ref_") && line.includes("|")) {
      const p = line.split("|").map((x) => x.trim());
      if (valid.has(p[0]) && p.length >= 4) {
        out.matches.push({ ref: p[0], role: p[1], name: oneLine(p[2]), type: p[3] || undefined, description: oneLine(p[4]) || undefined });
      }
    }
  }
  return out;
}

export function formatFindResult(p) {
  let head = `Found ${p.found} matching element${p.found === 1 ? "" : "s"}`;
  if (p.more) head += ` (showing first ${p.matches.length}, use a more specific query to narrow results)`;
  const lines = p.matches.map(
    (m) => `- ${m.ref}: ${m.role}${m.name ? ` "${m.name}"` : ""}${m.type ? ` (${m.type})` : ""}${m.description ? ` - ${m.description}` : ""}`
  );
  return `${head}\n\n${lines.join("\n")}`;
}

/**
 * Ask Haiku via `claude -p`. Resolves to the reply text; rejects on a missing
 * CLI, timeout, non-zero exit, or an is_error reply. `spawnImpl` is injectable.
 */
export function askHaiku(prompt, { spawnImpl = spawn, bin = process.env.OCIC_CLAUDE_BIN || "claude", timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    // Stripped-down session: no tools, no MCP servers (so it cannot recurse into
    // this very server), no user/project settings or hooks, tmp cwd (no CLAUDE.md).
    const args = [
      "-p", "--model", "haiku", "--output-format", "json", "--no-session-persistence",
      "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--disable-slash-commands", "--setting-sources", "",
      "--system-prompt", "You are a precise element-finding assistant. Follow the requested output format exactly.",
    ];
    let child;
    try {
      child = spawnImpl(bin, args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error(`could not start ${bin}: ${e.message}`));
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      done(reject, new Error(`claude CLI timed out after ${timeoutMs / 1000}s`));
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => done(reject, new Error(e.code === "ENOENT" ? `claude CLI not found (${bin})` : e.message)));
    child.on("close", (code) => {
      if (code !== 0) return done(reject, new Error(`claude CLI exited ${code}: ${oneLine(stderr || stdout, 160)}`));
      try {
        const j = JSON.parse(stdout);
        if (j.is_error || typeof j.result !== "string") return done(reject, new Error(`claude CLI error: ${oneLine(j.result ?? stdout, 160)}`));
        done(resolve, j.result);
      } catch {
        done(reject, new Error("claude CLI returned non-JSON output"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

const textOf = (r) =>
  typeof r === "string" ? r : (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/**
 * @param args  the find tool args { query, tabId }
 * @param call  (tool, args) => raw extension result (string or {content})
 * @param ask   (prompt) => Promise<string>; defaults to askHaiku
 */
export async function findWithModel(args, call, ask = askHaiku) {
  const fallback = async (why) => {
    const r = await call("find", args);
    const note = `[find: model-backed search unavailable (${why}); used substring match instead]\n`;
    if (typeof r === "string") return note + r;
    const content = [...(r?.content || [])];
    const i = content.findIndex((c) => c.type === "text");
    if (i >= 0) content[i] = { ...content[i], text: note + content[i].text };
    else content.unshift({ type: "text", text: note });
    return { ...r, content };
  };

  let raw;
  try {
    raw = await call("read_page", { tabId: args.tabId, filter: "all", max_chars: TREE_CHARS });
  } catch (e) {
    return fallback(`could not read the page: ${e.message}`);
  }
  const tree = textOf(raw).replace(/\n\nViewport: \S+$/, "");
  // An error result from read_page (ownership, no such tab, ...) is the answer,
  // not a reason to retry with a substring find that would fail the same way.
  if (raw && raw.isError) return raw;
  if (!/\[ref_\d+\]/.test(tree)) return fallback("page has no readable accessibility tree");

  let reply;
  try {
    reply = await ask(buildFindPrompt(args.query, tree));
  } catch (e) {
    return fallback(e.message);
  }
  const p = parseFindResponse(reply, tree);
  if (!p.parsed) return fallback("model reply was not in the expected format");
  if (p.found === 0 || p.matches.length === 0) {
    return { content: [{ type: "text", text: p.error || `No matching elements found for "${args.query}"` }] };
  }
  return { content: [{ type: "text", text: formatFindResult(p) }] };
}
