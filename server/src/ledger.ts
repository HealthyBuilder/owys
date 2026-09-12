/**
 * The off-chain ledger.
 *
 * A JSON file, because this is an all-mock PoC and a native SQLite build is a
 * dependency we do not need. Every access goes through this module, so the
 * swap to Postgres later is one file.
 *
 * The important property is not the storage engine — it is that the card
 * transaction id is the primary key everywhere, matching the on-chain
 * `Accrual` PDA seed. Off-chain and on-chain de-dupe on the same key.
 */

import fs from "node:fs";
import type { Resolution, CardAuthorization } from "./merchantResolver.ts";
import { dataPath } from "./paths.ts";

const DB_FILE = dataPath("ledger.json");

/** What a new card is funded with, in the absence of a real USDC deposit flow. */
export const STARTING_BALANCE_USD = 2_500;

export interface UserRow {
  id: string;
  label: string;
  pubkey: string;
  cardLast4: string;
  createdAt: number;
  /**
   * Prefunded spending power, in dollars. Off-chain only: this PoC has no USDC
   * spend vault, so the balance is a mock. It is still load-bearing — an
   * authorization above it is declined, which is what makes the webhook return
   * a real approve/decline decision rather than always approving.
   */
  availableUsd: number;
}

export type AuthStatus = "declined" | "resolved" | "accrued" | "settled";

export interface AuthRow {
  /** Card-network transaction id — the idempotency key. */
  id: string;
  userId: string;
  amountUsd: number;
  merchantName: string;
  mcc: number;
  networkId: string;
  city?: string;
  country?: string;
  ts: number;
  /**
   * Authoritative reward, in integer micro-dollars, computed exactly the way
   * the program computes it: floor(spend_micro * bps / 10_000). Rounding this
   * to cents off-chain and summing the cents overshoots what the program
   * actually accrued, and settlement then fails with InsufficientAccrual.
   */
  rewardMicro: number;
  /** Display-only, derived from rewardMicro. */
  rewardUsd: number;
  resolution: Resolution;
  status: AuthStatus;
  accrueSig?: string;
  settlementId?: string;
}

export interface SettlementLeg {
  userId: string;
  /** Integer micro-dollars, matched to the on-chain accrual. */
  usdMicro: number;
  usdAmount: number;
  tokenAmount: number;
  authIds: string[];
  sig?: string;
  error?: string;
}

export interface SettlementRow {
  id: string;
  ticker: string;
  symbol: string;
  mint: string;
  price: number;
  usdTotal: number;
  tokenTotal: number;
  legs: SettlementLeg[];
  /** The mock stand-in for the Jupiter swap signature. */
  swapNote: string;
  ts: number;
}

interface Db {
  users: UserRow[];
  auths: AuthRow[];
  settlements: SettlementRow[];
  /** networkId -> brand, the stage-1 cache that makes resolution improve over time. */
  networkIdCache: Record<string, { brand: string; hits: number; firstSeen: number }>;
}

const EMPTY: Db = { users: [], auths: [], settlements: [], networkIdCache: {} };

let db: Db = load();

function load(): Db {
  if (!fs.existsSync(DB_FILE)) return structuredClone(EMPTY);
  try {
    const loaded = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) } as Db;
    // Backfill balances for cardholders created before funding existed.
    for (const u of loaded.users) {
      if (typeof u.availableUsd !== "number") u.availableUsd = STARTING_BALANCE_USD;
    }
    return loaded;
  } catch {
    return structuredClone(EMPTY);
  }
}

function persist(): void {
  fs.writeFileSync(`${DB_FILE}.tmp`, JSON.stringify(db, null, 2));
  fs.renameSync(`${DB_FILE}.tmp`, DB_FILE);
}

export function reset(): void {
  db = structuredClone(EMPTY);
  persist();
}

// ------------------------------------------------------------------- users --

export function addUser(row: UserRow): UserRow {
  db.users.push(row);
  persist();
  return row;
}

export function getUser(id: string): UserRow | undefined {
  return db.users.find((u) => u.id === id);
}

export function listUsers(): UserRow[] {
  return [...db.users];
}

/** Returns the new balance, or null when the user cannot cover the amount. */
export function debit(userId: string, amountUsd: number): number | null {
  const user = db.users.find((u) => u.id === userId);
  if (!user) return null;
  if (amountUsd > user.availableUsd) return null;
  user.availableUsd = Math.round((user.availableUsd - amountUsd) * 100) / 100;
  persist();
  return user.availableUsd;
}

