# Owys — the dashboard server.
#
# TypeScript is executed directly with tsx rather than compiled, so the image
# carries the full dependency tree. That is a deliberate PoC trade-off: one
# fewer build step, a larger image.

FROM node:22-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack resolves the version from package.json's `packageManager` field, so
# the image installs with exactly the pnpm the lockfile was written by.
RUN corepack enable

WORKDIR /app

# Dependencies first so edits to source do not invalidate the install layer.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# The container filesystem is read-only apart from /tmp, so mutable state
# (ledger, demo keypairs) has to live there. See server/src/paths.ts.
ENV DATA_DIR=/tmp/owys
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["pnpm", "exec", "tsx", "server/src/server.ts"]
