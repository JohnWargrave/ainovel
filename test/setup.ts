// Global vitest setup. Integration tests hit the real Postgres/Redis from docker-compose.yml
// (env vars injected via vitest.config.ts) — no DB/Redis mocking on the ledger/fraud/postback path.
export {};
