import { Type, type Static } from '@sinclair/typebox';

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const FraudFlagListQuerySchema = Type.Object({
  status: Type.Optional(
    Type.Union([Type.Literal('open'), Type.Literal('dismissed'), Type.Literal('confirmed')]),
  ),
  user_id: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  rule_code: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  cursor: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type FraudFlagListQuery = Static<typeof FraudFlagListQuerySchema>;

// The reviewer decides on a flag by looking at the user behind it, so the queue carries that context
// inline rather than making the console fan out one request per row.
export const FraudFlagSchema = Type.Object({
  id: Type.String(),
  user_id: Type.String(),
  rule_code: Type.String(),
  severity: Type.Integer(),
  evidence: Type.Unknown(),
  status: Type.String(),
  created_at: Type.String(),
  user: Type.Object({
    status: Type.String(),
    trust_level: Type.Integer(),
    fraud_score: Type.Integer(),
    region_id: Type.String(),
  }),
});
export type FraudFlag = Static<typeof FraudFlagSchema>;

export const FraudFlagListResponseSchema = Type.Object({
  items: Type.Array(FraudFlagSchema),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
});
export type FraudFlagListResponse = Static<typeof FraudFlagListResponseSchema>;

export const FraudFlagReviewBodySchema = Type.Object({
  note: Type.Optional(Type.String({ maxLength: 500 })),
});
export type FraudFlagReviewBody = Static<typeof FraudFlagReviewBodySchema>;

export const FraudFlagReviewResponseSchema = Type.Object({
  flag: FraudFlagSchema,
  // Post-review recompute, so the console can show the effect of the decision immediately.
  fraud_score: Type.Integer(),
  tier: Type.String(),
});
export type FraudFlagReviewResponse = Static<typeof FraudFlagReviewResponseSchema>;

export const FraudFlagParamsSchema = Type.Object({ id: Type.String({ pattern: UUID_PATTERN }) });
export interface FraudFlagParams {
  id: string;
}
