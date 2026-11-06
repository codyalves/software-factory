# One image definition for every service. Node runs the TypeScript sources
# directly (type stripping), so there is no build step. Build with:
#   docker build -f deploy/Dockerfile --build-arg ENTRY=apps/api/src/server.ts .

FROM node:26-slim AS deps
WORKDIR /app
# Node 25+ no longer bundles corepack, so pnpm is installed directly.
RUN npm install -g pnpm@12.16.1
# Manifests first, so dependency layers are cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/workers/package.json apps/workers/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY packages/github/package.json packages/github/
COPY packages/decisions/package.json packages/decisions/
RUN pnpm install --frozen-lockfile --prod

FROM node:26-slim
# Workers clone target repositories, run Claude Code in them, and run their gates.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.319 pnpm@12.16.1
ARG ENTRY
ENV NODE_ENV=production \
    FACTORY_ENTRY=${ENTRY}
WORKDIR /app
COPY --from=deps /app ./
COPY db ./db
COPY apps ./apps
COPY packages ./packages
COPY prompts ./prompts
COPY gates ./gates
USER node
CMD ["sh", "-c", "exec node \"$FACTORY_ENTRY\""]
