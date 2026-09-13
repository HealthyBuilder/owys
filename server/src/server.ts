/**
 * HTTP surface.
 *
 * `POST /webhook/card-authorization` is the only endpoint that matters
 * architecturally — it is written against the shape a Stripe Issuing / Rain
 * real-time authorization webhook delivers, so pointing this at a real sandbox
 * means changing the caller, not the handler.
 *
 * Everything under /api exists to drive the demo and to make the resolver's
 * reasoning inspectable.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { PublicKey } from "@solana/web3.js";

import * as ledger from "./ledger.ts";
import * as chain from "./chain.ts";
import * as keeper from "./keeper.ts";
import * as users from "./users.ts";
import { log, publish, subscribe } from "./bus.ts";
import { resolveMerchant, type CardAuthorization } from "./merchantResolver.ts";
import { handleAuthorization, REWARD_BPS } from "./pipeline.ts";
import { BY_TICKER, ISSUERS, loadMints, loadMintsMeta, quote } from "./tickers.ts";
import { maybeSeed } from "./seed.ts";
import { MERCHANT_POOL, buildAuthorization, findFixture, randomAuthorization } from "./cardSim.ts";
import {
  BadInput, MAX_DEMO_USERS, requireAmountUsd, requireDescriptor, requireId,
} from "./limits.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.PORT ?? 4000);

const app = Fastify({ logger: false });

// Reject malformed input as 400 rather than letting it surface as a 500.
app.setErrorHandler((err: unknown, _req, reply) => {
  if (err instanceof BadInput) return reply.code(400).send({ error: err.message });
  const message = err instanceof Error ? err.message : String(err);
  log("error", `unhandled: ${message}`);
  return reply.code(500).send({ error: "internal error" });
});
await app.register(fastifyStatic, { root: path.join(ROOT, "server/public"), prefix: "/" });

// ------------------------------------------------------------------ routes --

/** The integration point. Accepts our shape or a Stripe Issuing payload. */
app.post("/webhook/card-authorization", async (req, reply) => {
  const body = req.body as any;
  const sync = (req.query as any)?.sync === "1";

  // Accept a raw Stripe Issuing `issuing_authorization` object too, so the
  // switch to their sandbox is a URL change.
  const stripe = body?.data?.object ?? (body?.object === "issuing.authorization" ? body : null);
  const incoming: CardAuthorization = stripe
    ? {
        id: requireId(stripe.id, "id", 128),
        amountUsd: requireAmountUsd((stripe.pending_request?.amount ?? stripe.amount ?? 0) / 100),
        merchantName: requireDescriptor(stripe.merchant_data?.name ?? "UNKNOWN"),
        mcc: Number(stripe.merchant_data?.category_code ?? 0),
        networkId: stripe.merchant_data?.network_id ?? "",
        city: stripe.merchant_data?.city,
        country: stripe.merchant_data?.country,
        last4: stripe.card?.last4,
      }
    : {
        id: requireId(body.id, "id", 128),
        amountUsd: requireAmountUsd(body.amountUsd),
        merchantName: requireDescriptor(body.merchantName),
        mcc: Number(body.mcc ?? 0),
        networkId: String(body.networkId ?? "").slice(0, 64),
        city: body.city,
        country: body.country,
        last4: body.last4,
      };

  const userId = body.userId ?? ledger.listUsers()[0]?.id;
  if (!userId) return reply.code(400).send({ error: "no cardholder — POST /api/users first" });
  if (!incoming.id) return reply.code(400).send({ error: "missing authorization id" });

  // The approve/decline decision a real issuer expects back on this call.
  return handleAuthorization(incoming, userId, { sync });
});

app.post("/api/users", async (req, reply) => {
  // Each cardholder costs the treasury real devnet SOL, so this is the one
  // endpoint an open demo has to cap.
  if (ledger.listUsers().length >= MAX_DEMO_USERS) {
    return reply.code(429).send({
      error: `demo is limited to ${MAX_DEMO_USERS} cardholders — pick an existing one`,
    });
  }
  const raw = (req.body as any)?.label;
  const label = String(raw ?? `Cardholder ${ledger.listUsers().length + 1}`).slice(0, 40);
  return users.createUser(label);
});

