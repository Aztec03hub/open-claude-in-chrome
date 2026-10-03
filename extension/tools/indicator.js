// Agent visual indicator: a pulsing glow around the page while a session is
// driving that tab, hidden while a screenshot is taken (as the official
// extension does). It removes ITSELF a few seconds after the last tool call,
// so a service-worker restart or a dropped bridge cannot leave it stuck on.

export const INDICATOR_ID = "ocic-agent-indicator";
export const LINGER_MS = 4000;

/**
 * Runs in the page (self-contained, injected with chrome.scripting).
 * show=true creates/refreshes the overlay and its self-removal timer; false removes it.
 */
export function paintIndicator(show, id, lingerMs) {
  const old = document.getElementById(id);
  if (!show) {
    if (old) {
      clearTimeout(old.__ocicTimer);
      old.remove();
    }
    return false;
  }
  let el = old;
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.setAttribute("aria-hidden", "true");
    el.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;box-sizing:border-box;" +
      "border:3px solid rgba(217,119,87,0.85);box-shadow:inset 0 0 24px 6px rgba(217,119,87,0.55);";
    // Web Animations, not a <style> sheet: a page CSP cannot block it.
    try {
      el.animate([{ opacity: 0.35 }, { opacity: 1 }, { opacity: 0.35 }], { duration: 1800, iterations: Infinity });
    } catch {}
    (document.documentElement || document.body).appendChild(el);
  }
  clearTimeout(el.__ocicTimer);
  el.__ocicTimer = setTimeout(() => el.remove(), lingerMs);
  return true;
}

/**
 * run(tabId, show) injects paintIndicator. Every call is best-effort: restricted
 * pages (chrome://, the Web Store) refuse injection and must never fail a tool.
 */
export const BOUND_MS = 300;

/**
 * Every injection is bounded: a tab blocked in a modal dialog or a long
 * synchronous loop never settles chrome.scripting.executeScript, and the
 * indicator must not be able to hold a tool call (or the dialog handler behind
 * it) hostage. After BOUND_MS we stop waiting; the injection is abandoned.
 */
export function createIndicator(run, { boundMs = BOUND_MS } = {}) {
  const safe = (tabId, show) => {
    let timer;
    const bound = new Promise((resolve) => { timer = setTimeout(resolve, boundMs); });
    const done = (async () => {
      try {
        await run(tabId, show);
      } catch {}
    })();
    return Promise.race([done, bound]).finally(() => clearTimeout(timer));
  };
  return {
    touch: (tabId) => safe(tabId, true),
    hide: (tabId) => safe(tabId, false),
    /** Run fn with the indicator hidden, then show it again. */
    async hidden(tabId, fn) {
      await safe(tabId, false);
      try {
        return await fn();
      } finally {
        await safe(tabId, true);
      }
    },
  };
}
