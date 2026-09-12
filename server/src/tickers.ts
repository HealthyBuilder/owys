/**
 * The tokenized universe — every issuer putting equities on Solana, deduped.
 *
 * There is no single catalogue. As of 2026 the Solana equity token supply is
 * split across issuers with different lists, different symbol conventions and
 * different strengths, and a card product that settles in only one of them
 * inherits that one's blind spots:
 *
 *   xStocks (Backed)      ~55 stocks + 4 ETFs, `…x`. Index-shaped: heavy on
 *                         pharma, financials and enterprise software. Almost
 *                         no consumer brands — no NKE, SBUX, COST, UBER.
 *   Sunrise (w/ Backpack) 20 assets, plain tickers. Small but consumer-useful,
 *                         and the only route to SPCX (SpaceX), which is not
 *                         purchasable in any brokerage account.
 *   Ondo Global Markets   200+ US stocks and ETFs, `…on`. Largest by asset
 *                         count; carries the consumer brands the others miss.
 *
 * Only the mints are mock. Issuer membership is real, so the resolver's misses
 * are the misses a real multi-issuer card would have — see the coverage
 * section of the README.
 *
 * The Ondo block here is a *representative subset*, not their full 200+: it is
 * exactly the tickers this repo's brand table needs and the other two issuers
 * do not carry. ADRs (Nestlé, LVMH, Inditex, Fast Retailing) are deliberately
 * left out of all three — foreign brands reached through ADRs are a real
 * residual gap that no issuer on this list closes.
 *
 * Prices are fixed mock quotes. Production reads Pyth or an issuer oracle.
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.ts";

/** Read-only config baked into the image; not mutable state, so not DATA_DIR. */
export const TICKER_FILE = process.env.TICKER_FILE
  ? path.resolve(process.env.TICKER_FILE)
  : path.join(ROOT, ".mock-tickers.json");

export type Issuer = "xStocks" | "Sunrise" | "Ondo";

export const ISSUERS: Record<Issuer, { label: string; suffix: string; note: string }> = {
  xStocks: { label: "xStocks", suffix: "x", note: "Backed Finance, 1:1 backed, Swiss custody" },
  Sunrise: { label: "Sunrise", suffix: "", note: "with Backpack Securities; redeemable 1:1" },
  Ondo: { label: "Ondo Global Markets", suffix: "on", note: "backed by shares at US broker-dealers" },
};

/**
 * When more than one issuer carries a ticker, this order picks the token we
 * actually buy. In production this is a liquidity-routing decision made per
 * trade against live Jupiter quotes; here it is a fixed, stated preference.
 */
export const ISSUER_PREFERENCE: Issuer[] = ["xStocks", "Sunrise", "Ondo"];

export interface TickerDef {
  /** Real-world ticker, as the resolver produces it. */
  ticker: string;
  /** Onchain token symbol, following the chosen issuer's convention. */
  symbol: string;
  name: string;
  price: number;
  decimals: number;
  kind: "equity" | "etf";
  /** The issuer we settle in for this ticker. */
  issuer: Issuer;
  /** Other issuers that also carry it — routing options, not dead weight. */
  alsoOn: Issuer[];
}

type Row = [ticker: string, name: string, price: number, kind?: "etf"];

