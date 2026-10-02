// Uncaught exceptions and unhandled promise rejections arrive as CDP
// Runtime.exceptionThrown, not as console calls, so they were invisible to
// read_console_messages. This turns one into a console-buffer entry with level
// "exception" (which `onlyErrors` already matches).

const MAX_STACK_FRAMES = 5;

export function formatExceptionEntry(params, now = Date.now()) {
  const d = (params && params.exceptionDetails) || {};
  const ex = d.exception || {};
  // Errors carry "Error: msg\n    at ..." in description; thrown primitives carry value.
  let text = ex.description || (ex.value !== undefined ? String(ex.value) : "") || d.text || "Uncaught exception";
  const frames = (d.stackTrace && d.stackTrace.callFrames) || [];
  if (!/\n\s+at /.test(text) && frames.length) {
    text +=
      "\n" +
      frames
        .slice(0, MAX_STACK_FRAMES)
        .map((f) => `    at ${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
        .join("\n");
  }
  if (/in promise/.test(d.text || "")) text = `Unhandled promise rejection: ${text}`;
  return { level: "exception", text, url: d.url || (frames[0] && frames[0].url) || "", timestamp: now };
}
