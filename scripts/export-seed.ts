/**
 * Snapshot the current ledger into a seed the server can restore on an empty
 * start. Resolutions are dropped — the loader replays them through the
 * resolver, so the seed stays valid as the brand table changes.
 */

import fs from "node:fs";
import path from "node:path";
import * as ledger from "../server/src/ledger.ts";
import { keypairFor } from "../server/src/users.ts";
import { ROOT } from "../server/src/paths.ts";
import type { Seed } from "../server/src/seed.ts";

const OUT = process.env.SEED_OUT ?? path.join(ROOT, "seed", "demo-data.json");

const users = ledger.listUsers();
if (!users.length) {
  console.error("ledger is empty — run `pnpm demo-data` first");
  process.exit(1);
}

const seed: Seed = {
  users: users.map((u) => ({
    id: u.id,
    label: u.label,
    secretKey: Array.from(keypairFor(u.id).secretKey),
    cardLast4: u.cardLast4,
    createdAt: u.createdAt,
    availableUsd: u.availableUsd,
  })),
  auths: ledger.listAuths(10_000).map((a) => ({
    id: a.id,
    userId: a.userId,
    amountUsd: a.amountUsd,
    merchantName: a.merchantName,
    mcc: a.mcc,
    networkId: a.networkId,
    ts: a.ts,
    status: a.status,
    accrueSig: a.accrueSig,
    settlementId: a.settlementId,
  })),
  settlements: ledger.listSettlements(10_000),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(seed));
const bytes = fs.statSync(OUT).size;
console.log(`wrote ${OUT}`);
console.log(`  ${seed.users.length} cardholders · ${seed.auths.length} purchases · ${seed.settlements.length} settlements`);
console.log(`  ${(bytes / 1024).toFixed(1)} KB`);
console.log(`\nThis file contains cardholder PRIVATE KEYS — it is gitignored.`);