const XSTOCKS: Row[] = [
  ["SPY", "SPDR S&P 500 ETF", 621.3, "etf"],
  ["QQQ", "Invesco Nasdaq-100 ETF", 545.8, "etf"],
  ["VTI", "Vanguard Total Stock Market", 305.4, "etf"],
  ["GLD", "SPDR Gold Shares", 314.7, "etf"],
  ["AAPL", "Apple Inc.", 235.4],
  ["AMZN", "Amazon.com Inc.", 221.6],
  ["GOOGL", "Alphabet Inc.", 196.2],
  ["META", "Meta Platforms Inc.", 618.5],
  ["MSFT", "Microsoft Corp.", 479.8],
  ["NFLX", "Netflix Inc.", 892.3],
  ["TSLA", "Tesla Inc.", 341.9],
  ["MCD", "McDonald's Corp.", 306.1],
  ["WMT", "Walmart Inc.", 98.4],
  ["HD", "The Home Depot Inc.", 386.2],
  ["KO", "The Coca-Cola Company", 68.2],
  ["PEP", "PepsiCo Inc.", 148.3],
  ["PG", "Procter & Gamble", 162.1],
  ["CVX", "Chevron Corp.", 157.9],
  ["XOM", "Exxon Mobil Corp.", 118.4],
  ["CMCSA", "Comcast Corp.", 36.2],
  ["GME", "GameStop Corp.", 23.8],
  ["BRK.B", "Berkshire Hathaway B", 494.6],
  ["V", "Visa Inc.", 344.9],
  ["MA", "Mastercard Inc.", 545.2],
  ["JPM", "JPMorgan Chase", 254.8],
  ["BAC", "Bank of America", 45.9],
  ["GS", "Goldman Sachs Group", 614.7],
  ["COIN", "Coinbase Global", 288.9],
  ["HOOD", "Robinhood Markets", 96.1],
  ["MSTR", "Strategy Inc.", 319.5],
  ["NVDA", "NVIDIA Corp.", 178.3],
  ["AVGO", "Broadcom Inc.", 234.7],
  ["ORCL", "Oracle Corp.", 184.6],
  ["CRM", "Salesforce Inc.", 274.5],
  ["CSCO", "Cisco Systems", 61.3],
  ["IBM", "IBM Corp.", 245.1],
  ["INTC", "Intel Corp.", 24.2],
  ["PLTR", "Palantir Technologies", 168.4],
  ["CRWD", "CrowdStrike Holdings", 385.6],
  ["MRVL", "Marvell Technology", 91.8],
  ["APP", "AppLovin Corp.", 419.5],
  ["ACN", "Accenture plc", 344.2],
  ["HON", "Honeywell International", 224.6],
  ["LIN", "Linde plc", 451.8],
  ["ABBV", "AbbVie Inc.", 197.6],
  ["ABT", "Abbott Laboratories", 127.9],
  ["AZN", "AstraZeneca plc", 77.8],
  ["DHR", "Danaher Corp.", 244.5],
  ["JNJ", "Johnson & Johnson", 157.8],
  ["LLY", "Eli Lilly and Co.", 784.9],
  ["MDT", "Medtronic plc", 92.4],
  ["MRK", "Merck & Co.", 97.6],
  ["NVO", "Novo Nordisk", 51.7],
  ["PFE", "Pfizer Inc.", 26.1],
  ["TMO", "Thermo Fisher Scientific", 524.8],
  ["UNH", "UnitedHealth Group", 344.7],
  ["PM", "Philip Morris International", 167.9],
];

const SUNRISE: Row[] = [
  ["SPCX", "SpaceX (tokenized)", 212.4],
  ["COST", "Costco Wholesale Corp.", 941.7],
  ["LULU", "Lululemon Athletica", 314.8],
  ["SHOP", "Shopify Inc.", 116.2],
  ["RBLX", "Roblox Corp.", 67.9],
  ["UPS", "United Parcel Service", 107.6],
  ["MGM", "MGM Resorts International", 38.4],
  ["RDDT", "Reddit Inc.", 174.5],
  ["DELL", "Dell Technologies", 127.9],
  ["BA", "Boeing Co.", 214.6],
  ["BABA", "Alibaba Group", 117.8],
  ["LMT", "Lockheed Martin", 464.9],
  ["RIVN", "Rivian Automotive", 13.8],
  ["SNAP", "Snap Inc.", 10.9],
  ["DJT", "Trump Media & Technology", 21.6],
  ["HIMS", "Hims & Hers Health", 41.7],
  ["QUBT", "Quantum Computing Inc.", 17.9],
  ["IBM", "IBM Corp.", 245.1],
  ["JNJ", "Johnson & Johnson", 157.8],
  ["PFE", "Pfizer Inc.", 26.1],
];

