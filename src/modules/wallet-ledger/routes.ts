import type { FastifyInstance } from 'fastify';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import { AppError } from '../../lib/errors.js';
import { db } from '../../db/index.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { FROZEN_HOLD_UNTIL } from '../referral/referral-credit.service.js';
import { entryLabel } from './entry-labels.js';
import {
  LedgerQuerySchema,
  WalletLedgerResponseSchema,
  WalletResponseSchema,
  type LedgerQuery,
} from './schemas.js';

const PROVIDER_LABELS: Record<string, string> = {
  tapjoy: 'Tapjoy',
  pubscale: 'PubScale',
  adgate: 'AdGate',
  adjoe: 'adjoe',
  appsprize: 'AppsPrize',
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

// A pending entry's release time, unless it is frozen for review (a placeholder far-future date the
// app must not render as a countdown).
function releaseAt(bucket: string, holdUntil: Date | null): string | null {
  if (bucket !== 'pending' || !holdUntil || holdUntil >= FROZEN_HOLD_UNTIL) return null;
  return holdUntil.toISOString();
}

export function registerWalletRoutes(
  app: FastifyInstance,
  deps: Pick<AuthDeps, 'accessJwt'>,
): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.get(
    '/wallet',
    {
      schema: { headers: AppHeadersSchema, response: { 200: WalletResponseSchema } },
      preHandler: authGuard,
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const userId = request.authUser.sub;
      const [wallet, nextRelease] = await Promise.all([
        db
          .selectFrom('wallets')
          .select(['available_coin', 'pending_coin', 'lifetime_earned'])
          .where('user_id', '=', userId)
          .executeTakeFirst(),
        db
          .selectFrom('coin_ledger')
          .select((eb) => eb.fn.min('hold_until').as('at'))
          .where('user_id', '=', userId)
          .where('bucket', '=', 'pending')
          .where('hold_until', 'is not', null)
          .where('hold_until', '<', FROZEN_HOLD_UNTIL)
          .executeTakeFirst(),
      ]);
      if (!wallet) {
        throw new AppError('WALLET_NOT_FOUND', 'Wallet not found', 404);
      }
      const at = nextRelease?.at;
      reply.code(200).send({
        ...wallet,
        next_pending_release_at: at ? new Date(at).toISOString() : null,
      });
    },
  );

  app.get<{ Querystring: LedgerQuery }>(
    '/wallet/ledger',
    {
      schema: {
        headers: AppHeadersSchema,
        querystring: LedgerQuerySchema,
        response: { 200: WalletLedgerResponseSchema },
      },
      preHandler: authGuard,
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const limit = request.query.limit ?? 20;

      let query = db
        .selectFrom('coin_ledger as ledger')
        .leftJoin('earning_events as earning_event', (join) =>
          join
            .onRef('earning_event.id', '=', 'ledger.ref_id')
            .on('ledger.ref_type', '=', 'earning_event'),
        )
        .select([
          'ledger.id as id',
          'ledger.entry_type as entry_type',
          'ledger.amount as amount',
          'ledger.bucket as bucket',
          'ledger.balance_after as balance_after',
          'ledger.note as note',
          'ledger.hold_until as hold_until',
          'ledger.created_at as created_at',
          'earning_event.source as earning_source',
          'earning_event.network_tx_id as earning_transaction_id',
        ])
        .where('ledger.user_id', '=', request.authUser.sub)
        .orderBy('ledger.id', 'desc')
        .limit(limit + 1);
      // uuidv7 ids are time-sortable, so id-based comparison doubles as a chronological cursor —
      // avoids a compound (created_at, id) cursor.
      if (request.query.cursor) {
        query = query.where('ledger.id', '<', request.query.cursor);
      }
      if (request.query.provider) {
        query = query.where('earning_event.source', '=', request.query.provider);
      }
      if (request.query.bucket === 'pending') {
        // Released entries keep bucket='pending' but lose hold_until (see releaseHold).
        query = query
          .where('ledger.bucket', '=', 'pending')
          .where('ledger.hold_until', 'is not', null);
      }

      const rows = await query.execute();
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = items[items.length - 1];

      reply.code(200).send({
        // entry_type stays as-is for existing clients; entry_label is what new ones should render.
        items: items.map((item) => {
          const offerwallProvider =
            typeof item.earning_source === 'string' &&
            ['OFFERWALL_CREDIT', 'OFFERWALL_CLAWBACK'].includes(item.entry_type)
              ? item.earning_source
              : null;
          const offerwallStatus =
            item.entry_type === 'OFFERWALL_CLAWBACK'
              ? 'reversed'
              : item.bucket === 'pending' && item.hold_until
                ? 'pending'
                : 'available';
          return {
            id: item.id,
            entry_type: item.entry_type,
            entry_label: entryLabel(item.entry_type),
            amount: item.amount,
            bucket: item.bucket,
            balance_after: item.balance_after,
            note: item.note,
            created_at: item.created_at.toISOString(),
            available_at: releaseAt(item.bucket, item.hold_until),
            offerwall: offerwallProvider
              ? {
                  provider: offerwallProvider,
                  provider_label: providerLabel(offerwallProvider),
                  transaction_id: item.earning_transaction_id,
                  status: offerwallStatus,
                  available_at:
                    offerwallStatus === 'pending' ? releaseAt(item.bucket, item.hold_until) : null,
                }
              : null,
          };
        }),
        next_cursor: hasMore && lastItem ? lastItem.id : null,
      });
    },
  );
}
