import type { FastifyInstance } from 'fastify';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import { AppError } from '../../lib/errors.js';
import { db } from '../../db/index.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { entryLabel } from './entry-labels.js';
import { LedgerQuerySchema, WalletLedgerResponseSchema, type LedgerQuery } from './schemas.js';

const PROVIDER_LABELS: Record<string, string> = {
  tapjoy: 'Tapjoy',
  pubscale: 'PubScale',
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export function registerWalletRoutes(
  app: FastifyInstance,
  deps: Pick<AuthDeps, 'accessJwt'>,
): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.get(
    '/wallet',
    { schema: { headers: AppHeadersSchema }, preHandler: authGuard },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const wallet = await db
        .selectFrom('wallets')
        .select(['available_coin', 'pending_coin', 'lifetime_earned'])
        .where('user_id', '=', request.authUser.sub)
        .executeTakeFirst();
      if (!wallet) {
        throw new AppError('WALLET_NOT_FOUND', 'Wallet not found', 404);
      }
      reply.code(200).send(wallet);
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
            offerwall: offerwallProvider
              ? {
                  provider: offerwallProvider,
                  provider_label: providerLabel(offerwallProvider),
                  transaction_id: item.earning_transaction_id,
                  status: offerwallStatus,
                  available_at:
                    offerwallStatus === 'pending' ? (item.hold_until?.toISOString() ?? null) : null,
                }
              : null,
          };
        }),
        next_cursor: hasMore && lastItem ? lastItem.id : null,
      });
    },
  );
}
