// gif_creator export without `download`/`coordinate` returns the GIF as an
// image content block. MCP clients cannot do much with a GIF, so write it to a
// file on THIS machine (WSL) and return the path instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function gifDir() {
  return process.env.OCIC_GIF_DIR || path.join(os.homedir(), ".config", "open-claude-in-chrome", "gifs");
}

/** Replace image/gif blocks in a tool result with a text note holding the saved path. */
export function saveGifBlocks(result, dir = gifDir()) {
  if (!result || !Array.isArray(result.content)) return result;
  if (!result.content.some((c) => c && c.type === "image" && c.mimeType === "image/gif")) return result;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let n = 0;
  const content = result.content.map((c) => {
    if (!(c && c.type === "image" && c.mimeType === "image/gif")) return c;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `recording-${stamp}${n++ ? `-${n}` : ""}.gif`);
      fs.writeFileSync(file, Buffer.from(c.data, "base64"));
      return { type: "text", text: `GIF saved to ${file}` };
    } catch (e) {
      return { type: "text", text: `Could not save the GIF on the MCP server machine: ${e.message}` };
    }
  });
  return { ...result, content };
}
