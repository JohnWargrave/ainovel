import { Type, type Static } from '@sinclair/typebox';

export const ConfigFeatureSchema = Type.Record(Type.String(), Type.Unknown());

export const ConfigResponseSchema = Type.Object({
  region: Type.String(),
  features: Type.Object({
    drama: ConfigFeatureSchema,
    spin: ConfigFeatureSchema,
    offerwall: ConfigFeatureSchema,
    rewarded_ads: ConfigFeatureSchema,
    checkin: ConfigFeatureSchema,
    tasks: ConfigFeatureSchema,
    redemption: ConfigFeatureSchema,
    referral: ConfigFeatureSchema,
  }),
  coin_per_usd: Type.Number(),
  min_supported_app_version: Type.String(),
  min_redemption_usd: Type.Number(),
});
export type ConfigResponse = Static<typeof ConfigResponseSchema>;

export const ConfigInvalidateResponseSchema = Type.Object({
  deleted: Type.Number(),
});
