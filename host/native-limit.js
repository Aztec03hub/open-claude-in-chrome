// Chrome closes the native messaging port when the host sends a single message
// over 1 MB, which would fail every session at once. Stay well under it and
// turn an oversized request into an error for just the caller that sent it.

export const MAX_NATIVE_BYTES = 900 * 1024;

/** Returns an error message if `obj` would be too big to send to Chrome, else null. */
export function nativeSizeError(obj) {
  const bytes = Buffer.byteLength(JSON.stringify(obj), "utf-8");
  if (bytes <= MAX_NATIVE_BYTES) return null;
  return (
    `Request is ${Math.round(bytes / 1024)} KB, over the ${MAX_NATIVE_BYTES / 1024} KB limit for a single message to the browser; ` +
    "nothing was sent. For file_upload pass file paths (not inline bytes) or smaller files."
  );
}
