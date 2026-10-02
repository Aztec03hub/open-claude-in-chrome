// file_upload across WSL: Windows Chrome cannot open WSL paths, so read them
// here and forward {name, mimeType, base64} items as `files`. Native Windows
// keeps the old `paths` form.

import fs from "node:fs/promises";
import path from "node:path";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const MIME = {
  ".txt": "text/plain", ".csv": "text/csv", ".html": "text/html", ".json": "application/json",
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".zip": "application/zip",
  ".md": "text/markdown", ".xml": "application/xml", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
  ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

export async function filesFromPaths(args, { platform = process.platform, max = MAX_UPLOAD_BYTES } = {}) {
  if (platform === "win32" || !Array.isArray(args.paths)) return args;
  const files = [];
  let total = 0;
  for (const p of args.paths) {
    let st;
    try {
      st = await fs.stat(p);
    } catch (e) {
      throw new Error(`Cannot read ${p}: ${e.code || e.message}`);
    }
    if (!st.isFile()) throw new Error(`Not a file: ${p}`);
    total += st.size;
    if (total > max) throw new Error(`file_upload total size exceeds ${max / 1024 / 1024} MB; upload fewer or smaller files`);
    const buf = await fs.readFile(p);
    files.push({
      name: path.basename(p),
      mimeType: MIME[path.extname(p).toLowerCase()] || "application/octet-stream",
      base64: buf.toString("base64")
    });
  }
  const { paths, ...rest } = args;
  return { ...rest, files };
}
