import 'dotenv/config';
import { buildApp } from './app.js';
import { admobAllowedAdUnits, env } from './config/env.js';
import { closeDb } from './db/index.js';
import { closeRedis } from './redis/index.js';

const app = await buildApp();

if (admobAllowedAdUnits().length === 0) {
  app.log.warn(
    'ADMOB_ALLOWED_AD_UNITS is empty: AdMob SSV callbacks from any ad unit will be credited',
  );
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.all([closeDb(), closeRedis()]);
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
