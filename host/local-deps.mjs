// Lists the files the Windows-side native host needs: native-host.js plus every
// local module it imports, transitively. install-wsl.sh copies exactly this set,
// so adding an import can never strand the Windows copy (it used to copy a
// hand-kept list, and a new import crashed the host at startup).
//
// Fails if the closure imports a bare package: the Windows copy has no
// node_modules, so only relative paths and node: builtins may appear.
//
// Usage: node local-deps.mjs [entry ...]   (paths relative to this directory)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

export function localDeps(entries, dir = HERE) {
  const seen = new Set();
  const stack = entries.map((e) => path.resolve(dir, e));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".")) {
        throw new Error(`${path.relative(dir, file)} imports package "${spec}"; the Windows host copy has no node_modules`);
      }
      stack.push(path.resolve(path.dirname(file), spec));
    }
  }
  return [...seen].map((f) => path.relative(dir, f)).sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = process.argv.slice(2);
  for (const f of localDeps(entries.length ? entries : ["native-host.js"])) console.log(f);
}
