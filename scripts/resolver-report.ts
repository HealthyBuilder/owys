/**
 * Run the resolver over every merchant fixture and print a coverage table.
 *
 * No chain calls — this is the loop you actually iterate in when tuning
 * `brands.ts`. Point it at an anonymized sample of real descriptors and the
 * bottom line is the product's true ceiling.
 */

import { resolveMerchant } from "../server/src/merchantResolver.ts";
import { MERCHANT_POOL, buildAuthorization } from "../server/src/cardSim.ts";
import { MCC_LABELS } from "../server/src/brands.ts";

const STAGE_ORDER = [
  "network_id_cache", "brand_exact", "brand_fuzzy", "proxy", "sector_etf", "index_fallback",
] as const;

const rows = MERCHANT_POOL.map((fixture) => {
  const auth = buildAuthorization(fixture, { amountUsd: (fixture.range[0] + fixture.range[1]) / 2 });
  const r = resolveMerchant(auth, { networkIdCache: new Map() });
  return { fixture, auth, r };
});

const W = 26;
console.log(
  `\n${"DESCRIPTOR".padEnd(W)} ${"NORMALIZED".padEnd(22)} ${"PAYOUT".padEnd(7)} ${"STAGE".padEnd(16)} CONF  IDENTIFIED`,
);
console.log("─".repeat(124));

for (const { fixture, r } of rows) {
  const identified = r.company
    ? `${r.company}${r.ticker ? ` (${r.ticker})` : ""}${r.tickerTokenized ? "" : " ✗untokenized"}`
    : "—";
  console.log(
    `${fixture.descriptor.slice(0, W).padEnd(W)} ${r.normalized.slice(0, 22).padEnd(22)} ` +
      `${r.payoutTicker.padEnd(7)} ${r.stage.padEnd(16)} ${r.confidence.toFixed(2)}  ${identified}`,
  );
}

// -------------------------------------------------------------- aggregates --

const byStage = new Map<string, number>();
for (const { r } of rows) byStage.set(r.stage, (byStage.get(r.stage) ?? 0) + 1);

console.log(`\nBY STAGE (${rows.length} fixtures, cold cache)`);
for (const s of STAGE_ORDER) {
  const n = byStage.get(s) ?? 0;
  if (!n) continue;
  console.log(`  ${s.padEnd(18)} ${String(n).padStart(3)}  ${"█".repeat(n)}`);
}

const specific = rows.filter((x) => ["brand_exact", "brand_fuzzy", "network_id_cache"].includes(x.r.stage));
const identifiedButNot = rows.filter((x) => x.r.company && !x.r.tickerTokenized);
const noCompany = rows.filter((x) => !x.r.company);

console.log(`\nCOVERAGE`);
console.log(`  resolved to a tokenized listed company   ${specific.length}/${rows.length}  (${((specific.length / rows.length) * 100).toFixed(0)}%)`);
console.log(`  identified the company but no token       ${identifiedButNot.length}/${rows.length}  ← widen the tokenized universe`);
console.log(`  no company exists to identify            ${noCompany.length}/${rows.length}  ← irreducible; fallback ladder handles it`);

if (identifiedButNot.length) {
  console.log(`\nMISSING FROM THE TOKENIZED UNIVERSE (add these to grow coverage)`);
  const missing = new Map<string, string>();
  for (const { r } of identifiedButNot) if (r.ticker) missing.set(r.ticker, r.company!);
  for (const [t, c] of [...missing].sort()) console.log(`  ${t.padEnd(8)} ${c}`);
  const unlisted = identifiedButNot.filter((x) => !x.r.ticker);
  if (unlisted.length) {
    console.log(`\nNOT PUBLICLY LISTED AT ALL (no amount of tokenization fixes these)`);
    for (const { r } of unlisted) console.log(`  ${r.brand?.padEnd(18)} ${r.company}`);
  }
}

const mccOnly = rows.filter((x) => x.r.stage === "sector_etf" || x.r.stage === "index_fallback");
console.log(`\nFELL TO A FALLBACK RUNG (${mccOnly.length})`);
for (const { fixture, r } of mccOnly) {
  console.log(`  ${fixture.descriptor.padEnd(W)} MCC ${String(fixture.mcc).padEnd(5)} ${(MCC_LABELS[fixture.mcc] ?? "unmapped").padEnd(20)} -> ${r.payoutTicker}`);
}
console.log();
