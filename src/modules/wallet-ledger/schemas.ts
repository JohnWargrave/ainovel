import { Type, type Static } from '@sinclair/typebox';

export const OfferwallHistoryProviderSchema = Type.Union([
  Type.Literal('tapjoy'),
  Type.Literal('pubscale'),
]);
export type OfferwallHistoryProvider = Static<typeof OfferwallHistoryProviderSchema>;

export const LedgerQuerySchema = Type.Object({
  provider: Type.Optional(OfferwallHistoryProviderSchema),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type LedgerQuery = Static<typeof LedgerQuerySchema>;

export const WalletLedgerResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      entry_type: Type.String(),
      entry_label: Type.String(),
      amount: Type.String(),
      bucket: Type.String(),
      balance_after: Type.String(),
      note: Type.Union([Type.String(), Type.Null()]),
      created_at: Type.String(),
      offerwall: Type.Union([
        Type.Object({
          provider: Type.String(),
          provider_label: Type.String(),
          transaction_id: Type.Union([Type.String(), Type.Null()]),
          status: Type.Union([
            Type.Literal('pending'),
            Type.Literal('available'),
            Type.Literal('reversed'),
          ]),
          available_at: Type.Union([Type.String(), Type.Null()]),
        }),
        Type.Null(),
      ]),
    }),
  ),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
});
