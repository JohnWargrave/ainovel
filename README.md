# BE-AINovel — AINovel backend

Coin-economy backend: offerwall/postback gateway, double-entry ledger, fraud engine, redemption
fulfillment, Lucky Spin, referral, drama (watch-to-earn) module, admin API.

Status: business modules implemented (auth, ledger, postback, fraud, redemption, spin,
rewarded ads, drama, referral, catalog, inbox, admin CMS).

## Stack

- Node.js 20 + TypeScript 5 (strict)
- Fastify 5 + TypeBox
- PostgreSQL 16 via Kysely (query builder, not an ORM) + node-pg-migrate (raw SQL migrations)
- Redis via ioredis — 4 role-separated clients (cache / rate-limit / lock / queue)
- BullMQ, with the worker (`worker.ts`) as a separate process from the API (`server.ts`)
- Vitest, integration tests run against real Postgres/Redis (no DB mocking on ledger/fraud/postback paths)
- ESLint (typescript-eslint strict + eslint-plugin-security) + Prettier, enforced via Husky + lint-staged
- Conventional Commits, enforced via commitlint

## Local setup

```bash
corepack enable
pnpm install
cp .env.example .env   # already gitignored; fill in real values for anything beyond local dev
docker-compose up -d   # Postgres 16 + Redis — or point DATABASE_URL/REDIS_URL at local installs
pnpm migrate:up
pnpm dev                # API on :3000
pnpm dev:worker          # BullMQ worker, separate process
```

## Scripts

| Script                                                | Purpose                          |
| ----------------------------------------------------- | -------------------------------- |
| `pnpm dev` / `pnpm dev:worker`                        | Run API / worker with watch mode |
| `pnpm build`                                          | Compile to `dist/`               |
| `pnpm migrate:up` / `migrate:down` / `migrate:create` | node-pg-migrate                  |
| `pnpm test` / `test:coverage`                         | Vitest                           |
| `pnpm lint` / `lint:fix`                              | ESLint                           |
| `pnpm typecheck`                                      | `tsc --noEmit`                   |

## Layout

```
src/
  server.ts       API entrypoint (Fastify)
  worker.ts       BullMQ worker entrypoint — separate process, never run inside server.ts
  app.ts          Fastify instance builder (shared by server.ts and tests)
  config/         Env schema (TypeBox), fail-fast on missing/invalid vars
  db/             Kysely instance + hand-written types.ts mirroring the schema
  db/migrations/  node-pg-migrate, raw SQL, one file per schema doc section
  redis/          4 role-separated ioredis clients
  plugins/        Fastify plugins (error handler → {error:{code,message}})
  jobs/           BullMQ queue/worker registration
  modules/        Business logic, one folder per domain
  lib/            Shared helpers (errors, etc.)
```

## Secrets

`.env` is for local dev only and gitignored. Production injects real secrets via a secret
manager (Doppler/Infisical) — never commit real values, including in CI config.
