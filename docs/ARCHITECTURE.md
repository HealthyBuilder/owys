# Owys — how it is built

For what the product does, see [OVERVIEW.md](OVERVIEW.md).

Roughly 3,900 lines: a 561-line Anchor program, ~1,700 lines of TypeScript, and
a 713-line single-file front end with no build step.

---

## 1. Data flow

```
                  ┌─────────────────────────────────────────────┐
 card network     │  POST /webhook/card-authorization           │
 (mocked)         │  Stripe-Issuing-shaped payload              │
                  └──────────────────┬──────────────────────────┘
                                     │  ~2s budget to approve or decline
                  ┌──────────────────▼──────────────────────────┐
                  │  balance check → decline books nothing      │
                  └──────────────────┬──────────────────────────┘
                                     │
                  ┌──────────────────▼──────────────────────────┐
                  │  MerchantResolver       ← the hard part      │
                  │  descriptor + MCC + network_id              │
                  │    → listed parent → issuer → token         │
                  └──────────────────┬──────────────────────────┘
                                     │
                  ┌──────────────────▼──────────────────────────┐
                  │  RewardLedger (off-chain, integer µUSD)     │
                  └──────────────────┬──────────────────────────┘
                                     │  decision returns; chain write follows
                  ┌──────────────────▼──────────────────────────┐
                  │  equity_back::accrue_reward                 │
                  │  Accrual PDA seeded by card_tx_id ← replay  │
                  └──────────────────┬──────────────────────────┘
                                     │  batched per ticker
                  ┌──────────────────▼──────────────────────────┐
                  │  SettlementKeeper → convert                 │
                  │    → settle_distribute                      │
                  └──────────────────┬──────────────────────────┘
                                     │  user signs
                  ┌──────────────────▼──────────────────────────┐
                  │  equity_back::claim → the user's own ATA    │
                  └─────────────────────────────────────────────┘
```

**Why the decision and the chain write are separate.** A real-time authorization
webhook has roughly two seconds to approve or decline, which is not enough to
also wait on a chain write. The decision and the off-chain booking are
synchronous; the on-chain accrual fires after, and its signature is pushed to
the UI over SSE when it lands. A `sync=1` query parameter forces the wait, for
scripted runs that need deterministic output.

---

## 2. On-chain program

`programs/equity-back/src/lib.rs` · program ID
`BuM8wmDCcUu3uJwphiN5vBEMxGPggL1Kui9greZaHK4` (devnet)

The program does one job: be the tamper-proof record of ownership. Card
authorization is off-chain and always will be, so there is no pretence
otherwise.

### Instructions

```rust
initialize_config(reward_bps)                                // authority
set_signers(oracle_signer, treasury)                         // authority
open_user()                                                  // user
accrue_reward(card_tx_id, spend_usd, symbol, merchant, mcc)  // oracle
settle_distribute(usd_amount, token_amount)                  // treasury
claim()                                                      // user
```

### Accounts

| account | seeds | role |
| --- | --- | --- |
| `Config` | `["config"]` | rate, the three role keys, global totals |
| `UserAccount` | `["user", owner]` | per-user spend, rewards, transaction count |
| `RewardPosition` | `["position", user, mint]` | the user's row for one ticker |
| `Accrual` | `["accrual", card_tx_id]` | **existence means already paid**; never closed |

### Three properties worth defending

**Replay protection is on-chain, not in application code.** The `Accrual` seed
is a 16-byte truncated SHA-256 of the card transaction id. A webhook delivered
twice — which card networks do routinely — fails the second `init`.

```rust
#[account(init, payer = oracle_signer, space = 8 + Accrual::INIT_SPACE,
          seeds = [ACCRUAL_SEED, card_tx_id.as_ref()], bump)]
pub accrual: Account<'info, Accrual>,
```

**The oracle key cannot move tokens.** `accrue_reward` only writes USD-
denominated entries; every token movement needs the treasury or the user. A
compromised webhook service mints fake *claims*, not fake *shares*.

**Tokens wait in a program vault until claimed.** A batch of 5,000 rewards does
not have to create and fund 5,000 token accounts up front. `settle_distribute`
moves tokens into the config PDA's account and credits the position; the user's
own account is created when they claim.

### Events

`RewardAccrued`, `RewardDistributed`, `RewardClaimed` — for indexers and the
live UI feed.

