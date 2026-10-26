# One image for both services; docker-compose picks the target.
FROM node:22.23-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ENV CI=true
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/gate/package.json apps/gate/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/connectors/package.json packages/connectors/
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY packages/db/prisma packages/db/prisma
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @gate/db generate

FROM base AS gate
USER node
EXPOSE 4000
CMD ["pnpm", "--filter", "@gate/gate", "start"]

FROM base AS web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @gate/web build && chown -R node:node apps/web/.next
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@gate/web", "start"]
