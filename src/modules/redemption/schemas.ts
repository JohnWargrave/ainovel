import { Type, type Static } from '@sinclair/typebox';

export const RedemptionStatusSchema = Type.Union([
  Type.Literal('REQUESTED'),
  Type.Literal('FRAUD_REVIEW'),
  Type.Literal('APPROVED'),
  Type.Literal('PURCHASING'),
  Type.Literal('DELIVERED'),
  Type.Literal('REJECTED'),
  Type.Literal('FAILED'),
]);

// Fulfillment state (`status`) answers "where is this order in the pipeline"; claim state answers
// the only question the reward screen asks: "can the user open the code right now, and if not,
// when". Keeping them separate means the hold window can change without touching the status enum.
export const RedemptionClaimStateSchema = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('CLAIMABLE'),
  Type.Literal('CLAIMED'),
  Type.Literal('REJECTED'),
  Type.Literal('FAILED'),
]);
export type RedemptionClaimState = Static<typeof RedemptionClaimStateSchema>;

export const CreateRedemptionBodySchema = Type.Object({
  catalog_item_id: Type.String({ minLength: 1 }),
});
export type CreateRedemptionBody = Static<typeof CreateRedemptionBodySchema>;

export const RedemptionRewardSchema = Type.Object({
  sku: Type.String(),
  title: Type.String(),
  category: Type.String(),
  face_value: Type.String(),
  image_url: Type.Union([Type.String(), Type.Null()]),
});
export type RedemptionReward = Static<typeof RedemptionRewardSchema>;

export const RedemptionResponseSchema = Type.Object({
  id: Type.String(),
  status: RedemptionStatusSchema,
  catalog_item_id: Type.String(),
  reward: RedemptionRewardSchema,
  coin_price: Type.String(),
  usd_cost_est: Type.String(),
  fraud_score_at_request: Type.Union([Type.Number(), Type.Null()]),
  reject_reason: Type.Union([Type.String(), Type.Null()]),
  delivery_note: Type.Union([Type.String(), Type.Null()]),
  delivered_at: Type.Union([Type.String(), Type.Null()]),
  claimed_at: Type.Union([Type.String(), Type.Null()]),
  claim_state: RedemptionClaimStateSchema,
  claimable_at: Type.String(),
  seconds_until_claimable: Type.Integer({ minimum: 0 }),
  can_claim_now: Type.Boolean(),
  created_at: Type.String(),
  updated_at: Type.String(),
});

export const RedemptionTimelineEntrySchema = Type.Object({
  status: RedemptionStatusSchema,
  actor: Type.String(),
  note: Type.Union([Type.String(), Type.Null()]),
  at: Type.String(),
});

export const RedemptionDetailResponseSchema = Type.Intersect([
  RedemptionResponseSchema,
  Type.Object({ timeline: Type.Array(RedemptionTimelineEntrySchema) }),
]);

export const RedemptionListQuerySchema = Type.Object({
  status: Type.Optional(RedemptionStatusSchema),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type RedemptionListQuery = Static<typeof RedemptionListQuerySchema>;

export const RedemptionListResponseSchema = Type.Object({
  items: Type.Array(RedemptionResponseSchema),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
});

export const DeliveryCodeResponseSchema = Type.Object({
  redemption_id: Type.String(),
  delivery_code: Type.String(),
  delivery_note: Type.Union([Type.String(), Type.Null()]),
});

export const AdminRedemptionListQuerySchema = Type.Object({
  status: Type.Optional(RedemptionStatusSchema),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type AdminRedemptionListQuery = Static<typeof AdminRedemptionListQuerySchema>;

export const AdminRedemptionSummarySchema = Type.Intersect([
  RedemptionResponseSchema,
  Type.Object({
    user: Type.Object({
      id: Type.String(),
      email: Type.Union([Type.String(), Type.Null()]),
      status: Type.String(),
      region_id: Type.String(),
      country_code: Type.String(),
    }),
    catalog_item: Type.Object({
      id: Type.String(),
      sku: Type.String(),
      title: Type.String(),
      category: Type.String(),
      face_value: Type.String(),
      seagm_url: Type.Union([Type.String(), Type.Null()]),
      stock_note: Type.Union([Type.String(), Type.Null()]),
    }),
  }),
]);
export type AdminRedemptionSummary = Static<typeof AdminRedemptionSummarySchema>;

export const AdminRedemptionListResponseSchema = Type.Object({
  items: Type.Array(AdminRedemptionSummarySchema),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
});

export const AdminNoteBodySchema = Type.Object({
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type AdminNoteBody = Static<typeof AdminNoteBodySchema>;

export const AdminRejectBodySchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
});
export type AdminRejectBody = Static<typeof AdminRejectBodySchema>;

export const PasteCodeBodySchema = Type.Object({
  delivery_code: Type.String({ minLength: 1, maxLength: 4000 }),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type PasteCodeBody = Static<typeof PasteCodeBodySchema>;

export const AdminRedemptionDetailSchema = Type.Object({
  redemption: RedemptionResponseSchema,
  user: Type.Object({
    id: Type.String(),
    email: Type.Union([Type.String(), Type.Null()]),
    status: Type.String(),
    trust_level: Type.Integer(),
    fraud_score: Type.Integer(),
    region_id: Type.String(),
    country_code: Type.String(),
  }),
  catalog_item: Type.Object({
    id: Type.String(),
    sku: Type.String(),
    title: Type.String(),
    category: Type.String(),
    face_value: Type.String(),
    image_url: Type.Union([Type.String(), Type.Null()]),
    seagm_url: Type.Union([Type.String(), Type.Null()]),
    usd_cost: Type.String(),
    coin_price: Type.String(),
    is_active: Type.Boolean(),
    stock_note: Type.Union([Type.String(), Type.Null()]),
  }),
  history: Type.Array(
    Type.Object({
      id: Type.String(),
      from_status: Type.Union([RedemptionStatusSchema, Type.Null()]),
      to_status: RedemptionStatusSchema,
      actor: Type.String(),
      note: Type.Union([Type.String(), Type.Null()]),
      created_at: Type.String(),
    }),
  ),
});
export type AdminRedemptionDetail = Static<typeof AdminRedemptionDetailSchema>;
