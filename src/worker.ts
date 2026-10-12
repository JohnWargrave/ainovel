import 'dotenv/config';
import pino from 'pino';
import { env } from './config/env.js';
import { closeDb } from './db/index.js';
import { closeRedis } from './redis/index.js';
import { registerJobs } from './jobs/index.js';

// Separate entrypoint/process from server.ts by design (D15, 15 §2, §5) — running BullMQ
// workers inside the API process would double-run jobs the moment the API scales to >1 instance.
const logger = pino({ level: env.LOG_LEVEL });

const workers = await registerJobs(logger);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all([closeDb(), closeRedis()]);
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

logger.info('worker ready');
