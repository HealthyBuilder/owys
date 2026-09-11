# Owys — all-mock PoC

> **Spend at a company, own a piece of it.**
> A virtual card that returns 3% of every purchase as tokenized stock *in the
> company you just bought from*, delivered to a wallet only the user controls.

Settled across **every issuer putting equities on Solana** — xStocks (Backed),
Sunrise (with Backpack) and Ondo Global Markets — with mock mints of their real
catalogues. Every number below came out of this repo on devnet.

```
NIKE.COM 8006536453        $120.00  →  NKEon   +$3.60   brand match   Ondo
WHOLEFDS MKT #10255        $ 86.40  →  AMZNx   +$2.59   brand match   xStocks   ← via parent
GEICO *AUTO PREMIUM        $142.00  →  BRK.Bx  +$4.26   brand match   xStocks   ← via parent
STARLINK INTERNET          $120.00  →  SPCX    +$3.60   brand match   Sunrise   ← a private company
OPENAI CHATGPT SUBSCR      $200.00  →  MSFTx   +$6.00   proxy         xStocks
SQ *BLUE BOTTLE COFFEE     $  7.25  →  SPYx    +$0.22   whole market            ← Nestlé is an ADR
DUNKIN #336781 Q35         $  6.50  →  SPYx    +$0.20   whole market            ← private since 2020
CITY OF OAKLAND PARKING    $  4.50  →  SPYx    +$0.14   whole market            ← no company exists
```

One portfolio, three issuers, one card. **`STARLINK → SPCX` is the line that
does not exist in traditional finance**: SpaceX is private and unavailable in
any brokerage account, and paying your internet bill buys you a piece of it.

## Why this shape

