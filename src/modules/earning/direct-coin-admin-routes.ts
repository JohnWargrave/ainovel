import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';

// Superadmin only, matching coin-reward-settings: this switch decides whether clients can mint coin
// at all, which is a strictly larger power than setting a fixed reward amount.
const SUPERADMIN_ROLES = ['superadmin'] as const;

const DirectCoinSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  max_amount_coin: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  updated_at: Type.String(),
});

const UpdateDirectCoinSettingsBodySchema = Type.Object({
  enabled: Type.Boolean(),
  max_amount_coin: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
});
type UpdateDirectCoinSettingsBody = Static<typeof UpdateDirectCoinSettingsBodySchema>;

function requireAdmin(request: { adminUser?: { id: string } }): { id: string } {
  if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  return request.adminUser;
}

function serialize(settings: {
  enabled: boolean;
  max_amount_coin: number;
  updated_at: Date;
}): Static<typeof DirectCoinSettingsSchema> {
  return {
    enabled: settings.enabled,
    max_amount_coin: settings.max_amount_coin,
    updated_at: settings.updated_at.toISOString(),
  };
}

export function registerDirectCoinAdminRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(SUPERADMIN_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get(
    '/admin/direct-coin-settings',
    { preHandler: adminGuard, schema: { response: { 200: DirectCoinSettingsSchema } } },
    async (request, reply) => {
      requireAdmin(request);
      const settings = await db
        .selectFrom('direct_coin_settings')
        .select(['enabled', 'max_amount_coin', 'updated_at'])
        .where('id', '=', 'global')
        .executeTakeFirstOrThrow();
      reply.code(200).send(serialize(settings));
    },
  );

  app.put<{ Body: UpdateDirectCoinSettingsBody }>(
    '/admin/direct-coin-settings',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: {
        body: UpdateDirectCoinSettingsBodySchema,
        response: { 200: DirectCoinSettingsSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAdmin(request);
      const updated = await db.transaction().execute(async (trx) => {
        const before = await trx
          .selectFrom('direct_coin_settings')
          .selectAll()
          .where('id', '=', 'global')
          .forUpdate()
          .executeTakeFirstOrThrow();
        const after = await trx
          .updateTable('direct_coin_settings')
          .set({ ...request.body, updated_at: new Date() })
          .where('id', '=', 'global')
          .returningAll()
          .executeTakeFirstOrThrow();

        // Flipping this on is the event a later investigation will want to find first, so it is
        // audited with both sides of the change, same as every other coin-affecting admin action.
        await trx
          .insertInto('audit_log')
          .values({
            id: uuidv7(),
            admin_user_id: actor.id,
            action: 'DIRECT_COIN_SETTINGS_UPDATED',
            target_type: 'direct_coin_settings',
            target_id: null,
            detail: JSON.stringify({
              before: { enabled: before.enabled, max_amount_coin: before.max_amount_coin },
              after: { enabled: after.enabled, max_amount_coin: after.max_amount_coin },
            }),
            ip: request.ip,
          })
          .execute();
        return after;
      });

      reply.code(200).send(serialize(updated));
    },
  );
}
