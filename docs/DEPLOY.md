# Deploying to Google Cloud Run

The dashboard is a single Node service with no database, so Cloud Run is the
natural fit. One script does the whole thing; the prerequisites below are the
part only you can do, because they need your Google account.

## Prerequisites

**1. Install the gcloud CLI** (not currently installed on this machine):

```bash
brew install --cask google-cloud-sdk
```

**2. Authenticate and pick a project:**

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

Create a project first if you need one — `gcloud projects create owys-demo`
— and make sure billing is enabled on it. Cloud Run's free tier covers a demo
of this size comfortably, but the API refuses to deploy without a billing
account attached.

## Deploy

```bash
./scripts/deploy-gcp.sh
```

It is idempotent — run it again to redeploy after any change. What it does:

1. enables the Run, Cloud Build, Secret Manager and Artifact Registry APIs
2. uploads your Solana keypair into Secret Manager as `owys-wallet`
3. grants the Cloud Run runtime service account read access to that secret
4. builds from source and deploys, printing the service URL

Overrides, all optional:

```bash
REGION=asia-east1 SERVICE=owys-demo RPC_URL=https://your-rpc ./scripts/deploy-gcp.sh
```

## Configuration

| env | default | meaning |
| --- | --- | --- |
| `WALLET_SECRET_KEY` | — | the keypair as a JSON array or base64. Injected from Secret Manager; takes precedence over `WALLET` |
| `DATA_DIR` | repo root | where the ledger and demo keypairs are written. Set to `/tmp/owys` in the image |
| `RPC_URL` | public devnet | Solana RPC |
| `CLUSTER` | `devnet` | drives the explorer links |
| `REWARD_BPS` | `300` | cashback rate |
| `PORT` | `8080` in the image | Cloud Run sets this |
| `RPC_MIN_INTERVAL_MS` | `110` | RPC spacing; set `0` on a paid endpoint |

## Four things to know before you share the URL

**1. State is ephemeral.** The ledger is a JSON file on `/tmp`, which on Cloud
Run is an in-memory tmpfs. A cold start wipes every cardholder, purchase and
settlement. On-chain state survives — positions, accruals and claimed tokens are
all still there — but the dashboard will not show them until someone spends
again. Fine for a demo; swap the ledger for Cloud SQL before it is anything else.

**2. The service is pinned to one instance.** `--max-instances=1` is a
correctness constraint, not a cost tweak: the JSON ledger has no locking, so a
second instance would silently clobber the first one's writes. Moving to
Postgres is what unlocks scaling, and it touches exactly one file
(`server/src/ledger.ts`).

**3. The service holds a signing key.** It has to — it signs reward accruals and
settlement transfers. On devnet the blast radius is play money, but the same
deployment shape on mainnet would need the three roles split apart
(`authority` in a multisig, `oracle` here, `treasury` wherever inventory
actually lives) rather than one key wearing all three hats.

**4. It is open to the world and it spends.** `--allow-unauthenticated` is what
makes it demoable, but every new cardholder costs the treasury ~0.02 devnet SOL
plus rent, and every purchase costs transaction fees. A few hundred visitors
will drain the wallet. Top it up from a devnet faucet, or drop
`--allow-unauthenticated` and put an identity-aware proxy in front.

## Public devnet RPC from a cloud IP

`api.devnet.solana.com` rate-limits shared cloud egress harder than a home
connection. The client already queues requests with backoff, but if the deployed
service feels slow, point it at a paid endpoint:

```bash
RPC_URL=https://your-helius-or-triton-url ./scripts/deploy-gcp.sh
```

and set `RPC_MIN_INTERVAL_MS=0` to remove the local spacing.

## Verifying a deployment

```bash
URL=$(gcloud run services describe owys --region us-central1 --format='value(status.url)')
curl -s "$URL/api/state" | head -c 300     # program id, issuers, stats
open "$URL"
```

If the service fails to start, the two usual causes are a missing
`.mock-tickers.json` in the upload (check `.gcloudignore` — gcloud falls back to
`.gitignore` when that file is absent, which would strip it) and a
`WALLET_SECRET_KEY` that did not decode to 64 bytes.

```bash
gcloud run services logs read owys --region us-central1 --limit 50
```

## Running the container locally

```bash
docker build -t owys:local .
docker run --rm -p 8080:8080 \
  -e WALLET_SECRET_KEY="$(cat ~/my-solana-keypair.json)" \
  owys:local
open http://127.0.0.1:8080
```
