/**
 * Merchant -> ticker resolution.
 *
 * Card networks hand you a ~22-character descriptor written by whoever set up
 * the merchant's payment terminal in 2011. Everything downstream depends on
 * turning that into a listed parent company, so the pipeline is explicit,
 * ordered, and returns its own reasoning (`trace`) — both because the reward
 * has to be explainable to the user and because it's the only way to debug
 * misses at scale.
 *
 * Ladder, highest confidence first:
 *   1. network_id cache  — seen this exact merchant before; permanent
 *   2. brand exact       — normalized descriptor contains a known pattern
 *   3. brand fuzzy       — typo/truncation tolerant match
 *   4. proxy             — brand is private, a listed company is the best exposure
 *   5. sector ETF by MCC — no company, but the right slice of the market
 *   6. index fallback    — SPY
 */

import { BRANDS, MCC_SECTOR, MCC_LABELS, INDEX_FALLBACK, type Brand } from "./brands.ts";
import { TOKENIZED_TICKERS, BY_TICKER, ISSUERS, type Issuer } from "./tickers.ts";

export interface CardAuthorization {
  /** Card-network transaction id. The idempotency key, end to end. */
  id: string;
  amountUsd: number;
  /** Raw descriptor, exactly as the network sends it. */
  merchantName: string;
  mcc: number;
  /** Stable per-merchant id from the network — the cache key that makes this get better over time. */
  networkId: string;
  city?: string;
  country?: string;
  last4?: string;
}

export type ResolveStage =
  | "network_id_cache"
  | "brand_exact"
  | "brand_fuzzy"
  | "proxy"
  | "sector_etf"
  | "index_fallback";

export interface Resolution {
  stage: ResolveStage;
  /** 0..1. Below CACHE_THRESHOLD we do not write the network_id cache. */
  confidence: number;
  normalized: string;
  brand: string | null;
  company: string | null;
  /** Listed parent as identified. May be untokenized (""/null). */
  ticker: string | null;
  /** What we will actually buy. Always tokenized. */
  payoutTicker: string;
  payoutName: string;
  /** Onchain symbol of the token we buy, e.g. AAPLx / COST / NKEon. */
  payoutSymbol: string;
  /** Which issuer that token comes from — they are not interchangeable. */
  payoutIssuer: Issuer | null;
  /** False when we identified the company but no token exists for it. */
  tickerTokenized: boolean;
  proxy: boolean;
  note?: string;
  trace: string[];
}

/** Only cache a merchant->brand binding at or above this confidence. */
export const CACHE_THRESHOLD = 0.9;

/**
 * Descriptor noise added by payment processors and gateways. These are
 * prefixes on top of the real merchant name, so they must go before matching —
 * otherwise "SQ *BLUE BOTTLE" fuzzy-matches nothing and "PAYPAL *NIKE" gets
 * credited to PayPal.
 */
const PROCESSOR_PREFIXES = [
  "SQ", "SQC", "TST", "TOAST", "CLOVER", "STRIPE", "SP", "PAYPAL", "PP", "PY",
  "IC", "POS", "PURCHASE", "DEBIT", "CREDIT", "WWW", "HTTP", "HTTPS", "WEB",
  "MOBILE", "APPLE PAY", "GOOGLE PAY", "AMZ", "EXTERNAL", "RECUR",
];

const NOISE_TOKENS = new Set([
  "INC", "LLC", "LTD", "CORP", "CO", "THE", "COM", "NET", "ORG", "STORE",
  "SHOP", "ONLINE", "US", "USA", "CA", "NY", "TX", "SF", "LA",
]);

/** Uppercase, strip processor prefixes, store/phone numbers, and punctuation. */
export function normalizeDescriptor(raw: string): string {
  let s = raw.toUpperCase().trim();

  // Processor prefixes are delimited by '*' far more often than by space.
  for (let i = 0; i < 3; i++) {
    const star = s.match(/^([A-Z0-9 ]{1,12})\s*\*+\s*(.+)$/);
    if (star) {
      const head = star[1].trim();
      if (PROCESSOR_PREFIXES.includes(head)) {
        s = star[2].trim();
        continue;
      }
    }
    break;
  }

  s = s.replace(/[^A-Z0-9 ]+/g, " ");

  // Drop leading processor words left over after punctuation stripping.
  const lead = s.split(/\s+/);
  while (lead.length > 1 && PROCESSOR_PREFIXES.includes(lead[0])) lead.shift();
  s = lead.join(" ");

  // Store numbers, phone numbers, order ids: any run of 3+ digits, and any
  // token that is purely digits.
  s = s.replace(/\b\d{3,}\b/g, " ");
  s = s
    .split(/\s+/)
    .filter((t) => t && !/^\d+$/.test(t))
    .join(" ");

  return s.replace(/\s+/g, " ").trim();
}

