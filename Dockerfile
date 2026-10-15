FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./

FROM base AS deps
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm admin:build && pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:20-alpine AS api
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/admin/dist ./admin/dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY package.json ./
CMD ["node", "dist/server.js"]

FROM node:20-alpine AS worker
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
# Fonts the AI cover compositor draws titles with (resolved relative to dist/).
COPY --from=build /app/assets ./assets
COPY package.json ./
CMD ["node", "dist/worker.js"]
