/**
 * The authorization pipeline: resolve -> book -> accrue on-chain.
 *
 * Shared by the HTTP webhook handler and the CLI demo so there is exactly one
 * implementation of the thing the PoC is meant to prove.
 */

import { PublicKey } from "@solana/web3.js";
import * as ledger from "./ledger.ts";
import * as chain from "./chain.ts";
import { log, publish } from "./bus.ts";
import { CACHE_THRESHOLD, resolveMerchant, type CardAuthorization } from "./merchantResolver.ts";
import { loadMints } from "./tickers.ts";

export const REWARD_BPS = Number(process.env.REWARD_BPS ?? 300);

export interface HandleResult {
  duplicate: boolean;
  /** The decision a real issuer webhook has to return within ~2 seconds. */
  approved: boolean;
  declineReason?: string;
  auth?: ledger.AuthRow;
  accrueSig?: string;
  accrueError?: string;
}

/**
 * A real-time authorization webhook has roughly a 2-second budget to approve
 * or decline, which is not enough to also wait on a chain write. So the
 * decision and the off-chain booking are synchronous, and the on-chain accrual
 * is fired after, pushing its signature to the UI when it lands.
 *
 * `sync` waits for the chain write — used by scripted demos that need
 * deterministic output.
 */
export async function handleAuthorization(
  incoming: CardAuthorization,
  userId: string,
  opts: { sync?: boolean } = {},
): Promise<HandleResult> {
  // Same idempotency key as the on-chain Accrual PDA seed. Card networks
  // redeliver webhooks; both layers must refuse the second one.
  if (ledger.hasAuth(incoming.id)) {
    log("warn", `duplicate authorization ${incoming.id} ignored`);
    return { duplicate: true, approved: false, declineReason: "duplicate" };
  }

  const resolution = resolveMerchant(incoming, { networkIdCache: ledger.networkIdCache() });

  // Insufficient-funds decline. The card is prefunded, so this is the whole of
  // the authorization decision — and it has to happen before anything is
  // booked, or a declined purchase would still earn equity.
  const user = ledger.getUser(userId);
  if (!user) throw new Error(`no user ${userId}`);
  if (incoming.amountUsd > user.availableUsd) {
    const row = ledger.addAuth({
      id: incoming.id,
      userId,
      amountUsd: incoming.amountUsd,
      merchantName: incoming.merchantName,
      mcc: incoming.mcc,
      networkId: incoming.networkId,
      city: incoming.city,
      country: incoming.country,
      ts: Date.now(),
      rewardMicro: 0,
      rewardUsd: 0,
      resolution,
      status: "declined",
    });
    publish({ type: "authorization", payload: row });
    log("warn", `declined ${incoming.merchantName} $${incoming.amountUsd.toFixed(2)} — available $${user.availableUsd.toFixed(2)}`);
    return { duplicate: false, approved: false, declineReason: "insufficient funds", auth: row };
  }
  ledger.debit(userId, incoming.amountUsd);

  // Mirror the program's arithmetic exactly — integer micro-dollars, floored.
  // See AuthRow.rewardMicro for why cents are not good enough.
  const spendMicro = Math.round(incoming.amountUsd * chain.USD_UNIT);
  const rewardMicro = Math.floor((spendMicro * REWARD_BPS) / 10_000);
  const rewardUsd = rewardMicro / chain.USD_UNIT;

  const row = ledger.addAuth({
    id: incoming.id,
    userId,
    amountUsd: incoming.amountUsd,
    merchantName: incoming.merchantName,
    mcc: incoming.mcc,
    networkId: incoming.networkId,
    city: incoming.city,
    country: incoming.country,
    ts: Date.now(),
    rewardMicro,
    rewardUsd,
    resolution,
    status: "resolved",
  });

  if (resolution.brand && resolution.confidence >= CACHE_THRESHOLD) {
    ledger.cacheMerchant(incoming.networkId, resolution.brand);
  }

  publish({ type: "authorization", payload: row });
  log(
    "info",
    `${incoming.merchantName} $${incoming.amountUsd.toFixed(2)} -> ${resolution.payoutTicker} ` +
      `(${resolution.stage}, conf ${resolution.confidence.toFixed(2)})`,
  );

  const result: HandleResult = { duplicate: false, approved: true, auth: row };

  const accrue = async () => {
    try {
      const mint = loadMints().get(resolution.payoutTicker);
      if (!mint) throw new Error(`no mock mint for ${resolution.payoutTicker}`);
      const sig = await chain.accrueReward({
        owner: new PublicKey(user.pubkey),
        cardTxId: incoming.id,
        spendUsd: incoming.amountUsd,
        mint: new PublicKey(mint.mint),
        symbol: mint.symbol,
        merchant: incoming.merchantName,
        mcc: incoming.mcc,
      });
      ledger.updateAuth(incoming.id, { status: "accrued", accrueSig: sig });
      result.accrueSig = sig;
      publish({ type: "accrued", payload: { id: incoming.id, accrueSig: sig } });
      log("info", `accrued ${resolution.payoutTicker} $${rewardUsd.toFixed(2)} — ${sig.slice(0, 10)}…`);
    } catch (err: any) {
      result.accrueError = err?.message ?? String(err);
      log("error", `accrue failed for ${incoming.id}: ${result.accrueError}`);
    }
  };

  if (opts.sync) await accrue();
  else void accrue();

  return result;
}

export type { CardAuthorization };
