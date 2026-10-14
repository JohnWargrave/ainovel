import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Wipes accumulated test data once per run — see test/global-setup.ts for why it can't live in
    // setupFiles (which runs per worker, in parallel).
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 10_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://ainovel:ainovel@localhost:5432/ainovel',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'test-only',
      JWT_REFRESH_SECRET: 'test-only-too',
      DELIVERY_CODE_ENC_KEY: 'test-only-32-bytes-minimum-length',
      ADMIN_API_KEY: 'test-admin-api-key',
      ADMIN_CSRF_TOKEN: 'test-admin-csrf-token',
      ENABLE_LEGACY_ADMIN_API_KEY: 'true',
      ENABLE_TEST_COIN_API: 'true',
      TRUST_PROXY: '127.0.0.1/32',
      MIN_SUPPORTED_APP_VERSION: '1.0.0',
      REFERRAL_SHARE_BASE_URL: 'https://links.ainovel.test/r/',
      NOVEL_SHARE_BASE_URL: 'https://links.ainovel.test/n',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
