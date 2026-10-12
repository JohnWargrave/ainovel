import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';

export interface AuthEventContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
  deviceId?: string | undefined;
}

export interface AuthEventInput extends AuthEventContext {
  userId?: string | null | undefined;
  provider: string;
  eventType: string;
  outcome: 'success' | 'failure';
  failureCode?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export async function recordAuthEvent(input: AuthEventInput, trx?: Transaction<DB>): Promise<void> {
  await (trx ?? db)
    .insertInto('auth_events')
    .values({
      id: uuidv7(),
      user_id: input.userId ?? null,
      provider: input.provider,
      event_type: input.eventType,
      outcome: input.outcome,
      failure_code: input.failureCode ?? null,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
      device_id: input.deviceId ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
    })
    .execute();
}