---

## 3. Merchant resolution

`server/src/merchantResolver.ts` and `server/src/brands.ts`

### Normalization comes first

Everything downstream is wrong otherwise. `PAYPAL *NIKESTORE` credits PayPal
instead of Nike unless the processor prefix is stripped.

```
1. uppercase
2. strip processor prefixes, usually '*'-delimited:
   SQ, TST, TOAST, CLOVER, STRIPE, PAYPAL, PP, …
3. strip punctuation
4. drop leftover leading processor words
5. drop runs of 3+ digits (store numbers, phone numbers, order ids)
   and any purely numeric token
6. collapse whitespace
```

```
SQ *BLUE BOTTLE COFFEE  ->  BLUE BOTTLE COFFEE
NIKE.COM 8006536453     ->  NIKE COM
MCDONALD'S F12345       ->  MCDONALD S F12345
```

### The ladder

Six rungs, described in [OVERVIEW.md](OVERVIEW.md). Implementation notes:

- **exact match takes the longest hit**, so `UBER EATS` beats `UBER`
- **fuzzy match** uses Levenshtein similarity at a 0.82 threshold, comparing
  both the descriptor head and the whole string
- **MCC corroboration** raises confidence (0.90 → 0.98) and its absence
  discounts it
- **proxy exposure** is capped at 0.55 and flagged separately
- when a company is **identified but unavailable**, the identification is
  carried forward so the UI can say so rather than silently substituting

Every resolution returns a `trace: string[]`. That is the basis of
explainability, and the only practical way to debug misses at volume.

### LLM hook

`ResolveContext.llmFallback` is the insertion point for a model and is
deliberately unused. The first three rungs already cover the bulk of spend; a
model is a cost you should only pay on the tail.

---

## 4. The issuer universe

`server/src/tickers.ts`

Three catalogues are deduplicated at build time in a stated preference order:

```ts
export const ISSUER_PREFERENCE: Issuer[] = ["xStocks", "Sunrise", "Ondo"];
```

Each `TickerDef` records the `issuer` actually settled through and `alsoOn`, the
other issuers carrying the same ticker — routing options, not dead weight.
Symbol conventions differ per issuer, so the on-chain symbol is derived rather
than assumed.

**The preference order is hard-coded, and in production it should not be.** This
is a per-trade liquidity routing decision: depth and spread differ by issuer,
and on a $0.20 reward the spread is the entire cost.

The Ondo block is a representative subset rather than its full catalogue —
exactly the tickers this repo's brand table needs and the other two do not
carry. Coverage figures are therefore a floor for that issuer, not a ceiling.

---

## 5. Settlement keeper

`server/src/keeper.ts`

**Batched per ticker, not per transaction.** A $4 coffee earns $0.12. On Solana
the fee to convert that alone is negligible, but the slippage and minimum-output
protection on a $0.12 order are not. Batching is what makes 3% on a coffee
economically real.

1. collect every accrued entry, group by payout ticker
2. skip groups below `MIN_BATCH_USD` and wait for more spend
3. convert the group
4. allocate tokens by each user's share of the batch, with rounding dust
   assigned to the last leg so nothing is created from nothing
5. call `settle_distribute` per leg

Production also needs a **weekend queue**: tokenized equities trade 24/5, so
Saturday's rewards must sit in stablecoin until Monday — and the UI should say
so rather than hide it.

### Integer arithmetic, learned the hard way

An earlier version rounded each reward to cents off-chain ($0.2175 → $0.22)
while the program computed exact basis points ($0.2175). Three accruals later
the off-chain total exceeded the on-chain total by $0.0075 and settlement failed
with `InsufficientAccrual`.

Everything off-chain now uses **integer micro-dollars, floored**, bit-identical
to the program:

```ts
const spendMicro  = Math.round(amountUsd * 1_000_000);
const rewardMicro = Math.floor((spendMicro * REWARD_BPS) / 10_000);
```

This class of error bites every real payments system eventually.

---

## 6. Ledger, balance and declines

`server/src/ledger.ts` — a JSON file. Adequate at PoC scale and it avoids a
native database dependency. Every access goes through this module, so moving to
Postgres changes exactly one file.

The property that matters is not the storage engine: **the card transaction id
is the primary key everywhere**, matching the on-chain `Accrual` seed. Both
layers deduplicate on the same key.

