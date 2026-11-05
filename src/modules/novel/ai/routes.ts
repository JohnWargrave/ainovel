import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  Type,
  type Static,
  type TNull,
  type TOptional,
  type TString,
  type TUnion,
} from '@sinclair/typebox';
import { createAdminCsrfGuard, createAdminGuard } from '../../../plugins/admin-guard.js';
import { AppError } from '../../../lib/errors.js';
import { checkSubjectRateLimit } from '../../../lib/rate-limit.js';
import { checkAiKey, getPublicAiSettings, updateAiSettings } from './settings.js';

const Price = Type.Number({ minimum: 0, maximum: 10_000 });

const AiModelSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  label: Type.String({ maxLength: 100 }),
  input_cache_hit: Price,
  input_cache_miss: Price,
  output: Price,
});

const AiSettingsSchema = Type.Object({
  has_key: Type.Boolean(),
  key_unreadable: Type.Boolean(),
  key_source: Type.Union([Type.Literal('cms'), Type.Literal('env'), Type.Null()]),
  key_hint: Type.Union([Type.String(), Type.Null()]),
  base_url: Type.String(),
  novel_model: Type.String(),
  cover_model: Type.String(),
  models: Type.Array(AiModelSchema),
  updated_at: Type.Union([Type.String(), Type.Null()]),
});

function NullableText(maxLength: number): TOptional<TUnion<[TString, TNull]>> {
  return Type.Optional(Type.Union([Type.String({ maxLength }), Type.Null()]));
}

const UpdateAiSettingsSchema = Type.Object(
  {
    api_key: NullableText(500),
    base_url: NullableText(300),
    novel_model: NullableText(100),
    cover_model: NullableText(100),
    models: Type.Optional(Type.Array(AiModelSchema, { maxItems: 50 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
type UpdateAiSettingsBody = Static<typeof UpdateAiSettingsSchema>;

const CheckKeySchema = Type.Object(
  {
    api_key: Type.Optional(Type.String({ maxLength: 500 })),
    base_url: Type.Optional(Type.String({ maxLength: 300 })),
  },
  { additionalProperties: false },
);
type CheckKeyBody = Static<typeof CheckKeySchema>;

const CheckKeyResultSchema = Type.Object({
  ok: Type.Boolean(),
  error: Type.Union([Type.String(), Type.Null()]),
  models: Type.Array(Type.String()),
  balance: Type.Union([
    Type.Array(Type.Object({ currency: Type.String(), total_balance: Type.String() })),
    Type.Null(),
  ]),
});

function requireAdmin(request: FastifyRequest): { id: string; role: string } {
  if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  return request.adminUser;
}

// DeepSeek key, host, models and prices. Editors read the model list to pick one for a novel; only
// superadmins see the key hint, change anything or spend a call testing a key.
export function registerAiSettingsRoutes(app: FastifyInstance): void {
  const readGuard = createAdminGuard(['editor', 'superadmin']);
  const superGuard = createAdminGuard(['superadmin']);
  const csrf = createAdminCsrfGuard();

  app.get(
    '/admin/ai-settings',
    { preHandler: readGuard, schema: { response: { 200: AiSettingsSchema } } },
    async (request, reply) => {
      reply.send(await getPublicAiSettings(requireAdmin(request).role === 'superadmin'));
    },
  );

  app.put<{ Body: UpdateAiSettingsBody }>(
    '/admin/ai-settings',
    {
      preHandler: [superGuard, csrf],
      schema: { body: UpdateAiSettingsSchema, response: { 200: AiSettingsSchema } },
    },
    async (request, reply) => {
      reply.send(await updateAiSettings(request.body, requireAdmin(request), request.ip));
    },
  );

  app.post<{ Body: CheckKeyBody }>(
    '/admin/ai-settings/check',
    {
      preHandler: [superGuard, csrf],
      schema: { body: CheckKeySchema, response: { 200: CheckKeyResultSchema } },
    },
    async (request, reply) => {
      await checkSubjectRateLimit('ai-key-check', requireAdmin(request).id, 3600, 30);
      reply.send(await checkAiKey(request.body));
    },
  );
}
