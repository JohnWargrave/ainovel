import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const REQUIRED_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://example',
  REDIS_URL: 'redis://example',
  JWT_ACCESS_SECRET: 'access',
  JWT_REFRESH_SECRET: 'refresh',
  DELIVERY_CODE_ENC_KEY: 'delivery',
  ADMIN_API_KEY: 'admin',
  ADMIN_CSRF_TOKEN: 'csrf',
};

describe('environment parsing', () => {
  it('parses a string-valued PORT without falling back to the default', () => {
    expect(loadEnv({ ...REQUIRED_ENV, PORT: '3101' }).PORT).toBe(3101);
  });

  it('rejects an invalid PORT instead of silently binding the default port', () => {
    expect(() => loadEnv({ ...REQUIRED_ENV, PORT: 'not-a-port' })).toThrow(
      'Invalid environment configuration',
    );
  });
});
