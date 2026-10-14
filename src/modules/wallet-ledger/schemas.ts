import { Type, type Static } from '@sinclair/typebox';

export const OfferwallHistoryProviderSchema = Type.Union([
  Type.Literal('tapjoy'),
  Type.Literal('pubscale'),
  Type.Literal('adgate'),
  Type.Literal('adjoe'),
  Type.Literal('appsprize'),
]);
export type OfferwallHistoryProvider = Static<typeof OfferwallHistoryProviderSchema>;

export const LedgerQuerySchema = Type.Object({
  provider: Type.Optional(OfferwallHistoryProviderSchema),
  // pending: only coin still on hold (the "Pending" tab), any source.
  bucket: Type.Optional(Type.Literal('pending')),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type LedgerQuery = Static<typeof LedgerQuerySchema>;

export const WalletResponseSchema = Type.Object({
  available_coin: Type.String(),
  pending_coin: Type.String(),
  lifetime_earned: Type.String(),
  // The soonest pending credit to become spendable ("available in 2 days"); null if none is due.
  next_pending_release_at: Type.Union([Type.String(), Type.Null()]),
});

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
      // When coin still on hold becomes spendable; null once available, or while frozen for review.
      available_at: Type.Union([Type.String(), Type.Null()]),
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