export function topUp(userId: string, amountUsd: number): number {
  const user = db.users.find((u) => u.id === userId);
  if (!user) throw new Error(`no user ${userId}`);
  user.availableUsd = Math.round((user.availableUsd + amountUsd) * 100) / 100;
  persist();
  return user.availableUsd;
}

// ----------------------------------------------------------- authorizations --

export function hasAuth(id: string): boolean {
  return db.auths.some((a) => a.id === id);
}

export function addAuth(row: AuthRow): AuthRow {
  db.auths.push(row);
  persist();
  return row;
}

export function updateAuth(id: string, patch: Partial<AuthRow>): void {
  const row = db.auths.find((a) => a.id === id);
  if (!row) throw new Error(`no authorization ${id}`);
  Object.assign(row, patch);
  persist();
}

export function listAuths(limit = 200): AuthRow[] {
  return [...db.auths].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export function authsForUser(userId: string): AuthRow[] {
  return db.auths.filter((a) => a.userId === userId).sort((a, b) => b.ts - a.ts);
}

/**
 * Accrued-but-unsettled rewards, grouped by payout ticker. This is what the
 * keeper batches: one swap per ticker instead of one swap per $4 coffee.
 */
export function pendingByTicker(): Map<string, AuthRow[]> {
  const out = new Map<string, AuthRow[]>();
  for (const a of db.auths) {
    if (a.status !== "accrued") continue;
    const t = a.resolution.payoutTicker;
    if (!out.has(t)) out.set(t, []);
    out.get(t)!.push(a);
  }
  return out;
}

// ------------------------------------------------------------- settlements --

export function addSettlement(row: SettlementRow): SettlementRow {
  db.settlements.push(row);
  persist();
  return row;
}

export function listSettlements(limit = 100): SettlementRow[] {
  return [...db.settlements].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// ---------------------------------------------------------- merchant cache --

export function networkIdCache(): Map<string, string> {
  return new Map(Object.entries(db.networkIdCache).map(([k, v]) => [k, v.brand]));
}

export function cacheMerchant(networkId: string, brand: string): void {
  const existing = db.networkIdCache[networkId];
  if (existing) {
    existing.hits += 1;
    existing.brand = brand;
  } else {
    db.networkIdCache[networkId] = { brand, hits: 1, firstSeen: Date.now() };
  }
  persist();
}

export function cacheStats(): { merchants: number; hits: number } {
  const vals = Object.values(db.networkIdCache);
  return { merchants: vals.length, hits: vals.reduce((s, v) => s + v.hits, 0) };
}

// ------------------------------------------------------------------ stats --

export interface Stats {
  users: number;
  authorizations: number;
  spendUsd: number;
  rewardUsd: number;
  settledUsd: number;
  pendingUsd: number;
  /** Share of spend that resolved to a specific listed company (stages 1-3). */
  brandHitRateBySpend: number;
  byStage: Record<string, { count: number; spendUsd: number }>;
}

export function stats(): Stats {
  const auths = db.auths.filter((a) => a.status !== "declined");
  const spendUsd = auths.reduce((s, a) => s + a.amountUsd, 0);
  const rewardUsd = auths.reduce((s, a) => s + a.rewardUsd, 0);
  const settledUsd = auths
    .filter((a) => a.status === "settled")
    .reduce((s, a) => s + a.rewardUsd, 0);
  const byStage: Stats["byStage"] = {};
  let brandSpend = 0;
  for (const a of auths) {
    const st = a.resolution.stage;
    byStage[st] ??= { count: 0, spendUsd: 0 };
    byStage[st].count += 1;
    byStage[st].spendUsd += a.amountUsd;
    if (st === "network_id_cache" || st === "brand_exact" || st === "brand_fuzzy") {
      brandSpend += a.amountUsd;
    }
  }
  return {
    users: db.users.length,
    authorizations: auths.length,
    spendUsd,
    rewardUsd,
    settledUsd,
    pendingUsd: rewardUsd - settledUsd,
    brandHitRateBySpend: spendUsd > 0 ? brandSpend / spendUsd : 0,
    byStage,
  };
}

export type { CardAuthorization };
