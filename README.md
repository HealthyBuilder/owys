# Owys

> **Spend at a company, own a piece of it.**

A virtual card that returns 3% of every purchase as tokenized stock **in the
company you just bought from**, delivered to a wallet only the cardholder
controls.

Proof of concept. Runs end to end on Solana devnet with mock mints of the real
tokenized-equity catalogues.

```
NIKE.COM 8006536453        $120.00  →  NKEon   +$3.60   Ondo
WHOLEFDS MKT #10255        $ 86.40  →  AMZNx   +$2.59   xStocks   ← via parent company
GEICO *AUTO PREMIUM        $142.00  →  BRK.Bx  +$4.26   xStocks   ← via parent company
STARLINK INTERNET          $120.00  →  SPCX    +$3.60   Sunrise   ← a private company
OPENAI CHATGPT SUBSCR      $200.00  →  MSFTx   +$6.00   xStocks   ← proxy exposure
SQ *BLUE BOTTLE COFFEE     $  7.25  →  SPYx    +$0.22             ← parent is an ADR
DUNKIN #336781 Q35         $  6.50  →  SPYx    +$0.20             ← private company
CITY OF OAKLAND PARKING    $  4.50  →  SPYx    +$0.14             ← no company exists
```

## Quick start

```bash
pnpm install
pnpm mint-tickers      # mock mints on devnet, resumable
pnpm run init-config   # Config PDA at 300 bps
pnpm server            # http://127.0.0.1:4000
```

Needs `anchor 0.31.1`, `solana 2.2.x`, Node 22, pnpm, and ~0.3 devnet SOL.

Two more commands worth knowing:

```bash
pnpm demo              # scripted end-to-end run, prints explorer links
pnpm resolver-report   # merchant coverage report, no chain calls
```

## How it works

```
swipe → identify the company behind the merchant → book 3% on-chain
      → batch-convert per ticker → stock lands in the user's own wallet
```

Four screens — **Card**, **Portfolio**, **Activity**, **Simulate** — plus a
de-emphasised **Protocol** view holding the program addresses, issuer
breakdown, resolution mix and settlement batches.

Settlement spans multiple tokenized-equity issuers, and every holding records
which one it came from.

## What is real, what is mocked

| | |
| --- | --- |
| On-chain program, PDAs, replay protection | **real**, deployed to devnet |
| Token custody and `claim` into a user-owned ATA | **real** SPL transfers |
| Merchant resolution, issuer routing, reward arithmetic | **real** |
| Ticker tokens | **mock** mints of 101 real tickers |
| Swap, prices, card authorizations, card balance | **mock** |
| On-chain USDC spend vault | not built |

## Documentation

- [docs/OVERVIEW.md](docs/OVERVIEW.md) — what each screen does, what is real and what is mocked
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — on-chain program, resolver, issuer routing

## Deployed (devnet)

- program `BuM8wmDCcUu3uJwphiN5vBEMxGPggL1Kui9greZaHK4` (crate `equity_back`)
- config PDA `8K1twtk4jmQv33uiLcHtbL5tuf3tXph7x1wJTrZXBjtS`
- 101 mock ticker mints in `.mock-tickers.json`
