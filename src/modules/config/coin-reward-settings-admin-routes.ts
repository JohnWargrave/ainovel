import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { invalidateConfigCache } from './config.service.js';
import {
  getCoinRewardSettings,
  MAX_COIN_REWARD,
  type CoinRewardSettings,
} from './coin-reward-settings.service.js';

const SUPERADMIN_ROLES = ['superadmin'] as const;

const WelcomeModeSchema = Type.Union([Type.Literal('instant'), Type.Literal('link_required')]);

const CoinRewardSettingsSchema = Type.Object({
  welcome_coin: Type.Integer({ minimum: 0, maximum: MAX_COIN_REWARD }),
  google_login: Type.Integer({ minimum: 0, maximum: MAX_COIN_REWARD }),
  welcome_mode: WelcomeModeSchema,
  updated_at: Type.String(),
});

const UpdateCoinRewardSettingsBodySchema = Type.Object({
  welcome_coin: Type.Integer({ minimum: 0, maximum: MAX_COIN_REWARD }),
  google_login: Type.Integer({ minimum: 0, maximum: MAX_COIN_REWARD }),
  // Optional so a CMS build that predates the field keeps saving without resetting it.
  welcome_mode: Type.Optional(WelcomeModeSchema),
});
type UpdateCoinRewardSettingsBody = Static<typeof UpdateCoinRewardSettingsBodySchema>;

function requireAdmin(request: { adminUser?: { id: string } }): { id: string } {
  if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  return request.adminUser;
}

function serialize(settings: CoinRewardSettings): Static<typeof CoinRewardSettingsSchema> {
  return {
    welcome_coin: settings.welcome_coin,
    google_login: settings.google_login,
    welcome_mode: settings.welcome_mode,
    updated_at: settings.updated_at.toISOString(),
  };
}

export function registerCoinRewardSettingsAdminRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(SUPERADMIN_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get(
    '/admin/coin-reward-settings',
    { preHandler: adminGuard, schema: { response: { 200: CoinRewardSettingsSchema } } },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(serialize(await getCoinRewardSettings()));
    },
  );

  app.put<{ Body: UpdateCoinRewardSettingsBody }>(
    '/admin/coin-reward-settings',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: {
        body: UpdateCoinRewardSettingsBodySchema,
        response: { 200: CoinRewardSettingsSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAdmin(request);
      const updated = await db.transaction().execute(async (trx) => {
        const before = await trx
          .selectFrom('coin_reward_settings')
          .selectAll()
          .where('id', '=', 'global')
          .forUpdate()
          .executeTakeFirstOrThrow();
        const after = await trx
          .updateTable('coin_reward_settings')
          .set({ ...request.body, updated_at: new Date() })
          .where('id', '=', 'global')
          .returningAll()
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('audit_log')
          .values({
            id: uuidv7(),
            admin_user_id: actor.id,
            action: 'COIN_REWARD_SETTINGS_UPDATED',
            target_type: 'coin_reward_settings',
            target_id: null,
            detail: JSON.stringify({
              before: {
                welcome_coin: before.welcome_coin,
                google_login: before.google_login,
                welcome_mode: before.welcome_mode,
              },
              after: {
                welcome_coin: after.welcome_coin,
                google_login: after.google_login,
                welcome_mode: after.welcome_mode,
              },
            }),
            ip: request.ip,
          })
          .execute();
        return after;
      });
      // /config carries the welcome bonus; drop the region caches so the app sees the change on its
      // next fetch instead of up to a minute later.
      await invalidateConfigCache();

      reply.code(200).send(serialize(updated));
    },
  );
}
