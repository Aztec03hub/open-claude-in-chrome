// Animated-GIF assembly (gifenc, vendored) and the overlay plan drawn on each
// frame. Pure: frames in are plain RGBA buffers, bytes out, so it runs in Node.

import { GIFEncoder, quantize, applyPalette } from "../vendor/gifenc.esm.js";

// Per-frame display time by the action that produced the frame (ms), as the
// official extension does.
const DELAY = {
  wait: 300, screenshot: 300, navigate: 800, scroll: 800, scroll_to: 800, type: 800, key: 800, zoom: 800,
  left_click: 1500, right_click: 1500, double_click: 1500, triple_click: 1500, left_click_drag: 1500,
};
export const frameDelay = (action) => (action ? DELAY[action.type] ?? 800 : 800);

/**
 * @param frames  [{ data: Uint8ClampedArray|Uint8Array RGBA, width, height, delay }] (all same size)
 * @param opts    { quality: 1-30, lower = better colour fidelity, slower (default 10) }
 */
export function encodeGif(frames, { quality = 10 } = {}) {
  if (!frames.length) throw new Error("no frames to encode");
  const { width, height } = frames[0];
  const format = quality <= 10 ? "rgb565" : "rgb444";
  const enc = GIFEncoder();
  frames.forEach((f, i) => {
    if (f.width !== width || f.height !== height) throw new Error("frame size mismatch");
    const palette = quantize(f.data, 256, { format });
    const index = applyPalette(f.data, palette, format);
    enc.writeFrame(index, width, height, { palette, delay: f.delay ?? 800, ...(i === 0 ? { repeat: 0 } : {}) });
  });
  enc.finish();
  return enc.bytes();
}

/**
 * What to draw on frame `index` of `total`. Coordinates are in the frame's own
 * pixel space; `scale` maps screenshot pixels onto the output size.
 * Returns ops: circle | arrow | label | bar | watermark.
 */
export function planOverlays(frame, index, total, opts = {}, scale = 1) {
  const o = {
    showClickIndicators: true, showDragPaths: true, showActionLabels: true, showProgressBar: true, showWatermark: true,
    ...opts,
  };
  const ops = [];
  const a = frame.action;
  if (a) {
    const isClick = /click/.test(a.type) && a.type !== "left_click_drag";
    if (o.showClickIndicators && isClick && a.coordinate) {
      ops.push({ op: "circle", x: a.coordinate[0] * scale, y: a.coordinate[1] * scale, r: 20 * scale });
    }
    if (o.showDragPaths && a.type === "left_click_drag" && a.start && a.coordinate) {
      ops.push({ op: "arrow", x1: a.start[0] * scale, y1: a.start[1] * scale, x2: a.coordinate[0] * scale, y2: a.coordinate[1] * scale });
    }
    if (o.showActionLabels && a.description) ops.push({ op: "label", text: String(a.description).slice(0, 80) });
  }
  if (o.showProgressBar && total > 0) ops.push({ op: "bar", frac: (index + 1) / total });
  if (o.showWatermark) ops.push({ op: "watermark", text: "Open Claude in Chrome" });
  return ops;
}

/** Execute overlay ops on a CanvasRenderingContext2D-like `ctx` of size w x h. */
export function drawOverlays(ctx, ops, w, h) {
  for (const op of ops) {
    ctx.save();
    if (op.op === "circle") {
      ctx.beginPath();
      ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,140,0,0.3)";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ff8c00";
      ctx.stroke();
    } else if (op.op === "arrow") {
      ctx.strokeStyle = "#e53935";
      ctx.fillStyle = "#e53935";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
      const ang = Math.atan2(op.y2 - op.y1, op.x2 - op.x1);
      ctx.beginPath();
      ctx.moveTo(op.x2, op.y2);
      ctx.lineTo(op.x2 - 12 * Math.cos(ang - 0.4), op.y2 - 12 * Math.sin(ang - 0.4));
      ctx.lineTo(op.x2 - 12 * Math.cos(ang + 0.4), op.y2 - 12 * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
    } else if (op.op === "label") {
      ctx.font = "14px sans-serif";
      const tw = ctx.measureText(op.text).width;
      const bw = Math.min(w - 8, tw + 16);
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(8, h - 52, bw, 24);
      ctx.fillStyle = "#fff";
      ctx.fillText(op.text, 16, h - 35, w - 24);
    } else if (op.op === "bar") {
      ctx.fillStyle = "#ff8c00";
      ctx.fillRect(0, h - 4, w * op.frac, 4);
    } else if (op.op === "watermark") {
      ctx.font = "bold 12px sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.textAlign = "right";
      ctx.fillText(op.text, w - 8, 18);
    }
    ctx.restore();
  }
}
