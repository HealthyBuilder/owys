/**
 * Scripted end-to-end demo, no browser required.
 *
 *   spend -> resolve -> accrue on-chain -> batch-convert -> claim to the user's ATA
 *
 * Every step prints a devnet explorer link, because the entire pitch rests on
 * the tokens being real and the user owning them.
 */

import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as chain from "../server/src/chain.ts";
import * as ledger from "../server/src/ledger.ts";
import * as keeper from "../server/src/keeper.ts";
import * as users from "../server/src/users.ts";
import { handleAuthorization } from "../server/src/pipeline.ts";
import { buildAuthorization, findFixture, DEMO_SCRIPT } from "../server/src/cardSim.ts";
import { loadMints, quote } from "../server/src/tickers.ts";

const LABEL = process.env.DEMO_USER ?? "Demo Cardholder";

function rule(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m\n${"─".repeat(74)}`);
}

/**
 * The ledger is a JSON file and both this script and the server hold it in
 * memory, so running them at once means two writers clobbering each other —
 * duplicate cardholders, doubled authorizations, a merchant cache that looks
 * pre-warmed. Refuse rather than corrupt.
 */
async function assertServerNotRunning() {
  if (process.env.ALLOW_CONCURRENT === "1") return;
  try {
    const res = await fetch("http://127.0.0.1:4000/api/state", {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      console.error(
        "\nThe dashboard server is running on :4000 and shares this ledger file.\n" +
          "Stop it before running the demo, or the two processes will overwrite\n" +
          "each other's writes. (Set ALLOW_CONCURRENT=1 to override.)\n",
      );
      process.exit(1);
    }
  } catch {
    // nothing listening — good
  }
}

async function main() {
  await assertServerNotRunning();
  rule("0 · environment");
  const config = await chain.fetchConfig();
  if (!config) throw new Error("config PDA missing — run `pnpm run init-config`");
  console.log(`cluster   ${chain.CLUSTER}`);
  console.log(`program   ${chain.programId().toBase58()}`);
  console.log(`cashback  ${(config.rewardBps / 100).toFixed(2)}%`);
  console.log(`mints     ${loadMints().size} mock tickers`);

  rule("1 · cardholder");
  const user = await users.ensureUser(LABEL);
  console.log(`${user.label}  card ••${user.cardLast4}`);
  console.log(`wallet    ${user.pubkey}`);
  console.log(`          ${chain.explorer("address", user.pubkey)}`);

  rule("2 · spend — 8 authorizations through the resolver");
  for (const step of DEMO_SCRIPT) {
    const fixture = findFixture(step.descriptor);
    if (!fixture) throw new Error(`unknown fixture ${step.descriptor}`);
    const auth = buildAuthorization(fixture, { amountUsd: step.amountUsd });
    const res = await handleAuthorization(auth, user.id, { sync: true });
    if (res.duplicate || !res.auth) continue;

    const r = res.auth.resolution;
    console.log(
      `\n  ${step.descriptor}  $${step.amountUsd.toFixed(2)}  MCC ${fixture.mcc}`,
    );
    console.log(`    → ${r.payoutTicker.padEnd(6)} ${r.payoutName}`);
    console.log(`    → +$${res.auth.rewardUsd.toFixed(2)}  [${r.stage}, conf ${r.confidence.toFixed(2)}]`);
    if (r.company && r.ticker && !r.tickerTokenized) {
      console.log(`    ! identified ${r.company} (${r.ticker}) but it is not tokenized here`);
    }
    if (r.proxy) console.log(`    ! proxy exposure, not the brand itself`);
    if (res.accrueSig) console.log(`    tx ${chain.explorer("tx", res.accrueSig)}`);
    if (res.accrueError) console.log(`    accrue FAILED: ${res.accrueError}`);
  }

  rule("3 · idempotency — replay the last webhook");
  const last = ledger.authsForUser(user.id)[0];
  const replay = await handleAuthorization(
    {
      id: last.id,
      amountUsd: last.amountUsd,
      merchantName: last.merchantName,
      mcc: last.mcc,
      networkId: last.networkId,
    },
    user.id,
    { sync: true },
  );
  console.log(
    replay.duplicate
      ? `  same card_tx_id refused off-chain (the Accrual PDA would also refuse it)`
      : `  !! replay was accepted — this is a bug`,
  );

  rule("4 · keeper — one swap per ticker, not per swipe");
  const outcome = await keeper.runOnce({ force: true });
  for (const s of outcome.settled) {
    console.log(`\n  ${s.symbol}  $${s.usdTotal.toFixed(2)} @ $${s.price.toFixed(2)}`);
    console.log(`    ${s.swapNote}`);
    for (const leg of s.legs) {
      console.log(
        leg.sig
          ? `    leg ${(leg.tokenAmount / 1e8).toFixed(8)} ${s.symbol} → ${chain.explorer("tx", leg.sig)}`
          : `    leg FAILED: ${leg.error}`,
      );
    }
  }
  for (const s of outcome.skipped) console.log(`  skipped ${s.ticker}: ${s.reason}`);

  rule("5 · portfolio — read back from chain");
  const positions = await chain.fetchPositions(new PublicKey(user.pubkey));
  const mints = loadMints();
  const byMint = new Map([...mints.values()].map((m) => [m.mint, m]));
  let totalValue = 0;
  console.log(`  ${"SYMBOL".padEnd(8)}${"SHARES".padStart(14)}${"VALUE".padStart(11)}   POSITION PDA`);
  for (const p of positions.sort((a, b) => Number(b.distributedTokens - a.distributedTokens))) {
    const rec = byMint.get(p.mint);
    const ticker = rec?.ticker ?? p.symbol.replace(/x$/, "");
    const shares = Number(p.distributedTokens) / 10 ** (rec?.decimals ?? 8);
    const value = shares * quote(ticker);
    totalValue += value;
    console.log(
      `  ${p.symbol.padEnd(8)}${shares.toFixed(8).padStart(14)}${("$" + value.toFixed(2)).padStart(11)}   ${p.address.slice(0, 12)}…`,
    );
  }
  console.log(`\n  portfolio value  $${totalValue.toFixed(2)}`);
  const onChainUser = await chain.fetchUserAccount(new PublicKey(user.pubkey));
  if (onChainUser) {
    console.log(
      `  on-chain totals  spent $${(Number(onChainUser.totalSpentUsd) / 1e6).toFixed(2)} · ` +
        `earned $${(Number(onChainUser.totalRewardedUsd) / 1e6).toFixed(2)} · ` +
        `${onChainUser.txCount} authorizations`,
    );
  }

  rule("6 · claim — tokens move into the user's own ATA");
  const biggest = positions
    .filter((p) => p.distributedTokens > p.claimedTokens)
    .sort((a, b) => Number(b.distributedTokens - a.distributedTokens))[0];
  if (!biggest) {
    console.log("  nothing to claim");
  } else {
    const rec = byMint.get(biggest.mint)!;
    const sig = await chain.claim(users.keypairFor(user.id), new PublicKey(biggest.mint));
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(biggest.mint),
      new PublicKey(user.pubkey),
    );
    const acct = await getAccount(chain.connection, ata);
    console.log(`  claimed ${biggest.symbol}`);
    console.log(`  tx      ${chain.explorer("tx", sig)}`);
    console.log(`  balance ${(Number(acct.amount) / 10 ** rec.decimals).toFixed(8)} ${rec.symbol}`);
    console.log(`  ATA     ${chain.explorer("address", ata.toBase58())}`);
    console.log(`\n  This is the whole product: the user spent money at Nike and now holds`);
    console.log(`  Nike shares in a wallet only they control.`);
  }

  rule("7 · resolution mix");
  const s = ledger.stats();
  console.log(`  spend        $${s.spendUsd.toFixed(2)} over ${s.authorizations} authorizations`);
  console.log(`  rewards      $${s.rewardUsd.toFixed(2)} (settled $${s.settledUsd.toFixed(2)})`);
  console.log(`  brand hit    ${(s.brandHitRateBySpend * 100).toFixed(0)}% of spend mapped to a specific listed company`);
  for (const [stage, v] of Object.entries(s.byStage).sort((a, b) => b[1].spendUsd - a[1].spendUsd)) {
    console.log(`    ${stage.padEnd(18)} ${v.count} tx  $${v.spendUsd.toFixed(2)}`);
  }
  console.log(`\n  dashboard: pnpm server  →  http://127.0.0.1:4000\n`);
}

main()
  .then(() => process.exit(0)) // devnet websocket subscriptions keep the loop alive otherwise
  .catch((err) => {
    console.error(`\n${err?.stack ?? err}`);
    process.exit(1);
  });
