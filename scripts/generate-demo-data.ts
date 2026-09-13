/**
 * Build a demo dataset worth showing.
 *
 * One afternoon of test taps does not demonstrate the product — the whole
 * pitch is "the portfolio your spending built", which needs weeks of history
 * across enough merchants that the allocation ring and the resolution mix say
 * something. This drives the real pipeline, so every reward here is a genuine
 * on-chain accrual; only the display timestamps are backdated.
 *
 *   pnpm demo-data            # default: 4 cardholders, ~6 weeks of history
 *   DAYS=90 USERS=3 pnpm demo-data
 *
 * Costs real devnet SOL: roughly 0.002 per purchase in rent for the accrual
 * account, plus 0.02 to fund each new cardholder.
 */

import { PublicKey } from "@solana/web3.js";
import * as chain from "../server/src/chain.ts";
import * as ledger from "../server/src/ledger.ts";
import * as keeper from "../server/src/keeper.ts";
import * as users from "../server/src/users.ts";
import { handleAuthorization } from "../server/src/pipeline.ts";
import { MERCHANT_POOL, buildAuthorization } from "../server/src/cardSim.ts";

const DAYS = Number(process.env.DAYS ?? 42);
const USER_COUNT = Number(process.env.USERS ?? 4);
const DAY = 86_400_000;

/**
 * Cardholders with distinguishable spending personalities, so switching
 * between them in the UI shows visibly different portfolios rather than four
 * samples of the same distribution.
 */
const PERSONAS: Array<{ label: string; weights: Record<string, number>; perWeek: number }> = [
  {
    label: "Maya Chen",
    perWeek: 9,
    weights: { "AMZN Mktp US*2L4XY9": 4, "WHOLEFDS MKT #10255": 3, "SBUX STORE 08842": 5,
      "APPLE.COM/BILL": 2, "NETFLIX.COM": 1, "UBER   *EATS": 3, "NIKE.COM 8006536453": 1,
      "SQ *BLUE BOTTLE COFFEE": 3, "TST* CHIPOTLE 2841": 2 },
  },
  {
    label: "Dan Okafor",
    perWeek: 7,
    weights: { "COSTCO WHSE #1234": 3, "SHELL OIL 57442136": 3, "HOME DEPOT #6172": 2,
      "MCDONALD'S F12345": 2, "GEICO  *AUTO PREMIUM": 1, "EXXONMOBIL 9871234": 2,
      "TARGET 00024412": 2, "DQ GRILL CHILL #4471": 1, "WALMART" : 0 },
  },
  {
    label: "Priya Raman",
    perWeek: 8,
    weights: { "OPENAI CHATGPT SUBSCR": 2, "ANTHROPIC CLAUDE.AI": 2, "GOOGLE *YOUTUBEPREMIUM": 1,
      "SPOTIFY USA": 1, "STARLINK INTERNET": 1, "XFINITY MOBILE": 1, "APPLE.COM/BILL": 3,
      "DOORDASH*BURGER KING": 2, "LYFT   *RIDE THU 6PM": 3, "GAMESTOP #2213": 1 },
  },
  {
    label: "Tom Alvarez",
    perWeek: 6,
    weights: { "DELTA AIR 0062314": 1, "MARSHALLS #0871": 2, "TRADER JOE S #145": 3,
      "DUNKIN #336781 Q35": 3, "JOE'S CORNER DELI": 4, "CITY OF OAKLAND PARKING": 3,
      "PAYPAL *NIKESTORE": 1, "TESLA SUPERCHARGER US": 2 },
  },
];

function pick<T>(weighted: Array<[T, number]>): T {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [item, w] of weighted) {
    r -= w;
    if (r <= 0) return item;
  }
  return weighted[weighted.length - 1][0];
}

/** Spending clusters around evenings and weekends; flat noise looks synthetic. */
function timestampWithin(dayOffset: number): number {
  const base = Date.now() - dayOffset * DAY;
  const d = new Date(base);
  const hour = pick<number>([[8, 2], [12, 4], [13, 3], [17, 2], [18, 5], [19, 4], [20, 3], [21, 2]]);
  d.setHours(hour, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);
  return d.getTime();
}

async function main() {
  const config = await chain.fetchConfig();
  if (!config) throw new Error("config PDA missing — run `pnpm run init-config`");

  const before = await chain.connection.getBalance(chain.wallet.publicKey);
  console.log(`treasury   ${(before / 1e9).toFixed(4)} SOL`);
  console.log(`generating ${USER_COUNT} cardholders over ${DAYS} days\n`);

  const personas = PERSONAS.slice(0, USER_COUNT);
  let created = 0;
  let declined = 0;

  for (const persona of personas) {
    const user = await users.ensureUser(persona.label);
    // Give the seeded personas room to spend a few weeks of history.
    ledger.topUp(user.id, 6_000);

    const entries = Object.entries(persona.weights).filter(([d, w]) =>
      w > 0 && MERCHANT_POOL.some((m) => m.descriptor === d),
    ) as Array<[string, number]>;

    const count = Math.round((DAYS / 7) * persona.perWeek);
    console.log(`${persona.label}  —  ${count} purchases`);

    for (let i = 0; i < count; i++) {
      const descriptor = pick(entries);
      const fixture = MERCHANT_POOL.find((m) => m.descriptor === descriptor)!;
      const dayOffset = Math.floor(Math.random() * DAYS);
      const auth = buildAuthorization(fixture);
      const res = await handleAuthorization(auth, user.id, {
        sync: true,
        ts: timestampWithin(dayOffset),
      });
      if (res.approved) created += 1;
      else declined += 1;
      if (res.accrueError) console.log(`  ! ${descriptor}: ${res.accrueError.slice(0, 70)}`);
      if ((i + 1) % 10 === 0) process.stdout.write(`    ${i + 1}/${count}\n`);
    }
  }

  console.log(`\nsettling…`);
  const outcome = await keeper.runOnce({ force: true });
  const legs = outcome.settled.reduce((s, x) => s + x.legs.filter((l) => l.sig).length, 0);
  console.log(`  ${outcome.settled.length} batches, ${legs} on-chain legs`);

  const after = await chain.connection.getBalance(chain.wallet.publicKey);
  const stats = ledger.stats();
  console.log(`\npurchases   ${created} approved, ${declined} declined`);
  console.log(`spend       $${stats.spendUsd.toFixed(2)}`);
  console.log(`rewards     $${stats.rewardUsd.toFixed(2)} (settled $${stats.settledUsd.toFixed(2)})`);
  console.log(`brand hit   ${(stats.brandHitRateBySpend * 100).toFixed(0)}% of spend`);
  console.log(`SOL spent   ${((before - after) / 1e9).toFixed(4)}`);
  console.log(`\nexport it with:  pnpm export-seed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n${err?.stack ?? err}`);
    process.exit(1);
  });
