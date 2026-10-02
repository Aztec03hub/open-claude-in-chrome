// file_upload, extension side, for `files: [{name, mimeType, base64}]` (the MCP
// transport reads the files in WSL and sends their bytes, because the browser
// cannot see WSL paths). Builds File objects with DataTransfer in the page and
// assigns input.files, then fires input/change, exactly what a native picker does.
//
// The two functions below are injected into the page by chrome.scripting
// (MAIN world) so they must be self-contained.

/** Validate and normalise `files`. Returns { files } or { error }. */
export function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return { error: "files must be a non-empty array of {name, mimeType, base64}" };
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f || typeof f.name !== "string" || !f.name || typeof f.base64 !== "string") {
      return { error: `files[${i}] needs a string name and base64` };
    }
    out.push({ name: f.name.replace(/[\\/]/g, "_"), mimeType: typeof f.mimeType === "string" && f.mimeType ? f.mimeType : "application/octet-stream", base64: f.base64 });
  }
  return { files: out };
}

/** Runs in the page. Returns { ok, count } or { ok:false, error }. */
export function setFilesInPage(selector, files) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: "target input not found" };
  if (!(el instanceof HTMLInputElement) || el.type !== "file") return { ok: false, error: "target is not an <input type=file>" };
  if (files.length > 1 && !el.multiple) return { ok: false, error: "this input does not accept multiple files" };
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.mimeType, lastModified: Date.now() }));
  }
  el.files = dt.files;
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, count: el.files.length };
}

/** Mime type from the leading base64 bytes (screenshots are JPEG or PNG). */
export function mimeFromBase64(b64) {
  const head = String(b64 || "").replace(/^data:[^,]*,/, "");
  if (head.startsWith("iVBOR")) return "image/png";
  if (head.startsWith("R0lGOD")) return "image/gif";
  return "image/jpeg";
}

/**
 * Runs in the page (self-contained). Drop a file onto the element at (x, y) as a
 * dragenter/dragover/drop sequence, like the official upload_image `coordinate`.
 */
export function dropFileInPage(base64, filename, mimeType, x, y) {
  const bin = atob(String(base64).replace(/^data:[^,]*,/, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], filename, { type: mimeType, lastModified: Date.now() }));
  const el = document.elementFromPoint(x, y);
  if (!el) return { ok: false, error: `No element found at coordinates (${x}, ${y})` };
  for (const type of ["dragenter", "dragover", "drop"]) {
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  }
  return { ok: true, tag: el.tagName.toLowerCase(), kb: Math.round(bytes.length / 1024) };
}