app.get("/api/users", async () => ledger.listUsers());

/** Fund the card. Stands in for a USDC deposit into a spend vault. */
app.post("/api/topup", async (req, reply) => {
  const { userId, amountUsd } = (req.body as any) ?? {};
  const user = ledger.getUser(userId);
  if (!user) return reply.code(404).send({ error: "unknown user" });
  const amount = requireAmountUsd(amountUsd ?? 1000);
  if (amount > 100_000) return reply.code(400).send({ error: "top-up capped at $100,000" });
  const availableUsd = ledger.topUp(userId, amount);
  log("info", `${user.label} topped up $${amount.toFixed(2)} — available $${availableUsd.toFixed(2)}`);
  return { availableUsd };
});

/** Fire simulated authorizations: a named fixture, or `count` random ones. */
app.post("/api/simulate", async (req, reply) => {
  const body = (req.body as any) ?? {};
  const userId = body.userId ?? ledger.listUsers()[0]?.id;
  if (!userId) return reply.code(400).send({ error: "no cardholder — POST /api/users first" });

  const out: unknown[] = [];
  if (body.descriptor) {
    const fixture = findFixture(body.descriptor);
    if (!fixture) return reply.code(404).send({ error: `unknown fixture ${body.descriptor}` });
    const auth = buildAuthorization(fixture, {
      amountUsd: body.amountUsd === undefined ? undefined : requireAmountUsd(body.amountUsd),
    });
    out.push(await handleAuthorization(auth, userId, { sync: body.sync !== false }));
  } else {
    const count = Math.min(Number(body.count ?? 1), 25);
    for (let i = 0; i < count; i++) {
      out.push(await handleAuthorization(randomAuthorization(), userId, { sync: true }));
    }
  }
  return { fired: out.length, results: out };
});

app.get("/api/merchants", async () =>
  MERCHANT_POOL.map((m) => ({
    descriptor: m.descriptor,
    mcc: m.mcc,
    range: m.range,
    demonstrates: m.demonstrates,
  })),
);

/** Resolver playground — type any descriptor and see the full trace. */
app.get("/api/resolve", async (req) => {
  const q = req.query as any;
  const auth: CardAuthorization = {
    id: "probe",
    amountUsd: requireAmountUsd(q.amountUsd ?? 50),
    merchantName: requireDescriptor(q.descriptor, "descriptor"),
    mcc: Number(q.mcc ?? 0),
    networkId: String(q.networkId ?? "probe"),
  };
  return resolveMerchant(auth, { networkIdCache: ledger.networkIdCache() });
});

app.post("/api/keeper/run", async (req) => {
  const force = (req.body as any)?.force !== false;
  return keeper.runOnce({ force });
});

app.post("/api/claim", async (req, reply) => {
  const { userId, ticker } = (req.body as any) ?? {};
  const user = ledger.getUser(userId);
  if (!user) return reply.code(404).send({ error: "unknown user" });
  const mint = loadMints().get(ticker);
  if (!mint) return reply.code(404).send({ error: `unknown ticker ${ticker}` });

  try {
    const sig = await chain.claim(users.keypairFor(userId), new PublicKey(mint.mint));
    publish({ type: "claimed", payload: { userId, ticker, sig } });
    log("info", `claim ${ticker} by ${user.label}: ${sig.slice(0, 10)}…`);
    return { sig, explorer: chain.explorer("tx", sig) };
  } catch (err: any) {
    return reply.code(400).send({ error: err?.message ?? String(err) });
  }
});