function significantTokens(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 1 && !NOISE_TOKENS.has(t));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

interface PatternHit {
  brand: Brand;
  pattern: string;
  kind: "exact" | "fuzzy";
  score: number;
}

function matchBrand(normalized: string): PatternHit | null {
  const tokens = significantTokens(normalized);
  const joined = tokens.join(" ");
  let best: PatternHit | null = null;

  for (const brand of BRANDS) {
    for (const pattern of brand.patterns) {
      const p = pattern.toUpperCase();

      // Exact: the descriptor contains the pattern on token boundaries.
      // Longer patterns win, so "UBER EATS" beats "UBER".
      if (joined === p || new RegExp(`(^| )${p.replace(/ /g, " ")}( |$)`).test(joined)) {
        const score = p.length;
        if (!best || best.kind === "fuzzy" || score > best.score) {
          best = { brand, pattern: p, kind: "exact", score };
        }
        continue;
      }

      if (best?.kind === "exact") continue;

      // Fuzzy: compare against the descriptor head, which is where the brand
      // lives once prefixes are gone. Tolerates truncation and typos.
      const head = joined.slice(0, Math.max(p.length, 4));
      const sim = Math.max(similarity(head, p), similarity(joined, p));
      if (sim >= 0.82 && (!best || sim > best.score)) {
        best = { brand, pattern: p, kind: "fuzzy", score: sim };
      }
    }
  }
  return best;
}

export interface ResolveContext {
  /** networkId -> brand name, persisted by the caller. Stage 1. */
  networkIdCache: Map<string, string>;
  /**
   * Where an LLM plugs in, between fuzzy and proxy. Intentionally unused in
   * this all-mock PoC: the point is that stages 1-3 already cover the bulk of
   * spend, and the model is a cost you pay only on the tail.
   */
  llmFallback?: (auth: CardAuthorization, normalized: string) => Promise<Brand | null>;
}

function payoutFor(ticker: string | null) {
  if (ticker && TOKENIZED_TICKERS.has(ticker)) {
    const def = BY_TICKER.get(ticker)!;
    return {
      payoutTicker: ticker,
      payoutName: def.name,
      payoutSymbol: def.symbol,
      payoutIssuer: def.issuer,
      tokenized: true,
    };
  }
  return {
    payoutTicker: "",
    payoutName: "",
    payoutSymbol: "",
    payoutIssuer: null,
    tokenized: false,
  };
}

/** Trace line naming the token and its issuer — they are not interchangeable. */
function issuerLine(ticker: string): string {
  const def = BY_TICKER.get(ticker)!;
  const also = def.alsoOn.length ? `; also on ${def.alsoOn.map((i) => ISSUERS[i].label).join(", ")}` : "";
  return `  settling in ${def.symbol} via ${ISSUERS[def.issuer].label}${also}`;
}

/** Fallback payout when the identified company has no token anywhere. */
function basketFor(ticker: string) {
  const def = BY_TICKER.get(ticker)!;
  return {
    payoutTicker: ticker,
    payoutName: def.name,
    payoutSymbol: def.symbol,
    payoutIssuer: def.issuer,
  };
}

