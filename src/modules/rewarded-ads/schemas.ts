import { Type, type Static } from '@sinclair/typebox';

// Optional everywhere it appears: builds that predate placements keep working and land in the
// shared bucket, exactly as they do today.
//
// Literals spelled out rather than mapped over REWARDED_AD_PLACEMENTS so the static type is the
// exact union and not an index signature. If the two lists ever drift, routes.ts fails to compile
// where it passes this value into createIntent(placement: RewardedAdPlacement | null).
export const PlacementSchema = Type.Union([
  Type.Literal('checkin'),
  Type.Literal('earncoin'),
  Type.Literal('luckyspin'),
]);

// The null arm is load-bearing, not defensive. Fastify normalises a missing body to `null` before
// handing it to the validator (lib/validation.js `validateParam`), so an object-only schema answers
// 400 to a bodyless POST — which is every call from a build that predates placements, and every call
// that simply has no placement to send. Wrapping the object in Type.Optional does not help: at the
// root of a body schema there is no parent object for the modifier to apply to.
export const IntentBodySchema = Type.Union([
  Type.Object({ placement: Type.Optional(PlacementSchema) }),
  Type.Null(),
]);
export type IntentBody = Static<typeof IntentBodySchema>;

export const RewardedAdStateQuerySchema = Type.Object({
  placement: Type.Optional(PlacementSchema),
});
export type RewardedAdStateQuery = Static<typeof RewardedAdStateQuerySchema>;

export const RewardedAdStateResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  placement: Type.Union([PlacementSchema, Type.Null()]),
  daily_cap: Type.Integer(),
  rewards_today: Type.Integer(),
  pending_rewards: Type.Integer(),
  rewards_remaining: Type.Integer(),
  cooldown_s: Type.Integer(),
  next_available_at: Type.Union([Type.String(), Type.Null()]),
  reset_at: Type.String(),
});
export type RewardedAdStateResponse = Static<typeof RewardedAdStateResponseSchema>;

export const IntentResponseSchema = Type.Object({
  intent_id: Type.String(),
  ssv_custom_data: Type.String(),
  state: RewardedAdStateResponseSchema,
});
export type IntentResponse = Static<typeof IntentResponseSchema>;

// AdMob's SSV callback params (04-POSTBACK-SPEC.md §7) — loose on purpose, same reasoning as
// PostbackQuerystringSchema: only the fields ssv.service.ts reads are enforced there, not here.
export const SsvQuerystringSchema = Type.Object({}, { additionalProperties: true });
export type SsvQuerystringBody = Static<typeof SsvQuerystringSchema>;
export type SsvQuery = Record<string, string | undefined>;
