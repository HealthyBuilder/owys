/**
 * Where mutable state lives.
 *
 * A container filesystem is read-only apart from /tmp, so the ledger and demo
 * keypairs cannot sit next to the source the way they do locally. DATA_DIR
 * decides; it defaults to the repo root for local runs and is set to a writable
 * path in the container image.
 *
 * On Cloud Run /tmp is an in-memory tmpfs: writes count against the instance's
 * memory and everything is lost on a cold start. That is acceptable for a demo
 * and unacceptable for anything else — see docs/DEPLOY.md.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : ROOT;

export function dataPath(name: string): string {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return path.join(DATA_DIR, name);
}