[Crumbs](https://crumbs.family/) has the idea but not the mechanism: it runs on
Robinhood Chain and requires the user to **photograph a receipt** or forward a
confirmation email, with **every claim reviewed by hand**. That leaves the
card-native version unbuilt, which is what this is:

| | Crumbs | this |
| --- | --- | --- |
| Trigger | receipt photo / forwarded email | card authorization stream |
| Verification | manual review | automated merchant resolution |
| Latency | hours to days | seconds |
| Chain | Robinhood Chain | Solana |

The asset side already exists on Solana, but it is **split across issuers with
different catalogues, different symbol conventions and different strengths**:

| issuer | size | convention | character |
| --- | --- | --- | --- |
| **xStocks** (Backed) | ~55 stocks + 4 ETFs | `AAPLx` | index-shaped: pharma, financials, enterprise software. Almost no consumer brands. |
| **Sunrise** (with Backpack) | 20 assets | `COST` | small but consumer-useful, and the only route to `SPCX` (SpaceX) |
| **Ondo Global Markets** | 200+ | `NKEon` | largest by asset count; carries the consumer brands the others miss |

Owys settles across all three and records which issuer each holding came from.
That turns out not to be a nicety — it roughly doubles the product's reach. See
[Coverage](#coverage-measured).

## Documentation

- [docs/OVERVIEW.zh.md](docs/OVERVIEW.zh.md) — 功能说明：每个页面在做什么，真的 vs 模拟的，三个现实约束
- [docs/ARCHITECTURE.zh.md](docs/ARCHITECTURE.zh.md) — 技术说明：链上程序、解析管道、多发行方路由、环境坑

## Quick start

```bash
pnpm install
pnpm mint-tickers     # 101 mock ticker mints on devnet, resumable
pnpm run init-config  # Config PDA at 300 bps
pnpm demo             # scripted end-to-end run, prints explorer links
pnpm server           # dashboard at http://127.0.0.1:4000
pnpm resolver-report  # resolver coverage over every fixture, no chain calls
```

Needs `anchor 0.31.1`, `solana 2.2.x`, Node 22, pnpm, and ~0.3 devnet SOL.
To rebuild the program: `anchor build` (see [Environment notes](#environment-notes) first).

## The app

Four tabs, consumer-first, light, Solana purple. Anything a cardholder would
not care about lives behind a fifth, de-emphasized **Protocol** link.

| tab | what it is |
| --- | --- |
| **Card** | one centred column — the virtual card with its **available-to-spend** balance, then lifetime spend / equity earned / awaiting conversion as statement rows. Nothing else. |
| **Portfolio** | total value, allocation ring, holdings labelled with their issuer, per-ticker **Claim** into the user's own ATA |
| **Activity** | purchase history; each row expands into *"Why NKEon?"* — the resolver's full trace, the issuer it settled through, and the on-chain accrual link |
| **Simulate** | the stand-in for the card network: 35 merchant fixtures, each tap emitting a Stripe-Issuing-shaped authorization into the real webhook |
| Protocol | program addresses, issuer breakdown, resolution mix by dollar, settlement batches, manual keeper run |

Simulation is a tab of its own rather than a panel on the Card page, because it
is the one part of the product that does not exist in production — keeping it
separate means the Card page is exactly what a cardholder would see.

The resolver trace is deliberately *inside* Activity rather than on a dashboard
of its own: a reward the user cannot interrogate is a reward they have to take
on faith, and the same panel that makes the demo convincing is the one that
makes the product trustworthy.

**The card balance is load-bearing, not decoration.** The card is prefunded, and
an authorization above the balance is *declined* — booked with no reward and
struck through in Activity. That is what makes `POST
/webhook/card-authorization` return a real approve/decline decision instead of
always approving, which is the shape a real issuer integration requires. The
balance itself is off-chain: this PoC has no USDC spend vault (see
[What is real](#what-is-real-and-what-is-mocked)).

## Architecture

```
              ┌──────────────────────────────────────────────┐
 card network │  POST /webhook/card-authorization            │
 (mocked)     │  Stripe-Issuing-shaped payload               │
              └───────────────────┬──────────────────────────┘
                                  │  ~2s budget to approve/decline
              ┌───────────────────▼──────────────────────────┐
              │  MerchantResolver        ◄── the hard part   │
              │  descriptor + MCC + network_id → listed co.  │
              └───────────────────┬──────────────────────────┘
                                  │
              ┌───────────────────▼──────────────────────────┐
              │  RewardLedger (off-chain, integer µUSD)      │
              └───────────────────┬──────────────────────────┘
                                  │  async, after the approval
              ┌───────────────────▼──────────────────────────┐
              │  equity_back::accrue_reward                  │
              │  Accrual PDA seeded by card_tx_id  ← replay  │
              └───────────────────┬──────────────────────────┘
                                  │  batched per ticker
              ┌───────────────────▼──────────────────────────┐
              │  SettlementKeeper → swap → settle_distribute │
              │  (mock swap here; Jupiter in production)     │
              └───────────────────┬──────────────────────────┘
                                  │  user signs
              ┌───────────────────▼──────────────────────────┐
              │  equity_back::claim → the user's own ATA     │
              └──────────────────────────────────────────────┘
```

```
programs/equity-back/src/lib.rs   on-chain program (~560 lines)
server/src/brands.ts              56 brands, parent-company mapping
server/src/merchantResolver.ts    the 6-rung resolution ladder
server/src/pipeline.ts            resolve → book → accrue
server/src/keeper.ts              batch settlement
server/src/chain.ts               PDAs, instructions, throttled RPC
server/src/cardSim.ts             mock card network, 30 dirty descriptors
server/public/index.html          the app — 3 tabs, single file, no build step
scripts/demo.ts                   scripted end-to-end run
scripts/resolver-report.ts        coverage table — the loop for tuning brands.ts
```

## What is real and what is mocked

Being precise about this is the point of a PoC.

| | status |
| --- | --- |
| On-chain program, PDAs, replay protection | **real**, deployed to devnet |
| Token custody, `claim` into a user-owned ATA | **real** SPL transfers |
| Per-user positions, on-chain spend/reward totals | **real** program state |
| Merchant resolution pipeline | **real** logic, production-shaped |
| Issuer membership and routing | **real** catalogues; the routing order is fixed, not liquidity-driven |
| Card balance / decline decision | **mock** balance, but it genuinely gates authorization |
| Reward arithmetic (integer µUSD, floored bps) | **real**, matches on-chain exactly |
| Ticker tokens | **mock** mints of 101 real tickers across 3 issuers — the real tokens are mainnet-only |
| The swap | **mock** at a fixed quote — Jupiter in production |
| Price feed | **mock** quotes with a per-minute wobble — Pyth in production |
| Card authorizations | **mock** generator in Stripe Issuing's shape |
| Cardholder wallets | local keypairs — Privy/Turnkey in production |
| USDC spend vault on-chain | **not built** — the balance is off-chain only |

## The merchant resolver

This is where the product actually lives. A card authorization hands you a
descriptor written by whoever configured the merchant's terminal:

```json
{ "merchant_data": { "name": "SQ *BLUE BOTTLE COFFEE", "category_code": "5814",
                     "network_id": "4055500100003" }, "amount": 725 }
```

Six rungs, highest confidence first, and the resolver returns its own reasoning
(`trace`) so every reward is explainable and misses are debuggable:

| rung | mechanism | conf |
| --- | --- | --- |
| 1 | `network_id` cache — seen this merchant before, permanent | 1.00 |
| 2 | brand exact — normalized descriptor contains a known pattern | 0.90–0.98 |
| 3 | brand fuzzy — Levenshtein, survives truncation and typos | ≤0.85 |
| 4 | proxy — brand is private, a listed company is the best exposure | ≤0.55 |
| 5 | closest available basket by MCC — `QQQ` for tech and digital spend | 0.40 |
| 6 | whole market — `SPYx` | 0.20 |

Rung 1 is the moat: hit rate rises monotonically with volume and never decays.

Rung 5 wants to map MCCs to SPDR sector ETFs — a neighbourhood coffee shop has
no stock, but it *is* consumer-staples exposure. **No issuer on Solana carries
sector ETFs today**: xStocks has SPY, QQQ, VTI and GLD; Ondo's ETF coverage is
broad-market too. So the rung collapses to `QQQ` for tech and digital spend and
`SPY` for everything else, and the ladder is five real rungs, not six. Sector
granularity is the second concrete ask for issuers, after ADRs.

**Normalization comes first or everything downstream is wrong.** `PAYPAL
*NIKESTORE` credits PayPal instead of Nike unless the processor prefix is
stripped; `SQ *`, `TST*`, `TOAST*`, `CLOVER*` and a dozen others behave the
same. Store numbers and phone numbers have to go too.

**The interesting entries in `brands.ts` are the ones where brand ≠ listed parent:**

- `WHOLEFDS MKT` → Amazon (subsidiary since 2017 — a brand-name match finds nothing)
- `KFC` / `TACO BELL` / `PIZZA HUT` → one ticker, `YUM`
- `MARSHALLS` / `HOMEGOODS` → `TJX`
- `RALPHS` / `FRED MEYER` → `KR`
- `BLUE BOTTLE` → Nestlé, which trades in the US only as an ADR
- `DUNKIN` → Inspire Brands, **taken private in 2020; there is no stock to give**
- `TRADER JOE S` → privately held, same
- `STARLINK` → SpaceX: private, unavailable in any brokerage account, **but a
  tokenized `SPCX` exists onchain.** This is the one mapping TradFi structurally
  cannot do, and it is the strongest single moment in the demo.

**Identified ≠ available.** `SHELL OIL` resolves to Shell plc with high
confidence, and then the issuer turns out not to have tokenized it. The resolver
carries the identification forward and falls to the energy sector ETF, and the
UI says so. This case is common and pretending otherwise would be dishonest —
Ondo has 200+ tickers, not 4,000.

### Coverage, measured

`pnpm resolver-report` runs the resolver over all 35 merchant fixtures with a
cold cache and no chain calls. It is the loop to iterate in when tuning
`brands.ts`, and it produced the most useful number in this repo.

**Settling only in xStocks:**

```
resolved to a tokenized listed company   13/35  (37%)
identified the company, no token exists  18/35
no company exists to identify             2/35
```

**Settling across xStocks + Sunrise + Ondo:**

```
resolved to a tokenized listed company   28/35  (80%)
identified the company, no token exists   1/35
no company exists to identify             2/35
```

Same resolver, same brand table, same fixtures. **The only change was how many
issuers we settle in, and reach roughly doubled.**

The reason is that the resolver was never the bottleneck: it identifies a listed
parent for **33 of 35 fixtures — 94%** in both runs. What changed is how many of
those it could actually *buy*. Every xStocks-only miss was a ticker Backed does
not issue:

```
CMG  COST  DAL  LYFT  NKE  QSR  SBUX  SHEL  SPCX  SPOT  TGT  TJX  UBER  …
```

That is not a random list. **xStocks' catalogue is index-shaped, not
consumer-shaped** — heavy on pharma (ABBV, ABT, AZN, JNJ, LLY, MRK, NVO, PFE,
TMO), financials (BAC, GS, JPM, MA, V) and enterprise software (ACN, AVGO, CRM,
CRWD, CSCO, IBM, ORCL, PLTR). Exactly right for someone buying index exposure
onchain, and exactly wrong for a card. Sunrise contributes the consumer names
plus `SPCX`; Ondo's 200+ closes most of the rest.

> **The binding constraint is the issuers' ticker lists, not merchant
> resolution.** Multi-issuer routing is worth more than any amount of work on
> the matcher, and it is a day of engineering.

What survives all three catalogues is genuinely irreducible:

| | why |
| --- | --- |
| `BLUE BOTTLE` | Nestlé trades in the US only as an ADR — no issuer here tokenizes ADRs |
| `DUNKIN` | Inspire Brands, private since 2020 |
| `TRADER JOE S` | Aldi Nord, privately held |
| `JOE'S CORNER DELI` | no company exists |
| `CITY OF OAKLAND PARKING` | government; not even a basket applies |

ADRs are the one addressable item left: Nestlé, LVMH, Inditex and Fast Retailing
cover a lot of real-world card spend and no Solana issuer carries them today.
That is a concrete ask to take to Backed or Ondo, and this repo generates the list.

On the 8-tap `pnpm demo` the same measure reads **68% of spend**, with $20.60 of
equity earned across six companies on $686.65 spent.

## On-chain program

The program does one job: be the tamper-proof record of ownership. Card
authorization is off-chain and always will be, so there is no point pretending
otherwise.

```rust
initialize_config(reward_bps)                              // authority
open_user()                                                // user signs
accrue_reward(card_tx_id, spend_usd, symbol, merchant, mcc) // oracle signs
settle_distribute(usd_amount, token_amount)                // treasury signs
claim()                                                    // user signs
```

| account | seeds | role |
| --- | --- | --- |
| `Config` | `["config"]` | rate, signers, global totals |
| `UserAccount` | `["user", owner]` | per-user spend/reward totals |
| `RewardPosition` | `["position", user, mint]` | the user's cap-table row |
| `Accrual` | `["accrual", card_tx_id]` | **existence = already paid** |

Three properties worth defending:

1. **Replay protection is on-chain, not in the application.** `Accrual` is
   seeded by a truncated SHA-256 of the card transaction id, so a webhook
   delivered twice — which card networks absolutely do — fails the second
   `init`. Do not move this off-chain.
2. **The oracle key cannot move tokens.** `accrue_reward` only writes USD-denominated
   entries; every token movement needs the treasury or the user. A compromised
   webhook service mints fake *claims*, not fake *shares*.
3. **Tokens wait in a program vault until claimed**, so a batch of 5,000 rewards
   does not have to create and fund 5,000 ATAs up front.

Rewards are carried as integer micro-dollars, floored, exactly as the program
computes them. Rounding to cents off-chain and summing the cents overshoots
what the program accrued and settlement fails with `InsufficientAccrual` — this
was a real bug during the build, worth keeping in mind for anyone extending it.

## Economics, stated honestly

**3% flat cannot be funded from interchange.** Debit interchange is 0.2–1.2%,
credit 1.5–2%. Any version of this that pays 3% on all spend loses money per
swipe. The fundable structure is:

- ~1% baseline from interchange, plus
- 2–8% merchant-funded on selected brands, via card-linked-offer / affiliate
  networks (Wildfire, Button, Rakuten Advertising, Impact)

This PoC hard-codes 300 bps from a subsidy pool. Anyone who knows payments will
ask this first, so the real answer belongs in the deck, not in a footnote.

## Regulatory constraints

Not obstacles to work around later — they decide the product's shape.

1. **US persons cannot hold xStocks or Ondo GM tokens.** Both issuers exclude
   them. So a token-settled card cannot launch US-first; LatAm (Rain already
   powers MoneyGram's stablecoin Visa card in Colombia) or SEA are the realistic
   openers. A US version is a different product: fractional shares through a
   broker-dealer partner (what Crumbs and Stash Stock-Back do), or genuinely
   registered onchain shares à la Superstate's Opening Bell.
2. **Paying rewards in securities is a securities distribution**, not cashback.
   Gift vs. sale, prospectus obligations, and broker-dealer exemptions all need
   real answers before any user money is involved.
3. **Dividends, cost basis, and tax reporting** are unglamorous and unavoidable
   once positions are real.

## Known limitations and open questions

- **`DOORDASH*BURGER KING`** — two brands, one descriptor. The resolver picks the
  longest pattern (Burger King → RBI), i.e. where the user actually ate, not the
  merchant of record. Defensible, but it is a product decision and should be a
  deliberate one.
- **Proxy mappings are editorial.** `OPENAI → MSFT` is exposure to OpenAI's
  largest investor, not to OpenAI. Flagged as `proxy` with confidence capped at
  0.55 and surfaced in the UI, but whether to offer it at all is a call to make.
- **No LLM rung.** `ResolveContext.llmFallback` is the documented hook and is
  deliberately unused: rungs 1–3 already cover the bulk of spend, and the model
  is a cost you should only pay on the tail.
- **The keeper settles serially per user leg.** Fine at demo scale; production
  wants one transaction per batch with many legs, and a weekend queue (tokenized
  equities trade 24/5, so Saturday rewards must sit in USD until Monday — the UI
  should say so rather than hide it).
- **`MIN_BATCH_USD` defaults to $1**, low enough to keep the demo moving. Real
  batching thresholds follow real swap costs.
- **Issuer routing is a fixed preference, not a market decision.** When several
  issuers carry a ticker the order is `xStocks → Sunrise → Ondo`, hard-coded in
  `tickers.ts`. In production this is a per-trade routing decision against live
  Jupiter quotes: depth and spread differ by issuer, and for a $0.20 reward the
  spread is the whole cost. Three tickers are dual-listed here (IBM, JNJ, PFE);
  on the real catalogues the overlap is much larger.
- **The Ondo block is a representative subset**, not their full 200+: it is
  exactly the tickers this repo's brand table needs that the other two issuers
  do not carry. Coverage numbers are therefore a floor for Ondo, not a ceiling.
- **The ledger is a JSON file with no locking.** The server and `pnpm demo` both
  hold it in memory, so running them together silently clobbers writes —
  duplicate cardholders, doubled authorizations, a merchant cache that looks
  pre-warmed. `pnpm demo` now refuses to start while the server is up
  (`ALLOW_CONCURRENT=1` overrides). Postgres removes the problem; the ledger
  module is the only file that changes.
- **Single wallet wears three hats.** `authority = oracle_signer = treasury` in
  this PoC. In production they are three keys in three places.

## Environment notes

Three real obstacles hit during this build, recorded so the next person doesn't
lose an hour to them.

**1. Broken `cc` (this machine).** `xcode-select` points at an Xcode whose
`USDKit` fails to load, so the host linker cannot run — `anchor build` fails in
a build script and `git` fails too. No sudo needed to work around it:

```bash
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
```

The permanent fix is `sudo xcode-select --switch /Library/Developer/CommandLineTools`.

**2. Cargo dependency drift.** Solana platform-tools v1.48 ships rustc/cargo
1.84, which supports neither `edition2024` nor MSRV ≥1.85. Fresh resolution
pulls in crates that need both. `Cargo.lock` is pinned accordingly — **commit it**:

```
blake3 1.5.5            (1.8.x → digest 0.11 → block-buffer 0.12, edition2024)
proc-macro-crate 3.2.0  (3.5.0 → toml_edit 0.25 → toml_parser, edition2024)
indexmap 2.9.0          (2.14 → hashbrown 0.17, edition2024)
zeroize 1.8.1           (1.9.0 → zeroize_derive 1.5, edition2024)
zeroize_derive 1.4.2
unicode-segmentation 1.12.0  (1.13.3 requires rustc 1.85)
```

To find offenders after a dependency change, scan the locked manifests for
`edition = "2024"` and `rust-version > 1.84` rather than fixing them one
compile error at a time.

**3. Public devnet RPC.** `api.devnet.solana.com` answers 429 under even modest
bursts. `chain.ts` routes every request through a single-file queue with minimum
spacing and exponential backoff, and `mint-mock-tickers.ts` is resumable.
With a paid endpoint:

```bash
RPC_URL=https://... RPC_MIN_INTERVAL_MS=0 pnpm demo
```

## Configuration

| env | default | meaning |
| --- | --- | --- |
| `RPC_URL` | `https://api.devnet.solana.com` | Solana RPC |
| `CLUSTER` | `devnet` | explorer links |
| `WALLET` | `~/my-solana-keypair.json` | authority / oracle / treasury |
| `REWARD_BPS` | `300` | cashback rate |
| `MIN_BATCH_USD` | `1` | keeper settlement threshold |
| `KEEPER_INTERVAL_MS` | `30000` | keeper tick |
| `RPC_MIN_INTERVAL_MS` | `110` | RPC spacing; `0` on a paid endpoint |
| `PORT` | `4000` | dashboard |

## Deployed (devnet)

The on-chain program is still named `equity_back` — the project was renamed to
Owys after deployment, and renaming the crate means a rebuild and redeploy. The
program ID is unaffected either way; say the word and it is a five-minute change.

- program `BuM8wmDCcUu3uJwphiN5vBEMxGPggL1Kui9greZaHK4` (crate `equity_back`)
- config PDA `8K1twtk4jmQv33uiLcHtbL5tuf3tXph7x1wJTrZXBjtS`
- 101 mock ticker mints in `.mock-tickers.json` (57 xStocks · 17 Sunrise · 27 Ondo)

## Next steps to de-mock

1. **Swap** — replace `mockSwap` with a Jupiter quote + swap on mainnet, one
   ticker, tiny size. Proves real liquidity and real slippage at $0.20–$50.
   This is the single highest-information next move.
2. **Verify the asset side, per issuer** — are xStocks / Ondo / Sunrise tokens
   Token-2022? Any transfer hook or allowlist restricting distribution to
   arbitrary user wallets? What decimals? This gates whether free distribution
   works at all, and the answer may differ by issuer — which would make issuer
   routing a compliance decision, not just a liquidity one.
3. **Real card sandbox** — point Stripe Issuing test mode at
   `/webhook/card-authorization` and return an actual approve/decline.
4. **Embedded wallets** — Privy or Turnkey plus a fee payer, so users never see
   a keypair.
5. **Measure the real hit rate** — point `pnpm resolver-report` at an
   anonymized sample of real descriptors. 77% over 30 hand-picked fixtures is
   not a forecast; the real number is the product's ceiling and every
   projection depends on it.
