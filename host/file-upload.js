// file_upload across WSL: Windows Chrome cannot open a Linux path, so each one
// is converted with `wslpath -w` (\\wsl.localhost\<distro>\... or a drive path)
// and sent as `paths`, which the extension attaches with CDP
// DOM.setFileInputFiles. File bytes never travel over native messaging, which
// Chrome caps at 1 MB per message. Outside WSL (native Linux, macOS, Windows)
// the args pass through untouched, exactly as upstream.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

function wslpathW(p) {
  const bin = process.env.OCIC_WSLPATH || "wslpath"; // env override: test hook
  return new Promise((resolve, reject) => {
    execFile(bin, ["-w", p], { timeout: 10_000 }, (err, stdout) => {
      const out = String(stdout || "").trim();
      if (err || !out) reject(new Error(`wslpath -w failed for ${p}: ${err ? err.message : "empty output"}`));
      else resolve(out);
    });
  });
}

export async function filesFromPaths(args, { wsl = false, toWindowsPath = wslpathW } = {}) {
  if (!wsl || !args || !Array.isArray(args.paths)) return args;
  const paths = [];
  for (const raw of args.paths) {
    const p = path.resolve(String(raw));
    let st;
    try {
      st = await fs.stat(p);
    } catch (e) {
      throw new Error(`Cannot read ${raw}: ${e.code || e.message}`);
    }
    if (!st.isFile()) throw new Error(`Not a file: ${raw}`);
    paths.push(await toWindowsPath(p));
  }
  return { ...args, paths };
}
