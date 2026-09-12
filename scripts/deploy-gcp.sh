#!/usr/bin/env bash
#
# Deploy Owys to Google Cloud Run.
#
# Run it after `gcloud auth login` and `gcloud config set project <id>`.
# Everything here is idempotent — re-running redeploys the current source.
#
#   ./scripts/deploy-gcp.sh
#
# Environment overrides:
#   REGION       deployment region            (default us-central1)
#   SERVICE      Cloud Run service name       (default owys)
#   WALLET       local keypair to upload      (default ~/.config/solana/id.json)
#   RPC_URL      Solana RPC for the service   (default public devnet)

set -euo pipefail

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-owys}"
SECRET_NAME="${SECRET_NAME:-owys-wallet}"
WALLET="${WALLET:-$HOME/.config/solana/id.json}"
RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

command -v gcloud >/dev/null || die "gcloud not installed — see docs/DEPLOY.md"

PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
[ -n "$PROJECT" ] && [ "$PROJECT" != "(unset)" ] \
  || die "no project set — run: gcloud config set project <PROJECT_ID>"

gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || die "not authenticated — run: gcloud auth login"

[ -f "$WALLET" ] || die "keypair not found at $WALLET (set WALLET=/path/to/keypair.json)"
[ -f .mock-tickers.json ] || die ".mock-tickers.json missing — run: pnpm mint-tickers"
[ -f idl/equity_back.json ] || die "idl/equity_back.json missing — run: anchor build && cp target/idl/equity_back.json idl/"

echo "project : $PROJECT"
echo "region  : $REGION"
echo "service : $SERVICE"

step "1/4  enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com --quiet

step "2/4  storing the wallet key in Secret Manager"
# The service signs accruals and settlement transfers, so it needs the key.
# It goes in Secret Manager rather than an env var or the image so it is never
# printed in deploy logs or baked into a layer.
if gcloud secrets describe "$SECRET_NAME" --quiet >/dev/null 2>&1; then
  echo "  secret $SECRET_NAME exists — adding a new version"
  gcloud secrets versions add "$SECRET_NAME" --data-file="$WALLET" --quiet >/dev/null
else
  gcloud secrets create "$SECRET_NAME" --data-file="$WALLET" \
    --replication-policy=automatic --quiet >/dev/null
  echo "  created secret $SECRET_NAME"
fi

step "3/4  granting the Cloud Run service account access"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/secretmanager.secretAccessor --quiet >/dev/null
echo "  ${RUNTIME_SA} can read ${SECRET_NAME}"

step "4/4  deploying"
# --max-instances=1 is a correctness constraint, not a cost tweak: the ledger is
# a JSON file with no locking, so a second instance would silently clobber the
# first one's writes. Swap the ledger for Postgres before scaling past one.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=1 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=300 \
  --set-env-vars="CLUSTER=devnet,RPC_URL=${RPC_URL},DATA_DIR=/tmp/owys,REWARD_BPS=300" \
  --set-secrets="WALLET_SECRET_KEY=${SECRET_NAME}:latest" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
printf '\n\033[1mdeployed\033[0m  %s\n\n' "$URL"
echo "  health check:"
echo "    curl -s $URL/api/state | head -c 200"
