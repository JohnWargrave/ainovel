import { Type, type Static } from '@sinclair/typebox';

// none: a code is delivered. paypal_email: the app asks for a PayPal address and sends it as
// recipient_email on POST /redemptions.
export const RecipientTypeSchema = Type.Union([Type.Literal('none'), Type.Literal('paypal_email')]);

export const CatalogItemResponseSchema = Type.Object({
  id: Type.String(),
  sku: Type.String(),
  title: Type.String(),
  category: Type.String(),
  face_value: Type.String(),
  usd_cost: Type.String(),
  coin_price: Type.String(),
  image_url: Type.Union([Type.String(), Type.Null()]),
  seagm_url: Type.Union([Type.String(), Type.Null()]),
  regions: Type.Array(Type.String()),
  is_active: Type.Boolean(),
  stock_note: Type.Union([Type.String(), Type.Null()]),
  source: Type.String(),
  recipient_type: RecipientTypeSchema,
  updated_at: Type.String(),
});
export type CatalogItemResponse = Static<typeof CatalogItemResponseSchema>;

// Deliberately NOT CatalogItemResponseSchema. GET /catalog and GET /redemptions/catalog are
// unauthenticated, and the admin shape carries `usd_cost` (our supplier cost) and `seagm_url` (the
// supplier deep link) — margin data that anyone could scrape to compute our take on every SKU.
// `source` is internal provenance (crawler|manual) with no meaning to the app.
export const PublicCatalogItemSchema = Type.Object({
  id: Type.String(),
  sku: Type.String(),
  title: Type.String(),
  // Renamed for the app: `category` is a slug it groups by, `face_value` is the line it renders
  // under the title. The DB column names stay as-is; the mapping lives in serializePublicItem.
  category_id: Type.String(),
  subtitle: Type.String(),
  coin_price: Type.String(),
  image_url: Type.Union([Type.String(), Type.Null()]),
  available: Type.Boolean(),
  stock_note: Type.Union([Type.String(), Type.Null()]),
  recipient_type: RecipientTypeSchema,
});
export type PublicCatalogItem = Static<typeof PublicCatalogItemSchema>;

export const CatalogCategorySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
});
export type CatalogCategory = Static<typeof CatalogCategorySchema>;

export const CatalogListResponseSchema = Type.Object({
  categories: Type.Array(CatalogCategorySchema),
  items: Type.Array(PublicCatalogItemSchema),
});
export type CatalogListResponse = Static<typeof CatalogListResponseSchema>;

export const CatalogAdminListQuerySchema = Type.Object({
  is_active: Type.Optional(Type.Boolean()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type CatalogAdminListQuery = Static<typeof CatalogAdminListQuerySchema>;

export const CatalogAdminListResponseSchema = Type.Object({
  items: Type.Array(CatalogItemResponseSchema),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
});

export const CreateCatalogItemBodySchema = Type.Object({
  sku: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  category: Type.String({ minLength: 1 }),
  face_value: Type.String({ minLength: 1 }),
  usd_cost: Type.Number({ minimum: 0 }),
  coin_price: Type.Integer({ minimum: 0 }),
  image_url: Type.Optional(Type.String()),
  seagm_url: Type.Optional(Type.String()),
  regions: Type.Array(Type.String({ minLength: 2, maxLength: 2 }), { minItems: 1 }),
  is_active: Type.Optional(Type.Boolean()),
  stock_note: Type.Optional(Type.String()),
  recipient_type: Type.Optional(RecipientTypeSchema),
});
export type CreateCatalogItemBody = Static<typeof CreateCatalogItemBodySchema>;

export const UpdateCatalogItemBodySchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1 })),
  face_value: Type.Optional(Type.String({ minLength: 1 })),
  usd_cost: Type.Optional(Type.Number({ minimum: 0 })),
  coin_price: Type.Optional(Type.Integer({ minimum: 0 })),
  image_url: Type.Optional(Type.String()),
  seagm_url: Type.Optional(Type.String()),
  regions: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 2 }), { minItems: 1 })),
  is_active: Type.Optional(Type.Boolean()),
  stock_note: Type.Optional(Type.String()),
  recipient_type: Type.Optional(RecipientTypeSchema),
});
export type UpdateCatalogItemBody = Static<typeof UpdateCatalogItemBodySchema>;

export const CatalogStagingResponseSchema = Type.Object({
  id: Type.String(),
  sku: Type.String(),
  payload: Type.Unknown(),
  diff: Type.Unknown(),
  crawl_run_id: Type.String(),
  status: Type.String(),
  created_at: Type.String(),
});
export type CatalogStagingResponse = Static<typeof CatalogStagingResponseSchema>;

export const CatalogStagingListQuerySchema = Type.Object({
  status: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type CatalogStagingListQuery = Static<typeof CatalogStagingListQuerySchema>;

export const CatalogStagingListResponseSchema = Type.Object({
  items: Type.Array(CatalogStagingResponseSchema),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
});

export const BulkApproveBodySchema = Type.Object({
  staging_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }),
});
export type BulkApproveBody = Static<typeof BulkApproveBodySchema>;

export const BulkApproveResponseSchema = Type.Object({
  approved: Type.Array(Type.String()),
  skipped: Type.Array(Type.String()),
});
