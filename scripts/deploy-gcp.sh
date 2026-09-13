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
#   WALLET       local keypair to upload      (default: the Solana CLI's configured keypair)
#   RPC_URL      Solana RPC for the service   (default public devnet)

set -euo pipefail

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-owys}"
SECRET_NAME="${SECRET_NAME:-owys-wallet}"
SEED_SECRET="${SEED_SECRET:-owys-seed}"
SEED_FILE_PATH="${SEED_FILE_PATH:-seed/demo-data.json}"
RUN_SA_ID="${RUN_SA_ID:-owys-run}"
# Resolve the same keypair the server resolves, or the deployed service signs
# with a key the program does not recognise and every accrual is rejected.
cli_keypair() {
  local cfg="$HOME/.config/solana/cli/config.yml"
  [ -f "$cfg" ] || return 1
  sed -n 's/^[[:space:]]*keypair_path:[[:space:]]*//p' "$cfg" | head -1 | sed "s|^~|$HOME|"
}
WALLET="${WALLET:-$(cli_keypair || echo "$HOME/.config/solana/id.json")}"
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

step "1/5  enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com --quiet

step "2/5  storing the wallet key in Secret Manager"
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

# Cloud Run scales to zero onto a tmpfs, so a cold start begins with an empty
# ledger. Shipping the demo dataset as a secret lets the service restore it —
# it carries cardholder private keys, so it does not belong in the image.
if [ -f "$SEED_FILE_PATH" ]; then
  echo "  seeding from ${SEED_FILE_PATH}"
  SEED_B64="$(gzip -c "$SEED_FILE_PATH" | base64)"
  if gcloud secrets describe "$SEED_SECRET" --quiet >/dev/null 2>&1; then
    printf '%s' "$SEED_B64" | gcloud secrets versions add "$SEED_SECRET" --data-file=- --quiet >/dev/null
  else
    printf '%s' "$SEED_B64" | gcloud secrets create "$SEED_SECRET" --data-file=- \
      --replication-policy=automatic --quiet >/dev/null
  fi
  SEED_ARG="--set-secrets=WALLET_SECRET_KEY=${SECRET_NAME}:latest,SEED_JSON=${SEED_SECRET}:latest"
else
  echo "  no ${SEED_FILE_PATH} — deploying without demo data"
  SEED_ARG="--set-secrets=WALLET_SECRET_KEY=${SECRET_NAME}:latest"
fi

step "3/5  creating a least-privilege runtime identity"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
RUN_SA="${RUN_SA_ID}@${PROJECT}.iam.gserviceaccount.com"

# Cloud Run defaults to the Compute Engine service account, which Google grants
# roles/editor on the project. Running with it means any code execution inside
# the container can mint a project-Editor token from the metadata server — read
# every secret, create VMs, spend the billing account. This service needs to
# read one secret and write logs, so give it an identity that can do only that.
if ! gcloud iam service-accounts describe "$RUN_SA" --quiet >/dev/null 2>&1; then
  gcloud iam service-accounts create "$RUN_SA_ID" \
    --display-name="Owys Cloud Run runtime" --quiet >/dev/null
  echo "  created ${RUN_SA}"
fi

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${RUN_SA}" --role=roles/logging.logWriter --quiet >/dev/null
for secret in "$SECRET_NAME" "$SEED_SECRET"; do
  gcloud secrets describe "$secret" --quiet >/dev/null 2>&1 || continue
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${RUN_SA}" \
    --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done
echo "  ${RUN_SA}: logging.logWriter + secretAccessor on its own secrets, nothing else"

step "4/5  granting the build service account its roles"
# New projects no longer grant the Compute Engine default service account the
# Cloud Build role automatically, and `gcloud run deploy --source` fails with
# PERMISSION_DENIED reading its own uploaded source. Granting it is the
# documented fix: cloud.google.com/run/docs/configuring/services/build-service-account
# These are build-time only, and stay on the build identity rather than the
# identity the service actually runs as.
for role in roles/cloudbuild.builds.builder roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${BUILD_SA}" --role="$role" --quiet >/dev/null
  echo "  ${role}"
done
# IAM propagation is not instant; a deploy fired immediately often still fails.
sleep 20

step "5/5  deploying"
# --max-instances=1 is a correctness constraint, not a cost tweak: the ledger is
# a JSON file with no locking, so a second instance would silently clobber the
# first one's writes. Swap the ledger for Postgres before scaling past one.
#
# --min-instances=0 lets it scale to zero, which keeps it inside the free tier.
# The cost is that an idle instance is reclaimed and demo state goes with it —
# on-chain positions survive, the dashboard's view of them does not.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --service-account "$RUN_SA" \
  --min-instances=0 \
  --max-instances=1 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=300 \
  --set-env-vars="CLUSTER=devnet,RPC_URL=${RPC_URL},DATA_DIR=/tmp/owys,REWARD_BPS=300" \
  "$SEED_ARG" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
printf '\n\033[1mdeployed\033[0m  %s\n\n' "$URL"
echo "  health check:"
echo "    curl -s $URL/api/state | head -c 200"
