/**
 * Mock card network.
 *
 * Emits authorizations shaped like a Stripe Issuing `issuing_authorization`
 * webhook, because that is the sandbox a real PoC would point at next — the
 * server's webhook handler is written against this shape, so swapping in the
 * real sandbox means deleting this file, not rewriting the handler.
 *
 * The descriptors are deliberately ugly. Every one of these forms appears in
 * real card data, and each exercises a different rung of the resolver.
 */

import { randomUUID } from "node:crypto";
import type { CardAuthorization } from "./merchantResolver.ts";

export interface MerchantFixture {
  descriptor: string;
  mcc: number;
  networkId: string;
  /** Typical ticket size range in dollars. */
  range: [number, number];
  weight: number;
  /** What this fixture is here to demonstrate. */
  demonstrates?: string;
}

export const MERCHANT_POOL: MerchantFixture[] = [
  { descriptor: "STARLINK INTERNET", mcc: 4899, networkId: "4055500102030", range: [120, 120], weight: 2,
    demonstrates: "a private company — tokenized by Sunrise, holdable in no brokerage account" },
  { descriptor: "NIKE.COM 8006536453", mcc: 5661, networkId: "4055500100001", range: [65, 240], weight: 4,
    demonstrates: "xStocks has no NKE; Ondo does — issuer routing doing the work" },
  { descriptor: "PAYPAL *NIKESTORE", mcc: 5661, networkId: "4055500100002", range: [40, 160], weight: 2,
    demonstrates: "processor prefix must be stripped or the reward goes to PayPal" },
  { descriptor: "SQ *BLUE BOTTLE COFFEE", mcc: 5814, networkId: "4055500100003", range: [5, 14], weight: 4,
    demonstrates: "Square prefix, and the parent is a Nestle ADR no issuer tokenizes" },
  { descriptor: "WHOLEFDS MKT #10255", mcc: 5411, networkId: "4055500100004", range: [22, 130], weight: 5,
    demonstrates: "brand name finds nothing; the parent is Amazon" },
  { descriptor: "AMZN Mktp US*2L4XY9", mcc: 5942, networkId: "4055500100005", range: [12, 210], weight: 6 },
  { descriptor: "TST* CHIPOTLE 2841", mcc: 5814, networkId: "4055500100006", range: [11, 32], weight: 4,
    demonstrates: "Toast prefix" },
  { descriptor: "SBUX STORE 08842", mcc: 5814, networkId: "4055500100007", range: [4, 18], weight: 6,
    demonstrates: "the most-swiped brand in the pool; reachable only via Ondo" },
  { descriptor: "MCDONALD'S F12345", mcc: 5814, networkId: "4055500100008", range: [6, 24], weight: 4 },
  { descriptor: "DUNKIN #336781 Q35", mcc: 5814, networkId: "4055500100009", range: [4, 15], weight: 3,
    demonstrates: "taken private in 2020 — there is genuinely no stock to give" },
  { descriptor: "TRADER JOE S #145", mcc: 5411, networkId: "4055500100010", range: [18, 95], weight: 4,
    demonstrates: "privately held — and no issuer offers a staples basket to fall back to" },
  { descriptor: "COSTCO WHSE #1234", mcc: 5300, networkId: "4055500100011", range: [80, 420], weight: 4 },
  { descriptor: "TARGET 00024412", mcc: 5310, networkId: "4055500100012", range: [20, 180], weight: 4 },
  { descriptor: "UBER   *EATS", mcc: 5812, networkId: "4055500100013", range: [15, 55], weight: 5 },
  { descriptor: "UBER TRIP HELP.UBER.COM", mcc: 4121, networkId: "4055500100014", range: [9, 48], weight: 4 },
  { descriptor: "DOORDASH*BURGER KING", mcc: 5814, networkId: "4055500100015", range: [14, 40], weight: 2,
    demonstrates: "two brands in one descriptor — merchant of record vs. where you actually ate" },
  { descriptor: "NETFLIX.COM", mcc: 5818, networkId: "4055500100016", range: [15.49, 22.99], weight: 3 },
  { descriptor: "SPOTIFY USA", mcc: 5818, networkId: "4055500100017", range: [11.99, 16.99], weight: 3,
    demonstrates: "Spotify is on Ondo but not xStocks — one catalogue is not enough" },
  { descriptor: "APPLE.COM/BILL", mcc: 5817, networkId: "4055500100018", range: [0.99, 99], weight: 5 },
  { descriptor: "GOOGLE *YOUTUBEPREMIUM", mcc: 5818, networkId: "4055500100019", range: [13.99, 22.99], weight: 3 },
  { descriptor: "OPENAI CHATGPT SUBSCR", mcc: 7372, networkId: "4055500100020", range: [20, 200], weight: 3,
    demonstrates: "unlisted — proxy exposure via MSFT, its largest investor, flagged as proxy" },
  { descriptor: "TESLA SUPERCHARGER US", mcc: 5552, networkId: "4055500100021", range: [12, 38], weight: 3 },
  { descriptor: "SHELL OIL 57442136", mcc: 5541, networkId: "4055500100022", range: [35, 95], weight: 4,
    demonstrates: "Shell reached through Ondo; no issuer here offers an energy basket" },
  { descriptor: "DELTA AIR 0062314", mcc: 4511, networkId: "4055500100023", range: [180, 780], weight: 2 },
  { descriptor: "MARSHALLS #0871", mcc: 5651, networkId: "4055500100024", range: [25, 140], weight: 2,
    demonstrates: "TJX banner" },
  { descriptor: "JOE'S CORNER DELI", mcc: 5812, networkId: "4055500100025", range: [8, 26], weight: 5,
    demonstrates: "no company exists — the honest majority of small-merchant spend" },
  { descriptor: "CITY OF OAKLAND PARKING", mcc: 9399, networkId: "4055500100026", range: [3, 12], weight: 3,
    demonstrates: "no company and no basket — falls all the way to the index" },
  { descriptor: "LYFT   *RIDE THU 6PM", mcc: 4121, networkId: "4055500100027", range: [11, 44], weight: 3,
    demonstrates: "absent from xStocks, reached through Ondo" },
  { descriptor: "HOME DEPOT #6172", mcc: 5200, networkId: "4055500100028", range: [30, 320], weight: 3 },
  { descriptor: "ANTHROPIC CLAUDE.AI", mcc: 7372, networkId: "4055500100029", range: [20, 100], weight: 2,
    demonstrates: "unlisted — proxy exposure, flagged" },
  { descriptor: "GEICO  *AUTO PREMIUM", mcc: 6300, networkId: "4055500100030", range: [98, 215], weight: 3,
    demonstrates: "an insurance premium buys Berkshire Hathaway — the parent map earning its keep" },
  { descriptor: "DQ GRILL CHILL #4471", mcc: 5814, networkId: "4055500100031", range: [7, 22], weight: 2,
    demonstrates: "also Berkshire — two descriptors that look unrelated, one ticker" },
  { descriptor: "EXXONMOBIL 9871234", mcc: 5541, networkId: "4055500100032", range: [32, 88], weight: 3 },
  { descriptor: "XFINITY MOBILE", mcc: 4899, networkId: "4055500100033", range: [45, 160], weight: 3,
    demonstrates: "the descriptor never says Comcast" },
  { descriptor: "GAMESTOP #2213", mcc: 5734, networkId: "4055500100034", range: [18, 95], weight: 2 },
];

