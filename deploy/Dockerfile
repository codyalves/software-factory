# One image definition for every service. Node runs the TypeScript sources
# directly (type stripping), so there is no build step. Build with:
#   docker build -f deploy/Dockerfile --build-arg ENTRY=apps/api/src/server.ts .

FROM node:26-slim AS deps
WORKDIR /app
RUN corepack enable
# Manifests first, so dependency layers are cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/workers/package.json apps/workers/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY packages/github/package.json packages/github/
RUN pnpm install --frozen-lockfile --prod

FROM node:26-slim
ARG ENTRY
ENV NODE_ENV=production \
    FACTORY_ENTRY=${ENTRY}
WORKDIR /app
COPY --from=deps /app ./
COPY db ./db
COPY apps ./apps
COPY packages ./packages
USER node
CMD ["sh", "-c", "exec node \"$FACTORY_ENTRY\""]
