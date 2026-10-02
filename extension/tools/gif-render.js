// Browser-side wiring for gif_creator: decode frames with createImageBitmap,
// draw overlays on an OffscreenCanvas, encode with gifenc. Works in the MV3
// service worker (no DOM needed). Not unit-testable without a browser; the
// pure parts live in gif-encode.js.

import { encodeGif, planOverlays, drawOverlays, frameDelay } from "./gif-encode.js";

const MAX_WIDTH = 800; // GIFs get big fast; downscale wide viewports

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
}

/** frames: [{ base64 (jpeg), action }] -> { bytes, width, height } */
export async function renderGif(frames, options = {}) {
  const first = await createImageBitmap(b64ToBlob(frames[0].base64, "image/jpeg"));
  const scale = Math.min(1, MAX_WIDTH / first.width);
  const w = Math.max(1, Math.round(first.width * scale));
  const h = Math.max(1, Math.round(first.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const bmp = i === 0 ? first : await createImageBitmap(b64ToBlob(frames[i].base64, "image/jpeg"));
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    // Screenshots are 1:1 CSS pixels, so action coordinates map by `scale` only.
    drawOverlays(ctx, planOverlays(frames[i], i, frames.length, options, scale), w, h);
    out.push({ data: ctx.getImageData(0, 0, w, h).data, width: w, height: h, delay: frameDelay(frames[i].action) });
    if (bmp !== first) bmp.close();
  }
  first.close();
  const q = Number(options.quality);
  return { bytes: encodeGif(out, { quality: q >= 1 && q <= 30 ? q : 10 }), width: w, height: h };
}

/**
 * Injected into the page (chrome.scripting, self-contained): drop the GIF onto
 * the element at (x, y) as a dragenter/dragover/drop sequence, like the
 * official export-to-coordinate.
 */
export function dropGifInPage(base64, filename, x, y) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], filename, { type: "image/gif", lastModified: Date.now() }));
  const el = document.elementFromPoint(x, y);
  if (!el) throw new Error(`No element found at coordinates (${x}, ${y})`);
  for (const type of ["dragenter", "dragover", "drop"]) {
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  }
  return `Successfully dropped ${filename} (${Math.round(bytes.length / 1024)}KB) at (${x}, ${y})`;
}
