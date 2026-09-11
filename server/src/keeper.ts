/**
 * Settlement keeper.
 *
 * Rewards accrue in USD and are converted per *ticker*, not per transaction.
 * A $4 coffee earns $0.12 — on Solana the fee to swap that alone is
 * negligible, but the slippage and min-out protection on a $0.12 order are
 * not. Batching by ticker is what makes 3% on a coffee economically real.
 *
 * In production `mockSwap` is a Jupiter quote + swap. Everything around it —
 * grouping, pricing, per-user legs, marking the ledger — is the same code.
 */

import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import * as ledger from "./ledger.ts";
import * as chain from "./chain.ts";
import { BY_TICKER, loadMints, quote } from "./tickers.ts";
import { log, publish } from "./bus.ts";

/** Don't bother swapping until a ticker has accumulated this much. */
export const MIN_BATCH_USD = Number(process.env.MIN_BATCH_USD ?? 1);

export interface SettleOutcome {
  settled: ledger.SettlementRow[];
  skipped: Array<{ ticker: string; usdTotal: number; reason: string }>;
}

/**
 * Stand-in for the Jupiter leg. Returns how many base units the batch buys at
 * the current mock quote.
 */
function mockSwap(ticker: string, usdTotal: number, decimals: number) {
  const price = quote(ticker);
  const tokens = usdTotal / price;
  return {
    price,
    tokenTotal: BigInt(Math.round(tokens * 10 ** decimals)),
    note: `mock swap: $${usdTotal.toFixed(2)} USDC -> ${tokens.toFixed(8)} ${ticker} @ $${price.toFixed(2)} (Jupiter in production)`,
  };
}

export async function runOnce(opts: { force?: boolean } = {}): Promise<SettleOutcome> {
  const mints = loadMints();
  const pending = ledger.pendingByTicker();
  const out: SettleOutcome = { settled: [], skipped: [] };

  for (const [ticker, auths] of pending) {
    const microTotal = auths.reduce((s, a) => s + a.rewardMicro, 0);
    const usdTotal = microTotal / 1e6;
    const def = BY_TICKER.get(ticker);
    const mintRec = mints.get(ticker);

    if (!def || !mintRec) {
      out.skipped.push({ ticker, usdTotal, reason: "no mock mint — run pnpm mint-tickers" });
      continue;
    }
    if (!opts.force && usdTotal < MIN_BATCH_USD) {
      out.skipped.push({
        ticker,
        usdTotal,
        reason: `below MIN_BATCH_USD ($${MIN_BATCH_USD.toFixed(2)}) — waiting for more spend`,
      });
      continue;
    }

    const swap = mockSwap(ticker, usdTotal, mintRec.decimals);
    log("info", `settling ${ticker}: ${auths.length} rewards, $${usdTotal.toFixed(2)}`);

    // Per-user legs. Token allocation is proportional to each user's share of
    // the batch, so rounding dust stays inside the batch rather than being
    // created out of thin air.
    const byUser = new Map<string, ledger.AuthRow[]>();
    for (const a of auths) {
      if (!byUser.has(a.userId)) byUser.set(a.userId, []);
      byUser.get(a.userId)!.push(a);
    }

    const legs: ledger.SettlementLeg[] = [];
    let tokensAssigned = 0n;
    const userIds = [...byUser.keys()];

    for (let i = 0; i < userIds.length; i++) {
      const userId = userIds[i];
      const rows = byUser.get(userId)!;
      const usdMicro = rows.reduce((s, a) => s + a.rewardMicro, 0);
      const usdAmount = usdMicro / 1e6;
      const isLast = i === userIds.length - 1;
      const tokenAmount = isLast
        ? swap.tokenTotal - tokensAssigned // last leg absorbs the dust
        : BigInt(Math.floor((Number(swap.tokenTotal) * usdAmount) / usdTotal));
      tokensAssigned += tokenAmount;

      const leg: ledger.SettlementLeg = {
        userId,
        usdMicro,
        usdAmount,
        tokenAmount: Number(tokenAmount),
        authIds: rows.map((r) => r.id),
      };

      const user = ledger.getUser(userId);
      if (!user) {
        leg.error = "unknown user";
        legs.push(leg);
        continue;
      }

      try {
        const sig = await chain.settleDistribute({
          owner: new PublicKey(user.pubkey),
          mint: new PublicKey(mintRec.mint),
          usdMicro,
          tokenAmount,
        });
        leg.sig = sig;
        for (const r of rows) {
          ledger.updateAuth(r.id, { status: "settled" });
        }
      } catch (err: any) {
        leg.error = err?.message ?? String(err);
        log("error", `settle leg failed (${ticker}/${user.label}): ${leg.error}`);
      }
      legs.push(leg);
    }

    const row = ledger.addSettlement({
      id: `stl_${randomUUID().slice(0, 8)}`,
      ticker,
      symbol: def.symbol,
      mint: mintRec.mint,
      price: swap.price,
      usdTotal,
      tokenTotal: Number(swap.tokenTotal),
      legs,
      swapNote: swap.note,
      ts: Date.now(),
    });

    for (const leg of legs) {
      if (leg.sig) {
        for (const id of leg.authIds) ledger.updateAuth(id, { settlementId: row.id });
      }
    }

    out.settled.push(row);
    publish({ type: "settled", payload: row });
  }

  return out;
}

let timer: NodeJS.Timeout | null = null;

export function start(intervalMs: number): void {
  if (timer) return;
  timer = setInterval(() => {
    runOnce().catch((err) => log("error", `keeper tick failed: ${err?.message ?? err}`));
  }, intervalMs);
  log("info", `keeper started, every ${Math.round(intervalMs / 1000)}s (MIN_BATCH_USD=$${MIN_BATCH_USD})`);
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
