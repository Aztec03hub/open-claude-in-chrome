// install-wsl.sh / uninstall-wsl.sh, dry-run only (nothing is installed or deleted).
// M5: the Windows account name is persisted for the WSL side. M6: uninstall never rm -rf's OCIC_WIN_DIR.
// Run: node host/test/installers.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sh = (script, env, args = ["--dry-run"]) =>
  spawnSync("bash", [path.join(ROOT, script), ...args], { env: { ...process.env, ...env }, encoding: "utf-8" });

test("M5: the installer records OCIC_WIN_USER for the MCP server and in config.json (WSL user != Windows user)", (t) => {
  const winUser = [process.env.OCIC_WIN_USER, process.env.USER].find((u) => u && fs.existsSync(`/mnt/c/Users/${u}`));
  if (!winUser) return t.skip("needs a WSL host with /mnt/c/Users/<user>");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "occ-inst-"));
  const r = sh("install-wsl.sh", { USER: "someone_else", HOME: home, OCIC_WIN_USER: winUser });
  if (r.status !== 0 && /node\.exe|reg\.exe/.test(r.stdout + r.stderr)) return t.skip("no Windows node.exe / reg.exe here");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`claude mcp add .* -e OCIC_WIN_USER=${winUser} -- node `), "mcp add carries OCIC_WIN_USER");
  assert.match(r.stdout, new RegExp(`set winUser=${winUser} in ${home}/.config/open-claude-in-chrome/config.json`), "config.json gets winUser");
  assert.match(r.stdout, /\.ocic-install/, "installer drops the marker");
});

test("M5: the config.json writer keeps other keys and sets winUser", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "occ-cfg-"));
  const cfg = path.join(home, ".config", "open-claude-in-chrome", "config.json");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ pipe: "\\\\.\\pipe\\x" }));
  const src = fs.readFileSync(path.join(ROOT, "install-wsl.sh"), "utf-8");
  const oneLiner = /node -e '([^']+)'/.exec(src)[1];
  const r = spawnSync("node", ["-e", oneLiner, cfg, "plafayette"], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf-8")), { pipe: "\\\\.\\pipe\\x", winUser: "plafayette" });
});

test("M6: uninstall refuses a dir without the installer's marker (OCIC_WIN_DIR=the Windows profile)", () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "occ-profile-"));
  fs.mkdirSync(path.join(profile, "Documents"));
  const r = sh("uninstall-wsl.sh", { OCIC_WIN_DIR: profile, USER: "x" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /rm -rf/, "no deletion command is even printed");
  assert.match(r.stdout, /Not removing .*no \.ocic-install marker/);
  assert.ok(fs.existsSync(path.join(profile, "Documents")));
});

test("M6: with the marker, uninstall removes only extension/ and host/ (never the dir itself with rm -rf)", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "occ-dest-"));
  fs.writeFileSync(path.join(dest, ".ocic-install"), "x");
  const r = sh("uninstall-wsl.sh", { OCIC_WIN_DIR: dest, USER: "x" });
  const rm = r.stdout.split("\n").filter((l) => /rm -rf/.test(l));
  assert.equal(rm.length, 1);
  assert.ok(rm[0].includes(`${dest}/extension`) && rm[0].includes(`${dest}/host`), rm[0]);
  assert.ok(!rm[0].split(/\s+/).includes(dest), "the dir itself is not an rm -rf target");
});