The balance is off-chain — there is no on-chain spend vault — but it genuinely
gates authorization:

```ts
if (incoming.amountUsd > user.availableUsd) {
  // booked as declined, no reward, returns approved: false
}
```

**Known limitation: the JSON ledger has no locking.** The server and the CLI
demo each hold it in memory, so running both at once silently clobbers writes.
`pnpm demo` refuses to start while the server is up; `ALLOW_CONCURRENT=1`
overrides. Postgres removes the problem.

Mutable state is written under `DATA_DIR`, which defaults to the repo root.

---

## 7. HTTP surface

| method | path | notes |
| --- | --- | --- |
| POST | `/webhook/card-authorization` | **the only architecturally meaningful endpoint.** Accepts this repo's shape or a raw Stripe Issuing payload; returns `{approved, declineReason?}`. Pointing it at a real sandbox changes the caller, not the handler |
| POST / GET | `/api/users` | cardholders |
| POST | `/api/topup` | funds the card |
| POST | `/api/simulate` | fire simulated authorizations |
| GET | `/api/merchants` | the fixture pool |
| GET | `/api/resolve?descriptor=&mcc=` | **resolver playground** — any descriptor in, full trace out |
| POST | `/api/keeper/run` | trigger settlement |
| POST | `/api/claim` | withdraw to the user's own account |
| GET | `/api/portfolio/:userId` | positions read back from chain, plus history |
| GET | `/api/state` | global state, issuers, statistics, batches |
| GET | `/api/stream` | server-sent events |

---

## 8. Code map

```
programs/equity-back/src/lib.rs   on-chain program
server/src/brands.ts              brand table, parent mapping, MCC table
server/src/merchantResolver.ts    the six-rung ladder
server/src/tickers.ts             issuer catalogues, dedupe and routing
server/src/pipeline.ts            resolve → book → accrue (shared by server and CLI)
server/src/keeper.ts              batch settlement
server/src/chain.ts               PDAs, instructions, throttled RPC client
server/src/ledger.ts              off-chain ledger and balances
server/src/paths.ts               where mutable state lives
server/src/cardSim.ts             mock card network, 35 dirty descriptors
server/public/index.html          front end, single file, no build step
scripts/demo.ts                   scripted end-to-end run
scripts/resolver-report.ts        coverage report — the loop for tuning brands.ts
scripts/mint-mock-tickers.ts      create the mock mints, resumable
```

---

## 9. Turning the mocks real, by information gained

1. **A real conversion.** One ticker, tiny size, on mainnet against a live DEX
   aggregator. Proves real liquidity and real slippage in the $0.20–$50 range.
   The single highest-information next move.
2. **Verify the asset side per issuer.** Are the tokens Token-2022? Any transfer
   hook or allowlist restricting distribution to arbitrary wallets? What
   decimals? This gates whether free distribution works at all, and the answer
   may differ by issuer — which would make issuer routing a compliance decision
   as well as a liquidity one.
3. **A real card sandbox.** Point an issuer's test mode at
   `/webhook/card-authorization` and return a genuine approve/decline.
4. **Embedded wallets.** An embedded-wallet provider plus a fee payer, so users
   never see a keypair or need to hold SOL.
5. **Measure the real hit rate.** Point `pnpm resolver-report` at an anonymized
   sample of real descriptors. The figure from hand-picked fixtures is not a
   forecast; the real number is the product's ceiling and every projection rests
   on it.

---

## 10. Known limitations

- **One wallet wears three hats.** `authority = oracle_signer = treasury` here.
  In production these are three keys in three places: the authority in a
  multisig, the oracle in the webhook service, the treasury wherever inventory
  actually lives.
- **The keeper settles legs serially.** Fine at demo scale; production wants one
  transaction carrying many legs.
- **`DOORDASH*BURGER KING`** — two brands in one descriptor. The resolver takes
  the longest match (Burger King), i.e. where the user actually ate rather than
  the merchant of record. Defensible, but it is a product decision and should be
  a deliberate one.
- **No sector-level baskets exist onchain**, so the fifth rung has little to work
  with and most fallbacks land on the whole market.
- **The on-chain crate is still named `equity_back`.** The project was renamed
  after deployment; renaming the crate means a rebuild and redeploy. The program
  ID is unaffected either way.
