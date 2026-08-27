// Local auth token: the bridge WebSocket server only accepts connections from
// a bridge that knows this token. The token is regenerated per project install
// and stored under runtime/ (gitignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export function tokenPath(projectRoot) {
  return path.join(projectRoot, "runtime", "rmch.token");
}

export function getToken(projectRoot) {
  const file = tokenPath(projectRoot);
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    if (value) return value;
  }
  const token = randomBytes(24).toString("hex");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, token + "\n", "utf8");
  return token;
}
