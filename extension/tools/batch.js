// browser_batch: run {name, input} tool calls sequentially in one round trip.
// Semantics follow the official extension: stop at the first error and say how
// many completed; outputs (text and images) come back in order; browser_batch
// cannot nest; tabs_context_mcp / tabs_create_mcp inside a batch need no tabId.

const TABLESS = new Set(["tabs_context_mcp", "tabs_create_mcp"]);

// Handlers flag failures explicitly (result.isError, see result.js); the
// wording of a result is never inspected, so page text like "Invalid email"
// cannot stop a batch.
export function looksLikeError(result) {
  return !!(result && typeof result === "object" && result.isError);
}

export function actionLabel(a) {
  const act = a && a.input && a.input.action;
  return typeof act === "string" ? `${a.name}:${act}` : String(a && a.name);
}

function textOf(result) {
  const t = Array.isArray(result?.content) ? result.content.find((c) => c.type === "text") : null;
  return t ? String(t.text) : "Tool failed";
}

function failure(content, i, total, label, msg, done) {
  const text = `actions[${i}] (${label}) failed: ${msg} (${done} completed, ${total - i - 1} remaining)`;
  return { content: [...content, { type: "text", text }], isError: true };
}

/** Structural validation; returns an error string or null. */
export function validateBatch(args, handlers) {
  const actions = args && args.actions;
  if (!Array.isArray(actions) || actions.length === 0) return "actions must be a non-empty array";
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!a || typeof a.name !== "string") return `actions[${i}].name must be a string`;
    if (a.name === "browser_batch") return `actions[${i}]: browser_batch cannot be nested`;
    if (!a.input || typeof a.input !== "object" || Array.isArray(a.input)) return `actions[${i}].input must be an object`;
    if (!handlers[a.name]) return `actions[${i}]: unknown tool "${a.name}"`;
  }
  return null;
}

/**
 * @param args      { actions: [{name, input}] }
 * @param opts      { handlers, sessionId, assertTabOwned, selfChecked, finish, inFlight }
 *   assertTabOwned(sessionId, tabId) throws unless the session owns the tab;
 *   selfChecked names tools that do their own ownership checks (tabs_attach_mcp
 *   targets a tab the session does not own yet).
 *   finish(result, input) is the dispatcher's per-call post-processing (dialog
 *   notes); inFlight {begin,end}(tabId) marks the batch's tabs as being driven
 *   for its whole duration (see inflight.js).
 */
export async function runBatch(args, { handlers, sessionId, assertTabOwned, selfChecked = new Set(), finish = (r) => r, inFlight = null }) {
  const bad = validateBatch(args, handlers);
  if (bad) return { content: [{ type: "text", text: `browser_batch: ${bad}` }], isError: true };

  const tabIds = [...new Set(args.actions.map((a) => a.input.tabId).filter((t) => typeof t === "number"))];
  const begun = tabIds.map((t) => inFlight && inFlight.begin(t));
  try {
    await Promise.all(begun);
    return await runActions(args, { handlers, sessionId, assertTabOwned, selfChecked, finish });
  } finally {
    tabIds.forEach((t) => inFlight && inFlight.end(t));
  }
}

async function runActions(args, { handlers, sessionId, assertTabOwned, selfChecked, finish }) {
  const actions = args.actions;
  const total = actions.length;
  const out = [];
  for (let i = 0; i < total; i++) {
    const a = actions[i];
    const label = actionLabel(a);
    let input = a.input;
    if (TABLESS.has(a.name) && "tabId" in input) {
      const { tabId, ...rest } = input;
      input = rest;
    }
    let result;
    try {
      if (!TABLESS.has(a.name) && !selfChecked.has(a.name) && input.tabId !== undefined && input.tabId !== null) {
        await assertTabOwned(sessionId, input.tabId);
      }
      // Same session as the batch itself, so tab tools act on the caller's group.
      result = finish(await handlers[a.name](input, sessionId), input);
    } catch (e) {
      return failure(out, i, total, label, e && e.message ? e.message : String(e), i);
    }
    if (looksLikeError(result)) return failure(out, i, total, label, textOf(result), i);

    const tag = `[${i + 1}/${total} ${label}]`;
    let tagged = false;
    for (const block of result?.content || []) {
      if (!tagged && block.type === "text") {
        out.push({ ...block, text: `${tag} ${block.text}` });
        tagged = true;
      } else out.push(block);
    }
    if (!tagged) out.push({ type: "text", text: `${tag} ok` });
  }
  return { content: out };
}
