import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { Type, type Static } from '@sinclair/typebox';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import { db } from '../../db/index.js';
import { invalidateConfigCache } from './config.service.js';

// 12-ADMIN-SECURITY.md §RBAC: "chỉ superadmin quản lý admin users + region_config".
const SUPERADMIN_ROLES = ['superadmin'] as const;

const RegionParamsSchema = Type.Object({ region_id: Type.String({ minLength: 1, maxLength: 16 }) });
interface RegionParams {
  region_id: string;
}

const RegionConfigSchema = Type.Object({
  region_id: Type.String(),
  countries: Type.Array(Type.String()),
  features: Type.Unknown(),
  updated_at: Type.String(),
});

const RegionConfigListResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      region_id: Type.String(),
      countries: Type.Array(Type.String()),
      updated_at: Type.String(),
    }),
  ),
});

const UpdateRegionConfigBodySchema = Type.Object({
  countries: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 2 }))),
  features: Type.Unknown(),
});
type UpdateRegionConfigBody = Static<typeof UpdateRegionConfigBodySchema>;

function requireAdmin(request: { adminUser?: { id: string; role: string } }): {
  id: string;
  role: string;
} {
  if (!request.adminUser) {
    throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  }
  return request.adminUser;
}

function assertFeaturesObject(value: unknown): Record<string, unknown> {
  // An array or a scalar would still store fine in jsonb but every reader treats features as a map,
  // so `GET /config` would start throwing CONFIG_MALFORMED for the whole region.
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_FEATURES', 'features must be a JSON object', 400);
  }
  return value as Record<string, unknown>;
}

export function registerConfigAdminRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(SUPERADMIN_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get(
    '/admin/region-config',
    { preHandler: adminGuard, schema: { response: { 200: RegionConfigListResponseSchema } } },
    async (request, reply) => {
      requireAdmin(request);
      const rows = await db
        .selectFrom('region_config')
        .select(['region_id', 'countries', 'updated_at'])
        .orderBy('region_id', 'asc')
        .execute();
      reply.code(200).send({
        items: rows.map((row) => ({
          region_id: row.region_id,
          countries: row.countries,
          updated_at: new Date(row.updated_at).toISOString(),
        })),
      });
    },
  );

  // Returns the raw jsonb, unlike GET /config which projects a filtered, region-cached view for the
  // app. An admin editing flags has to see exactly what is stored, including keys /config drops.
  app.get<{ Params: RegionParams }>(
    '/admin/region-config/:region_id',
    {
      preHandler: adminGuard,
      schema: { params: RegionParamsSchema, response: { 200: RegionConfigSchema } },
    },
    async (request, reply) => {
      requireAdmin(request);
      const row = await db
        .selectFrom('region_config')
        .selectAll()
        .where('region_id', '=', request.params.region_id)
        .executeTakeFirst();
      if (!row) {
        throw new AppError('NOT_FOUND', 'Region config not found', 404);
      }
      reply.code(200).send({
        region_id: row.region_id,
        countries: row.countries,
        features: row.features ?? {},
        updated_at: new Date(row.updated_at).toISOString(),
      });
    },
  );

  // Update only — creating a region here would produce a region_config row that resolveRegion()
  // never maps any country to, i.e. a config nobody can reach. New regions go in as a migration
  // alongside their geo mapping.
  app.put<{ Params: RegionParams; Body: UpdateRegionConfigBody }>(
    '/admin/region-config/:region_id',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: {
        params: RegionParamsSchema,
        body: UpdateRegionConfigBodySchema,
        response: { 200: RegionConfigSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAdmin(request);
      const regionId = request.params.region_id;
      const features = assertFeaturesObject(request.body.features);

      const updated = await db.transaction().execute(async (trx) => {
        const before = await trx
          .selectFrom('region_config')
          .selectAll()
          .where('region_id', '=', regionId)
          .forUpdate()
          .executeTakeFirst();
        if (!before) {
          throw new AppError('NOT_FOUND', 'Region config not found', 404);
        }

        const countries = request.body.countries ?? before.countries;
        const row = await trx
          .updateTable('region_config')
          .set({ countries, features: JSON.stringify(features), updated_at: new Date() })
          .where('region_id', '=', regionId)
          .returningAll()
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('audit_log')
          .values({
            id: uuidv7(),
            admin_user_id: actor.id,
            action: 'REGION_CONFIG_UPDATED',
            target_type: 'region_config',
            // target_id is a UUID column and a region id is not one, so the target lives in
            // `detail` — same shape IP_ALLOWLIST_DRIFT_DETECTED uses for its non-UUID target.
            target_id: null,
            detail: JSON.stringify({
              region: regionId,
              before: { countries: before.countries, features: before.features },
              after: { countries, features },
            }),
            ip: null,
          })
          .execute();

        return row;
      });

      // Without this the app keeps serving the previous flags for up to CONFIG_CACHE_TTL_S. A
      // kill-switch that takes a minute to land is not a kill-switch.
      await invalidateConfigCache();

      reply.code(200).send({
        region_id: updated.region_id,
        countries: updated.countries,
        features: updated.features ?? {},
        updated_at: new Date(updated.updated_at).toISOString(),
      });
    },
  );
}