const ONDO: Row[] = [
  ["NKE", "NIKE Inc.", 77.9],
  ["SBUX", "Starbucks Corp.", 94.6],
  ["TGT", "Target Corp.", 149.3],
  ["UBER", "Uber Technologies", 82.7],
  ["DASH", "DoorDash Inc.", 176.5],
  ["ABNB", "Airbnb Inc.", 134.8],
  ["CMG", "Chipotle Mexican Grill", 58.2],
  ["DIS", "The Walt Disney Company", 111.9],
  ["SPOT", "Spotify Technology", 682.1],
  ["LYFT", "Lyft Inc.", 17.9],
  ["TJX", "TJX Companies Inc.", 127.8],
  ["QSR", "Restaurant Brands Intl", 67.4],
  ["DAL", "Delta Air Lines", 61.9],
  ["UAL", "United Airlines", 97.8],
  ["MAR", "Marriott International", 284.6],
  ["YUM", "Yum! Brands Inc.", 142.3],
  ["CVS", "CVS Health Corp.", 61.8],
  ["KR", "The Kroger Co.", 67.5],
  ["ULTA", "Ulta Beauty Inc.", 414.7],
  ["GAP", "The Gap Inc.", 23.9],
  ["LOW", "Lowe's Companies Inc.", 264.8],
  ["BBY", "Best Buy Co. Inc.", 81.6],
  ["BKNG", "Booking Holdings Inc.", 5118.0],
  ["DPZ", "Domino's Pizza Inc.", 444.9],
  ["SHEL", "Shell plc", 71.6],
  ["ADBE", "Adobe Inc.", 385.4],
  ["PYPL", "PayPal Holdings", 81.7],
];

/** Build the deduped universe, recording which other issuers also carry each ticker. */
function build(): TickerDef[] {
  const catalogues: Array<[Issuer, Row[]]> = [
    ["xStocks", XSTOCKS],
    ["Sunrise", SUNRISE],
    ["Ondo", ONDO],
  ];

  const carriedBy = new Map<string, Issuer[]>();
  for (const [issuer, rows] of catalogues) {
    for (const [ticker] of rows) {
      if (!carriedBy.has(ticker)) carriedBy.set(ticker, []);
      carriedBy.get(ticker)!.push(issuer);
    }
  }

  const out: TickerDef[] = [];
  const done = new Set<string>();
  for (const issuer of ISSUER_PREFERENCE) {
    const rows = catalogues.find(([i]) => i === issuer)![1];
    for (const [ticker, name, price, kind] of rows) {
      if (done.has(ticker)) continue;
      done.add(ticker);
      out.push({
        ticker,
        symbol: `${ticker}${ISSUERS[issuer].suffix}`,
        name,
        price,
        decimals: 8,
        kind: kind ?? "equity",
        issuer,
        alsoOn: (carriedBy.get(ticker) ?? []).filter((i) => i !== issuer),
      });
    }
  }
  return out;
}

export const TOKENIZED_UNIVERSE: TickerDef[] = build();
export const BY_TICKER = new Map(TOKENIZED_UNIVERSE.map((t) => [t.ticker, t]));
export const TOKENIZED_TICKERS = new Set(TOKENIZED_UNIVERSE.map((t) => t.ticker));

/** Mint addresses written by scripts/mint-mock-tickers.ts. */
export interface MintRecord {
  ticker: string;
  symbol: string;
  mint: string;
  decimals: number;
}

export function loadMints(): Map<string, MintRecord> {
  if (!fs.existsSync(TICKER_FILE)) {
    throw new Error(
      `${TICKER_FILE} not found — run \`pnpm mint-tickers\` first to create the mock mints on devnet.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(TICKER_FILE, "utf8")) as {
    cluster: string;
    treasury: string;
    mints: MintRecord[];
  };
  return new Map(raw.mints.map((m) => [m.ticker, m]));
}

export function loadMintsMeta(): { cluster: string; treasury: string } {
  const raw = JSON.parse(fs.readFileSync(TICKER_FILE, "utf8"));
  return { cluster: raw.cluster, treasury: raw.treasury };
}

/**
 * Mock quote with a small deterministic-per-minute wobble, so the demo shows
 * prices that move without needing a real feed.
 */
export function quote(ticker: string): number {
  const def = BY_TICKER.get(ticker);
  if (!def) throw new Error(`no quote for ${ticker}`);
  const minute = Math.floor(Date.now() / 60_000);
  let h = 0;
  const key = `${ticker}:${minute}`;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const wobble = ((h % 2001) / 2000 - 0.5) * 0.01; // +/- 0.5%
  return Math.round(def.price * (1 + wobble) * 100) / 100;
}