export function resolveMerchant(auth: CardAuthorization, ctx: ResolveContext): Resolution {
  const normalized = normalizeDescriptor(auth.merchantName);
  const mccLabel = MCC_LABELS[auth.mcc] ?? `MCC ${auth.mcc}`;
  const trace: string[] = [
    `raw "${auth.merchantName}" (MCC ${auth.mcc} · ${mccLabel})`,
    `normalized -> "${normalized}"`,
  ];

  const finish = (r: Omit<Resolution, "normalized" | "trace">): Resolution => ({
    ...r,
    normalized,
    trace,
  });

  // ---- stage 1: network id cache ----------------------------------------
  const cachedBrandName = ctx.networkIdCache.get(auth.networkId);
  if (cachedBrandName) {
    const brand = BRANDS.find((b) => b.brand === cachedBrandName);
    if (brand) {
      trace.push(`stage 1 network_id ${auth.networkId} -> cached "${brand.brand}"`);
      const payout = payoutFor(brand.ticker || null);
      if (payout.tokenized) {
        trace.push(issuerLine(brand.ticker));
        return finish({
          stage: "network_id_cache",
          confidence: 1,
          brand: brand.brand,
          company: brand.company,
          ticker: brand.ticker,
          ...payout,
          tickerTokenized: true,
          proxy: !!brand.proxy,
          note: brand.note,
        });
      }
      trace.push(`  ${brand.company} identified, but ${brand.ticker || "no ticker"} is not tokenized`);
    }
  }

  // ---- stages 2 & 3: brand table ----------------------------------------
  const hit = matchBrand(normalized);
  if (hit) {
    const { brand } = hit;
    const mccCorroborates = brand.mcc?.includes(auth.mcc) ?? false;
    const exact = hit.kind === "exact";
    let confidence = exact ? (mccCorroborates ? 0.98 : 0.9) : Math.min(0.85, hit.score) * (mccCorroborates ? 1 : 0.9);

    trace.push(
      `stage ${exact ? 2 : 3} brand_${hit.kind} "${hit.pattern}" -> ${brand.brand}` +
        (mccCorroborates ? " (MCC corroborates)" : " (MCC does not corroborate)"),
    );
    if (brand.brand !== brand.company) {
      trace.push(`  listed parent: ${brand.company}${brand.ticker ? ` (${brand.ticker})` : ""}`);
    }
    if (brand.note) trace.push(`  note: ${brand.note}`);

    if (brand.proxy) {
      confidence = Math.min(confidence, 0.55);
      const payout = payoutFor(brand.ticker || null);
      if (payout.tokenized) {
        trace.push(`stage 4 proxy exposure via ${brand.ticker}`);
        trace.push(issuerLine(brand.ticker!));
        return finish({
          stage: "proxy",
          confidence,
          brand: brand.brand,
          company: brand.company,
          ticker: brand.ticker,
          ...payout,
          tickerTokenized: true,
          proxy: true,
          note: brand.note,
        });
      }
    }

    const payout = payoutFor(brand.ticker || null);
    if (payout.tokenized) {
      trace.push(issuerLine(brand.ticker!));
      return finish({
        stage: exact ? "brand_exact" : "brand_fuzzy",
        confidence,
        brand: brand.brand,
        company: brand.company,
        ticker: brand.ticker,
        ...payout,
        tickerTokenized: true,
        proxy: false,
        note: brand.note,
      });
    }

    // Identified but unavailable — the honest case. Fall through to sector,
    // carrying the identification so the UI can explain itself.
    trace.push(
      brand.ticker
        ? `  ${brand.ticker} is identified but not in the tokenized universe — falling through`
        : `  ${brand.company} is not publicly listed — falling through`,
    );
    const sector = MCC_SECTOR[auth.mcc];
    if (sector && TOKENIZED_TICKERS.has(sector.ticker)) {
      trace.push(`stage 5 sector_etf MCC ${auth.mcc} -> ${sector.ticker} (${sector.label})`);
      return finish({
        stage: "sector_etf",
        confidence: 0.4,
        brand: brand.brand,
        company: brand.company,
        ticker: brand.ticker || null,
        ...basketFor(sector.ticker),
        tickerTokenized: false,
        proxy: false,
        note: brand.note,
      });
    }
    trace.push(`stage 6 index_fallback -> ${INDEX_FALLBACK}`);
    return finish({
      stage: "index_fallback",
      confidence: 0.2,
      brand: brand.brand,
      company: brand.company,
      ticker: brand.ticker || null,
      ...basketFor(INDEX_FALLBACK),
      tickerTokenized: false,
      proxy: false,
      note: brand.note,
    });
  }

  // ---- stage 5: unknown merchant, known sector --------------------------
  trace.push("stages 2-4 no brand match");
  const sector = MCC_SECTOR[auth.mcc];
  if (sector && TOKENIZED_TICKERS.has(sector.ticker)) {
    trace.push(`stage 5 sector_etf MCC ${auth.mcc} -> ${sector.ticker} (${sector.label})`);
    return finish({
      stage: "sector_etf",
      confidence: 0.4,
      brand: null,
      company: null,
      ticker: null,
      ...basketFor(sector.ticker),
      tickerTokenized: false,
      proxy: false,
    });
  }

  // ---- stage 6: the whole market ----------------------------------------
  trace.push(`stage 6 index_fallback -> ${INDEX_FALLBACK}`);
  return finish({
    stage: "index_fallback",
    confidence: 0.2,
    brand: null,
    company: null,
    ticker: null,
    ...basketFor(INDEX_FALLBACK),
    tickerTokenized: false,
    proxy: false,
  });
}