/**
 * Ordered walk-through for the 3-minute demo.
 *
 * Chosen to exercise all three issuers, both parent-company mappings, the proxy
 * rung, and three merchants that miss for three different reasons. A demo that
 * only shows the happy path hides the constraint that decides whether this
 * product works.
 */
export const DEMO_SCRIPT: Array<{ descriptor: string; amountUsd: number }> = [
  { descriptor: "NIKE.COM 8006536453", amountUsd: 120 },      // Ondo
  { descriptor: "WHOLEFDS MKT #10255", amountUsd: 86.4 },     // xStocks, via parent
  { descriptor: "GEICO  *AUTO PREMIUM", amountUsd: 142 },     // xStocks, via parent
  { descriptor: "STARLINK INTERNET", amountUsd: 120 },        // Sunrise — private company
  { descriptor: "OPENAI CHATGPT SUBSCR", amountUsd: 200 },    // proxy
  { descriptor: "SQ *BLUE BOTTLE COFFEE", amountUsd: 7.25 },  // miss: ADR
  { descriptor: "DUNKIN #336781 Q35", amountUsd: 6.5 },       // miss: taken private
  { descriptor: "CITY OF OAKLAND PARKING", amountUsd: 4.5 },  // miss: no company
];

function pickWeighted(pool: MerchantFixture[]): MerchantFixture {
  const total = pool.reduce((s, m) => s + m.weight, 0);
  let r = Math.random() * total;
  for (const m of pool) {
    r -= m.weight;
    if (r <= 0) return m;
  }
  return pool[pool.length - 1];
}

function amountIn([lo, hi]: [number, number]): number {
  if (lo === hi) return lo;
  return Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
}

export function findFixture(descriptor: string): MerchantFixture | undefined {
  return MERCHANT_POOL.find((m) => m.descriptor === descriptor);
}

/** A Stripe-Issuing-shaped authorization for one merchant fixture. */
export function buildAuthorization(
  fixture: MerchantFixture,
  opts: { amountUsd?: number; last4?: string } = {},
): CardAuthorization {
  return {
    id: `iauth_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    amountUsd: opts.amountUsd ?? amountIn(fixture.range),
    merchantName: fixture.descriptor,
    mcc: fixture.mcc,
    networkId: fixture.networkId,
    city: "OAKLAND",
    country: "US",
    last4: opts.last4 ?? "4242",
  };
}

export function randomAuthorization(opts: { last4?: string } = {}): CardAuthorization {
  return buildAuthorization(pickWeighted(MERCHANT_POOL), opts);
}
