import { Type, type Static } from '@sinclair/typebox';

export const OfferwallOfferStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('active'),
  Type.Literal('paused'),
  Type.Literal('archived'),
]);

export const OfferwallProviderIdSchema = Type.Union([
  Type.Literal('tapjoy'),
  Type.Literal('pubscale'),
]);
export type OfferwallProviderId = Static<typeof OfferwallProviderIdSchema>;

const NullableStringSchema = Type.Union([Type.String({ maxLength: 2_048 }), Type.Null()]);
const NullableDateSchema = Type.Union([Type.String({ maxLength: 64 }), Type.Null()]);

export const OfferwallOfferSchema = Type.Object({
  id: Type.String(),
  code: Type.String(),
  provider: Type.String(),
  name: Type.String(),
  description: Type.String(),
  icon_url: Type.Union([Type.String(), Type.Null()]),
  badge_text: Type.Union([Type.String(), Type.Null()]),
  reward_text: Type.Union([Type.String(), Type.Null()]),
  placement: Type.Union([Type.String(), Type.Null()]),
  region_ids: Type.Array(Type.String()),
  sort_order: Type.Integer(),
  status: OfferwallOfferStatusSchema,
  starts_at: Type.Union([Type.String(), Type.Null()]),
  ends_at: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  updated_at: Type.String(),
});
export type OfferwallOffer = Static<typeof OfferwallOfferSchema>;

export const OfferwallOfferListQuerySchema = Type.Object({
  provider: Type.Optional(OfferwallProviderIdSchema),
  status: Type.Optional(OfferwallOfferStatusSchema),
});
export type OfferwallOfferListQuery = Static<typeof OfferwallOfferListQuerySchema>;

export const OfferwallOfferListResponseSchema = Type.Object({
  items: Type.Array(OfferwallOfferSchema),
});

export const CreateOfferwallOfferBodySchema = Type.Object({
  code: Type.String({ minLength: 2, maxLength: 32, pattern: '^[a-z0-9][a-z0-9_-]+$' }),
  provider: OfferwallProviderIdSchema,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  icon_url: Type.Optional(NullableStringSchema),
  badge_text: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
  reward_text: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 40 })])),
  placement: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
  region_ids: Type.Array(Type.String({ minLength: 1, maxLength: 16 }), {
    minItems: 1,
    maxItems: 50,
  }),
  sort_order: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  status: Type.Optional(OfferwallOfferStatusSchema),
  starts_at: Type.Optional(NullableDateSchema),
  ends_at: Type.Optional(NullableDateSchema),
});
export type CreateOfferwallOfferBody = Static<typeof CreateOfferwallOfferBodySchema>;

export const UpdateOfferwallOfferBodySchema = Type.Partial(
  Type.Object({
    code: Type.String({ minLength: 2, maxLength: 32, pattern: '^[a-z0-9][a-z0-9_-]+$' }),
    provider: OfferwallProviderIdSchema,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ maxLength: 500 }),
    icon_url: NullableStringSchema,
    badge_text: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
    reward_text: Type.Union([Type.Null(), Type.String({ maxLength: 40 })]),
    placement: Type.Union([Type.String({ maxLength: 255 }), Type.Null()]),
    region_ids: Type.Array(Type.String({ minLength: 1, maxLength: 16 }), {
      minItems: 1,
      maxItems: 50,
    }),
    sort_order: Type.Integer({ minimum: 0, maximum: 100_000 }),
    status: OfferwallOfferStatusSchema,
    starts_at: NullableDateSchema,
    ends_at: NullableDateSchema,
  }),
);
export type UpdateOfferwallOfferBody = Static<typeof UpdateOfferwallOfferBodySchema>;

export const OfferwallProviderSchema = Type.Object({
  provider: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  icon_url: Type.Union([Type.String(), Type.Null()]),
  placement: Type.Union([Type.String(), Type.Null()]),
  placement_source: Type.Union([Type.Literal('environment'), Type.Literal('database')]),
  allowed_ips: Type.Array(Type.String()),
  currency_per_usd: Type.Union([Type.String(), Type.Null()]),
  hold_hours: Type.Integer(),
  high_value_threshold_usd: Type.String(),
  high_value_hold_hours: Type.Integer(),
  credit_immediately: Type.Boolean(),
  is_active: Type.Boolean(),
  shadow_mode: Type.Boolean(),
  secret_configured: Type.Boolean(),
  callback_url: Type.String(),
  updated_at: Type.String(),
});
export type OfferwallProvider = Static<typeof OfferwallProviderSchema>;

export const OfferwallProviderListResponseSchema = Type.Object({
  items: Type.Array(OfferwallProviderSchema),
});

export const UpdateOfferwallProviderBodySchema = Type.Partial(
  Type.Object({
    display_name: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    icon_url: NullableStringSchema,
    placement: Type.Union([Type.String({ maxLength: 255 }), Type.Null()]),
    allowed_ips: Type.Array(Type.String({ minLength: 3, maxLength: 64 }), { maxItems: 100 }),
    currency_per_usd: Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]),
    hold_hours: Type.Integer({ minimum: 0, maximum: 720 }),
    high_value_threshold_usd: Type.Number({ exclusiveMinimum: 0, maximum: 1_000_000 }),
    high_value_hold_hours: Type.Integer({ minimum: 0, maximum: 720 }),
    credit_immediately: Type.Boolean(),
    is_active: Type.Boolean(),
    shadow_mode: Type.Boolean(),
  }),
);
export type UpdateOfferwallProviderBody = Static<typeof UpdateOfferwallProviderBodySchema>;

export const OfferwallTrustSharesSchema = Type.Object({
  '0': Type.Number({ minimum: 0, maximum: 0.6 }),
  '1': Type.Number({ minimum: 0, maximum: 0.6 }),
  '2': Type.Number({ minimum: 0, maximum: 0.6 }),
  '3': Type.Number({ minimum: 0, maximum: 0.6 }),
});

export const OfferwallRegionSettingsSchema = Type.Object({
  region_id: Type.String(),
  enabled: Type.Boolean(),
  networks: Type.Array(Type.String()),
  shares: OfferwallTrustSharesSchema,
  updated_at: Type.String(),
});
export type OfferwallRegionSettings = Static<typeof OfferwallRegionSettingsSchema>;

export const OfferwallRegionSettingsListResponseSchema = Type.Object({
  items: Type.Array(OfferwallRegionSettingsSchema),
});

export const UpdateOfferwallRegionSettingsBodySchema = Type.Partial(
  Type.Object({
    enabled: Type.Boolean(),
    networks: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 20 }),
    shares: OfferwallTrustSharesSchema,
  }),
);
export type UpdateOfferwallRegionSettingsBody = Static<
  typeof UpdateOfferwallRegionSettingsBodySchema
>;
