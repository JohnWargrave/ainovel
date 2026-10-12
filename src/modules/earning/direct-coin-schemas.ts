import { Type, type Static } from '@sinclair/typebox';

// The schema maximum is a sanity bound, not the policy bound — the real ceiling is
// direct_coin_settings.max_amount_coin, which a superadmin sets in the CMS and which is enforced in
// the service. This one only keeps absurd values out of the transaction.
export const DirectCoinGrantBodySchema = Type.Object({
  amount_coin: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  // Optional so the simplest client can post nothing but an amount. Send one and a retried request
  // credits once instead of twice; omit it and every retry is a fresh grant.
  idempotency_key: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
});
export type DirectCoinGrantBody = Static<typeof DirectCoinGrantBodySchema>;

export const DirectCoinGrantResponseSchema = Type.Object({
  amount_coin: Type.Integer(),
  new_balance: Type.String(),
  deduped: Type.Boolean(),
});

export const DirectCoinStateResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  max_amount_coin: Type.Integer(),
});