app.get("/api/portfolio/:userId", async (req, reply) => {
  const { userId } = req.params as any;
  const user = ledger.getUser(userId);
  if (!user) return reply.code(404).send({ error: "unknown user" });

  const positions = await chain.fetchPositions(new PublicKey(user.pubkey));
  const mints = loadMints();
  const byMint = new Map([...mints.values()].map((m) => [m.mint, m]));

  const holdings = positions.map((p) => {
    const rec = byMint.get(p.mint);
    const ticker = rec?.ticker ?? p.symbol.replace(/x$/, "");
    const decimals = rec?.decimals ?? 8;
    const shares = Number(p.distributedTokens) / 10 ** decimals;
    const price = BY_TICKER.has(ticker) ? quote(ticker) : 0;
    const def = BY_TICKER.get(ticker);
    return {
      ticker,
      symbol: p.symbol,
      name: def?.name ?? p.symbol,
      issuer: def ? ISSUERS[def.issuer].label : null,
      alsoOn: def ? def.alsoOn.map((i) => ISSUERS[i].label) : [],
      mint: p.mint,
      shares,
      unclaimedShares: Number(p.distributedTokens - p.claimedTokens) / 10 ** decimals,
      price,
      valueUsd: Math.round(shares * price * 100) / 100,
      accruedUsd: p.accruedUsd,
      settledUsd: p.settledUsd,
      positionAccount: p.address,
      explorer: chain.explorer("address", p.address),
    };
  });

  holdings.sort((a, b) => b.valueUsd - a.valueUsd);
  const onChainUser = await chain.fetchUserAccount(new PublicKey(user.pubkey));

  return {
    user,
    availableUsd: user.availableUsd,
    explorer: chain.explorer("address", user.pubkey),
    onChain: onChainUser
      ? {
          totalSpentUsd: Number(onChainUser.totalSpentUsd) / chain.USD_UNIT,
          totalRewardedUsd: Number(onChainUser.totalRewardedUsd) / chain.USD_UNIT,
          txCount: onChainUser.txCount,
        }
      : null,
    holdings,
    portfolioValueUsd: Math.round(holdings.reduce((s, h) => s + h.valueUsd, 0) * 100) / 100,
    pendingUsd: Math.round(holdings.reduce((s, h) => s + h.accruedUsd, 0) * 100) / 100,
    authorizations: ledger.authsForUser(userId).slice(0, 60),
  };
});

app.get("/api/state", async () => {
  const config = await chain.fetchConfig();
  return {
    cluster: chain.CLUSTER,
    programId: chain.programId().toBase58(),
    programExplorer: chain.explorer("address", chain.programId().toBase58()),
    configAccount: chain.configPda().toBase58(),
    rewardBps: config?.rewardBps ?? REWARD_BPS,
    treasury: loadMintsMeta().treasury,
    issuers: Object.entries(ISSUERS).map(([key, v]) => ({
      key,
      label: v.label,
      note: v.note,
      tickers: [...BY_TICKER.values()].filter((t) => t.issuer === key).length,
    })),
    onChain: config
      ? {
          accrualCount: Number(config.accrualCount),
          totalSpentUsd: Number(config.totalSpentUsd) / chain.USD_UNIT,
          totalAccruedUsd: Number(config.totalAccruedUsd) / chain.USD_UNIT,
          totalSettledUsd: Number(config.totalSettledUsd) / chain.USD_UNIT,
        }
      : null,
    stats: ledger.stats(),
    cache: ledger.cacheStats(),
    users: ledger.listUsers(),
    recentAuths: ledger.listAuths(40),
    settlements: ledger.listSettlements(20),
    minBatchUsd: keeper.MIN_BATCH_USD,
  };
});

/** Server-sent events — the live feed the demo watches. */
app.get("/api/stream", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  reply.raw.write(": connected\n\n");

  const unsubscribe = subscribe((event) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);

  req.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// -------------------------------------------------------------------- boot --

const config = await chain.fetchConfig();
if (!config) {
  console.error("Config PDA not found — run `pnpm run init-config` first.");
  process.exit(1);
}

try {
  loadMints();
} catch (err: any) {
  console.error(err.message);
  process.exit(1);
}

// A cold start begins with an empty tmpfs ledger; restore the demo if one is
// bundled, before anything can observe the empty state.
maybeSeed();

keeper.start(Number(process.env.KEEPER_INTERVAL_MS ?? 30_000));

// Containers must accept traffic from outside the namespace; a local run has
// no reason to be reachable off-box.
const HOST = process.env.HOST ?? (process.env.DATA_DIR ? "0.0.0.0" : "127.0.0.1");
await app.listen({ port: PORT, host: HOST });
console.log(`
  Owys  —  all-mock PoC
  dashboard   http://${HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"}:${PORT}
  cluster     ${chain.CLUSTER}
  program     ${chain.programId().toBase58()}
  cashback    ${(config.rewardBps / 100).toFixed(2)}%
  cardholders ${ledger.listUsers().length}
`);
