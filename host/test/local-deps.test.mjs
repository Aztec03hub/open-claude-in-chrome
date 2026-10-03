// The installer copies localDeps(["native-host.js"]) to Windows. Prove that set
// is self-sufficient: copy exactly it to a scratch dir, start the host from
// there, and fail on any module-resolution error. (A hand-kept list once missed
// session-tracker.js and native-limit.js and the host crashed at startup.)
// Run: node host/test/local-deps.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { localDeps } from "../local-deps.mjs";

const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const files = localDeps(["native-host.js"], HOST);
ok(files.includes("native-host.js") && files.includes("endpoint.js"), `closure includes the entry and its imports (${files.join(", ")})`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-localdeps-"));
for (const f of [...files, "package.json"]) {
  fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
  fs.copyFileSync(path.join(HOST, f), path.join(tmp, f));
}

const out = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(tmp, "native-host.js")], {
    env: { ...process.env, OCIC_PIPE: path.join(tmp, "probe.sock") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const done = (how) => { try { child.kill(); } catch {} resolve({ how, err }); };
  child.on("exit", (code) => done(`exit ${code}`));
  setTimeout(() => done("still running"), 2000);
});
ok(!/ERR_MODULE_NOT_FOUND|Cannot find module/.test(out.err), `host starts from the copied set without a missing module (${out.how})`);

// A bare package import must be refused: the Windows copy has no node_modules.
fs.writeFileSync(path.join(tmp, "bad.js"), 'import x from "left-pad";\n');
let threw = false;
try { localDeps(["bad.js"], tmp); } catch (e) { threw = /left-pad/.test(e.message); }
ok(threw, "a bare package import in the closure is an error");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
