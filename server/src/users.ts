/**
 * Demo cardholders.
 *
 * Each user is a real Solana keypair held locally, so `claim` is signed by the
 * user and the tokens land in an ATA they own — the "own a piece of it" claim
 * has to be literally true or the demo is a lie.
 *
 * Production replaces this file with an embedded-wallet provider (Privy,
 * Turnkey) and a fee payer, so users never see a keypair or need SOL.
 */

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import * as chain from "./chain.ts";
import * as ledger from "./ledger.ts";
import { log } from "./bus.ts";
import { dataPath } from "./paths.ts";

const KEY_FILE = dataPath(".demo-users.json");

/** Enough for the user PDA plus a few claim ATAs. */
const FUND_SOL = 0.02;

interface StoredUser {
  id: string;
  label: string;
  secretKey: number[];
  cardLast4: string;
}

function read(): StoredUser[] {
  if (!fs.existsSync(KEY_FILE)) return [];
  return JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
}

function write(users: StoredUser[]): void {
  fs.writeFileSync(`${KEY_FILE}.tmp`, JSON.stringify(users, null, 2));
  fs.renameSync(`${KEY_FILE}.tmp`, KEY_FILE);
}

const cache = new Map<string, Keypair>();

export function keypairFor(userId: string): Keypair {
  if (cache.has(userId)) return cache.get(userId)!;
  const stored = read().find((u) => u.id === userId);
  if (!stored) throw new Error(`no keypair for user ${userId}`);
  const kp = Keypair.fromSecretKey(Uint8Array.from(stored.secretKey));
  cache.set(userId, kp);
  return kp;
}

function randomLast4(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export async function createUser(label: string): Promise<ledger.UserRow> {
  const kp = Keypair.generate();
  const id = `usr_${randomUUID().slice(0, 8)}`;
  const cardLast4 = randomLast4();

  const stored = read();
  stored.push({ id, label, secretKey: Array.from(kp.secretKey), cardLast4 });
  write(stored);
  cache.set(id, kp);

  log("info", `funding ${label} (${kp.publicKey.toBase58().slice(0, 8)}…) with ${FUND_SOL} SOL`);
  await chain.ensureFunded(kp.publicKey, FUND_SOL);

  if (!(await chain.userAccountExists(kp.publicKey))) {
    const sig = await chain.openUser(kp);
    log("info", `open_user ${label}: ${sig.slice(0, 10)}…`);
  }

  return ledger.addUser({
    id,
    label,
    pubkey: kp.publicKey.toBase58(),
    cardLast4,
    createdAt: Date.now(),
    availableUsd: ledger.STARTING_BALANCE_USD,
  });
}

/** Idempotent: returns the existing user with this label, or creates one. */
export async function ensureUser(label: string): Promise<ledger.UserRow> {
  const existing = ledger.listUsers().find((u) => u.label === label);
  if (existing) return existing;
  return createUser(label);
}
