import { Type, type Static } from '@sinclair/typebox';

export const PostbackParamsSchema = Type.Object({
  network: Type.String({ minLength: 1 }),
});
export type PostbackParams = Static<typeof PostbackParamsSchema>;

// Every network defines its own param set (see 04-POSTBACK-SPEC.md) — loose on purpose, the actual
// required fields are enforced per-network inside verify/tapjoy.ts and verify/adgate.ts.
export const PostbackQuerystringSchema = Type.Object({}, { additionalProperties: true });
export type PostbackQuerystringBody = Static<typeof PostbackQuerystringSchema>;
