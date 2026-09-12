# Owys — what it does

> **Spend at a company, own a piece of it.**
> A virtual card that returns 3% of every purchase as tokenized stock in the
> company you just bought from, delivered to a wallet only the cardholder
> controls.

This document covers what the proof of concept implements, what each part is
for, and which parts are real. For how it is built, see
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## In one minute

```
swipe  →  identify the company behind the merchant  →  book 3% on-chain
       →  batch-convert per ticker                  →  stock lands in the
                                                       user's own wallet
```

The whole thing is card-native. No receipts to photograph, no emails to
forward, no manual review: the card authorization stream triggers everything,
merchant identification is automatic, and settlement happens in seconds.

---

## The four screens

Navigation is **Card · Portfolio · Activity · Simulate**, with a deliberately
de-emphasised **Protocol** view in the corner.

### Card — everything a cardholder sees

One centred column: the card, then three statement rows.

| | |
| --- | --- |
| **Available to spend** | Prefunded balance. An authorization above it is **declined**. |
| **Total spent** | Lifetime spend and purchase count |
| **Equity earned** | Value of stock received, and how many companies it spans |
| **Awaiting conversion** | Booked but not yet converted — non-zero over a weekend, or below the batch threshold |

**The balance is load-bearing, not decoration.** A purchase above it is
genuinely refused, earns nothing, and appears struck through in Activity. That
is what makes the webhook return a real approve/decline decision instead of
always approving — the shape a real issuer integration requires.

### Portfolio — the holdings your spending built

Total value and an allocation ring, then every position labelled with its token
symbol and issuer — `NKEon · Ondo Global Markets`, `SPCX · Sunrise`,
`AMZNx · xStocks`.

**Claim** moves the tokens out of the program vault and into the cardholder's
own associated token account. That step is the entire claim of the product:
afterwards the stock sits in a wallet nobody else controls, not as a balance on
someone's books.

### Activity — the ledger, and why each stock

Each row shows the raw merchant descriptor, the amount, the reward, the token
bought and the issuer it came from.

**Expand any row** and the resolver shows its full reasoning:

```
raw "STARLINK INTERNET" (MCC 4899 · Cable / Streaming)
normalized -> "STARLINK INTERNET"
stage 2 brand_exact "STARLINK" -> Starlink (MCC corroborates)
  listed parent: Space Exploration Technologies (SPCX)
  note: SpaceX is private and unavailable in any brokerage account —
        but a tokenized SPCX exists onchain.
  settling in SPCX via Sunrise
```

This lives inside the transaction rather than on a dashboard of its own on
purpose: **a reward the user cannot interrogate is one they have to take on
faith.** The panel that makes a demo convincing and the panel that makes the
product trustworthy are the same panel.

### Simulate — the stand-in for the card network

35 realistically ugly merchant descriptors. Each tap emits a Stripe-Issuing-
shaped authorization into the same webhook a real issuer would call. Every
fixture carries a note explaining what it demonstrates — processor prefixes,
parent-company mappings, brands with no stock behind them.

It is a tab of its own because it is the one part of the product that does not
exist in production. Keeping it separate means the Card screen is exactly what a
cardholder would see.

### Protocol — the lid off

Tucked in the corner and visually muted, because a cardholder does not need it.
It exists for engineers and for diligence: it is the evidence that the other
four screens are not theatre.

| section | what it shows | why it matters |
| --- | --- | --- |
| **Deployment** | cluster, program address, config PDA, treasury, reward rate in bps, on-chain accrual count, cumulative spend / accrued / settled, cached merchants, batch threshold | the program address links to a block explorer — **anyone can verify the on-chain state themselves rather than trusting this UI** |
| **Issuers** | how many tickers each issuer contributes | this number determines the product's reach directly |
| **How spend resolved** | spend distribution across resolution stages | shows at a glance how much money mapped to a specific company and how much fell back — the core health metric |
| **Settlement batches** | per-batch conversion detail, execution price, on-chain legs, plus a manual trigger | proves rewards are converted **in batches per ticker**, not once per swipe, which is what makes 3% on a coffee economically possible |

---

## How it works, in three parts

### 1. Merchant resolution: dirty string to listed parent

A card network hands over descriptors written by whoever configured the
merchant's terminal: `SQ *BLUE BOTTLE COFFEE`, `TST* CHIPOTLE 2841`,
`PAYPAL *NIKESTORE`, `WHOLEFDS MKT #10255`.

