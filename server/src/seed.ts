/**
 * Restore a demo dataset when the ledger is empty.
 *
 * Cloud Run scales to zero and its filesystem is a tmpfs, so a cold start wipes
 * every cardholder and purchase. On-chain state survives — positions, accruals
 * and claimed tokens are all still there — but a dashboard that has forgotten
 * them shows an empty demo. Seeding on an empty ledger brings the view back.
 *
 * The seed stores the raw authorizations, not their resolutions. Replaying them
 * through the resolver in chronological order rebuilds the traces, the
 * confidence scores and the merchant cache exactly as they happened, and keeps
 * a seed valid when the brand table changes underneath it.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Keypair } from "@solana/web3.js";
import * as ledger from "./ledger.ts";
import { CACHE_THRESHOLD, resolveMerchant } from "./merchantResolver.ts";
import { REWARD_BPS } from "./pipeline.ts";
import { USD_UNIT } from "./chain.ts";
import { ROOT, dataPath } from "./paths.ts";
import { log } from "./bus.ts";

export interface SeedAuth {
  id: string;
  userId: string;
  amountUsd: number;
  merchantName: string;
  mcc: number;
  networkId: string;
  ts: number;
  status: ledger.AuthStatus;
  accrueSig?: string;
  settlementId?: string;
}

export interface Seed {
  users: Array<{
    id: string;
    label: string;
    secretKey: number[];
    cardLast4: string;
    createdAt: number;
    availableUsd: number;
  }>;
  auths: SeedAuth[];
  settlements: ledger.SettlementRow[];
}

/** Accepts raw JSON, base64 JSON, or base64 of gzipped JSON. */
function decodeSeed(value: string): Seed {
  if (value.startsWith("{")) return JSON.parse(value) as Seed;
  const bytes = Buffer.from(value, "base64");
  // gzip magic — the seed outgrows Secret Manager's 64 KiB limit uncompressed.
  const json = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? zlib.gunzipSync(bytes).toString("utf8")
    : bytes.toString("utf8");
  return JSON.parse(json) as Seed;
}

function readSeed(): Seed | null {
  const inline = process.env.SEED_JSON?.trim();
  if (inline) {
    try {
      return decodeSeed(inline);
    } catch (err: any) {
      log("error", `SEED_JSON could not be parsed: ${err?.message ?? err}`);
      return null;
    }
  }
  const file = process.env.SEED_FILE ?? path.join(ROOT, "seed", "demo-data.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Seed;
}

export function maybeSeed(): void {
  if (!ledger.isEmpty()) return;
  const seed = readSeed();
  if (!seed) return;

  // Cardholder keypairs have to be on disk for `claim` to sign.
  fs.writeFileSync(
    dataPath(".demo-users.json"),
    JSON.stringify(
      seed.users.map((u) => ({
        id: u.id,
        label: u.label,
        secretKey: u.secretKey,
        cardLast4: u.cardLast4,
      })),
      null,
      2,
    ),
  );

  const users: ledger.UserRow[] = seed.users.map((u) => ({
    id: u.id,
    label: u.label,
    pubkey: Keypair.fromSecretKey(Uint8Array.from(u.secretKey)).publicKey.toBase58(),
    cardLast4: u.cardLast4,
    createdAt: u.createdAt,
    availableUsd: u.availableUsd,
  }));

  // Replay oldest first so the merchant cache warms the way it originally did
  // and the resolution mix reflects real history rather than a cold run.
  const cache = new Map<string, string>();
  const cacheRows: Record<string, { brand: string; hits: number; firstSeen: number }> = {};
  const auths: ledger.AuthRow[] = [];

  for (const a of [...seed.auths].sort((x, y) => x.ts - y.ts)) {
    const resolution = resolveMerchant(
      {
        id: a.id,
        amountUsd: a.amountUsd,
        merchantName: a.merchantName,
        mcc: a.mcc,
        networkId: a.networkId,
      },
      { networkIdCache: cache },
    );
    const rewardMicro =
      a.status === "declined"
        ? 0
        : Math.floor((Math.round(a.amountUsd * USD_UNIT) * REWARD_BPS) / 10_000);

    auths.push({
      id: a.id,
      userId: a.userId,
      amountUsd: a.amountUsd,
      merchantName: a.merchantName,
      mcc: a.mcc,
      networkId: a.networkId,
      ts: a.ts,
      rewardMicro,
      rewardUsd: rewardMicro / USD_UNIT,
      resolution,
      status: a.status,
      accrueSig: a.accrueSig,
      settlementId: a.settlementId,
    });

    if (resolution.brand && resolution.confidence >= CACHE_THRESHOLD) {
      cache.set(a.networkId, resolution.brand);
      const row = cacheRows[a.networkId];
      if (row) row.hits += 1;
      else cacheRows[a.networkId] = { brand: resolution.brand, hits: 1, firstSeen: a.ts };
    }
  }

  ledger.replaceAll({
    users,
    auths,
    settlements: seed.settlements,
    networkIdCache: cacheRows,
  });
  log("info", `seeded ${users.length} cardholders and ${auths.length} purchases`);
}
