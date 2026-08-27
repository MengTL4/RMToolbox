// Prepare app/gui as an NW.js app by hard-linking a known-good NW runtime
// into app/gui. Falls back to copying.
//
// Donor resolution order:
//   1. config.local.json: { "nwRuntimeDonor": "C:\\path\\to\\nw-runtime" }
//   2. <projectRoot>/nwjs/  — drop an NW.js (≈0.54, Chromium 91) sdk/normal
//      extract here; nwjs.io/downloads has the archives
//   3. DEFAULT_DONORS — known-good modkits on the maintainer's machine

import { cpSync, existsSync, linkSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

// The donor's runtime binary is always named Game.exe (modkit) or nw.exe
// (official NW.js extract); app/gui ships it under the product name so the GUI
// never shares a process name with the games it patches (tasklist / Task
// Manager used to be ambiguous, and stale-process cleanup risked killing the
// GUI).
export const GUI_EXE_NAME = "RMToolbox.exe";
const DONOR_EXE_NAMES = new Set(["Game.exe", "nw.exe"]);

const DEFAULT_DONORS = [
  "F:\\SteamLibrary\\steamapps\\common\\再刷一把2：金色传说\\zs2_modkit\\runtime\\trainer",
  "F:\\SteamLibrary\\steamapps\\common\\大千世界2 The Stupendous World Demo\\dq2_modkit\\runtime\\trainer",
  "F:\\SteamLibrary\\steamapps\\common\\Nightmare without return\\nwr_modkit\\runtime\\game-app"
];

// Files/dirs that belong to the donor app itself, never to RMCH's GUI.
const DONOR_APP_FILES = new Set([
  "index.html", "package.json", "www", "app.js", "app.ts", "src", "styles",
  "html", "node_modules", "package-lock.json", "tsconfig.json", "debug.log",
  "styles.css", "index.template.html",
  // RMCH's own GUI sources — a donor with same-named entries must not clobber
  // them (and --force would otherwise delete them before copying).
  "ui", "vendor",
  // NWR game-app donor specifics: its patched bg-script + loader files.
  "loading", "bg_script", "loading.html"
]);

export function findNwRuntimeDonor(projectRoot) {
  const configPath = path.join(projectRoot, "config.local.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.nwRuntimeDonor && existsSync(config.nwRuntimeDonor)) return config.nwRuntimeDonor;
    } catch (_) {}
  }
  const local = path.join(projectRoot, "nwjs");
  if (existsSync(path.join(local, "nw.dll")) && existsSync(path.join(local, "nw.exe"))) return local;
  for (const donor of DEFAULT_DONORS) {
    if (existsSync(path.join(donor, "nw.dll")) && existsSync(path.join(donor, "Game.exe"))) return donor;
  }
  return null;
}

export function setupGuiRuntime({ projectRoot, force = false } = {}) {
  const donor = findNwRuntimeDonor(projectRoot);
  if (!donor) throw new Error(
    "no NW.js runtime donor found; extract an NW.js ≈0.54 build into nwjs/ " +
    "or set nwRuntimeDonor in config.local.json");
  const guiDir = path.join(projectRoot, "app", "gui");
  let linked = 0;
  let copied = 0;
  for (const entry of readdirSync(donor)) {
    if (DONOR_APP_FILES.has(entry)) continue;
    const source = path.join(donor, entry);
    // Ship the runtime binary under the product name (see GUI_EXE_NAME).
    const dest = path.join(guiDir, DONOR_EXE_NAMES.has(entry) ? GUI_EXE_NAME : entry);
    const stat = statSync(source);
    if (existsSync(dest)) {
      if (!force) continue;
      rmSync(dest, { recursive: true, force: true });
    }
    try {
      if (stat.isDirectory()) {
        cpSync(source, dest, { recursive: true, dereference: false });
      } else {
        linkSync(source, dest);
      }
      linked += 1;
    } catch (_) {
      cpSync(source, dest, { recursive: true });
      copied += 1;
    }
  }
  // Drop the pre-rename donor exe links so only one name ever exists in
  // app/gui. They are hard links to the donor's files — unlinking never
  // touches the donor.
  for (const name of DONOR_EXE_NAMES) {
    const staleExe = path.join(guiDir, name);
    if (existsSync(staleExe)) rmSync(staleExe, { force: true });
  }
  return { donor, linked, copied, guiDir, exe: path.join(guiDir, GUI_EXE_NAME) };
}