Six rungs, highest confidence first:

| rung | mechanism | confidence |
| --- | --- | --- |
| 1 | **network_id cache** — this merchant has been seen before, remembered permanently | 1.00 |
| 2 | brand exact match | 0.90–0.98 |
| 3 | brand fuzzy match, tolerant of typos and truncation | ≤0.85 |
| 4 | **proxy exposure** — the brand is unlisted, a listed company is the closest thing | ≤0.55 |
| 5 | closest available basket by merchant category | 0.40 |
| 6 | whole market | 0.20 |

Rung 1 is the moat: hit rate rises monotonically with volume and never decays.

**The valuable entries are the ones where brand ≠ listed parent**, which is
where a naive string match gets it wrong:

- `WHOLEFDS MKT` → Amazon (a subsidiary since 2017; the brand name alone finds nothing)
- `GEICO *AUTO PREMIUM` → Berkshire Hathaway (a car insurance premium buys BRK.B)
- `DQ GRILL` → also Berkshire (two unrelated-looking descriptors, one ticker)
- `KFC` / `TACO BELL` / `PIZZA HUT` → one ticker, YUM
- `MARSHALLS` / `HOMEGOODS` → one ticker, TJX
- `DUNKIN` → taken private in 2020; there is genuinely no stock to give
- `STARLINK` → SpaceX: private, unavailable in any brokerage account, **and tokenized onchain**

That last one is structurally impossible in traditional finance, and it is the
strongest moment in a demo.

### 2. Multiple issuers, one card

Tokenized equities on Solana are not one market. Supply is split across issuers
with different catalogues and different symbol conventions, and settling in only
one of them inherits that one's blind spots. Owys settles across all of them and
records which issuer every holding came from.

### 3. Rewards are booked on-chain, and cannot be replayed

Every reward writes an `Accrual` account whose address derives from the **card
transaction id**. Card networks redeliver webhooks as a matter of course; the
second delivery simply fails to create the account. **Replay protection lives
on-chain, not in application code.**

Separately, the key that books rewards can never move tokens. A compromised
webhook service can fabricate claims, not shares.

---

## What is real and what is mocked

The most important section in this document.

| | |
| --- | --- |
| On-chain program, PDAs, replay protection | **real** — deployed to devnet |
| Token custody, claim into a user-owned account | **real** SPL transfers |
| Per-user positions, on-chain spend and reward totals | **real** program state |
| Merchant resolution pipeline | **real** logic, production-shaped |
| Issuer catalogues and routing | **real** membership |
| Reward arithmetic (integer micro-dollars, floored) | **real**, bit-identical to the program |
| Ticker tokens | **mock** mints of 101 real tickers |
| Conversion | **mock** at a fixed quote |
| Prices | **mock** quotes |
| Card authorizations | **mock** generator in a real webhook shape |
| Card balance and decline decision | **mock** balance that genuinely gates authorization |
| Cardholder wallets | local keypairs; an embedded-wallet provider in production |
| On-chain USDC spend vault | **not built** — the balance is off-chain only |

---

## Three constraints that decide the product

Not obstacles to handle later. They determine what this can be.

**1. 3% flat cannot be funded from interchange.** Debit interchange runs
0.2–1.2%, credit 1.5–2%. Any version paying 3% on all spend loses money per
swipe. The fundable structure is roughly 1% baseline from interchange plus 2–8%
merchant-funded on selected brands through card-linked-offer networks. This PoC
hard-codes 300 bps from a subsidy pool. Anyone who knows payments asks this
first.

**2. The major issuers exclude US persons.** A token-settled card therefore
cannot launch US-first. A US version is a different product: fractional shares
through a broker-dealer partner, or genuinely registered onchain shares.

**3. Paying rewards in securities is a securities distribution**, not cashback.
Gift versus sale, prospectus obligations and broker-dealer exemptions all need
real answers before any user money is involved.

---

## Running it

```bash
pnpm install
pnpm mint-tickers      # mock mints, resumable
pnpm run init-config   # config PDA at 300 bps
pnpm server            # http://127.0.0.1:4000
```

Two more worth knowing:

```bash
pnpm demo              # scripted end-to-end run, prints explorer links
pnpm resolver-report   # merchant coverage report, no chain calls
```
