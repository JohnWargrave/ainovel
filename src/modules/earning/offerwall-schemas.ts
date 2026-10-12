import { Type, type Static } from '@sinclair/typebox';

export const OfferwallNetworkSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  icon_url: Type.Union([Type.String(), Type.Null()]),
  // What the app passes to the network's Android SDK to open its offerwall. There is no URL to
  // navigate to — the SDK owns the offer list, so this is the entry point, not `deeplink_url`.
  placement: Type.Union([Type.String(), Type.Null()]),
  // Deprecated, always null. Kept for one release so a client still reading it does not break on a
  // missing key; remove once the app has shipped a version that uses `placement`.
  deeplink_url: Type.Null(),
});

export const OfferwallOfferSchema = Type.Object({
  id: Type.String(),
  provider: Type.String(),
  name: Type.String(),
  description: Type.String(),
  icon_url: Type.Union([Type.String(), Type.Null()]),
  badge_text: Type.Union([Type.String(), Type.Null()]),
  placement: Type.Union([Type.String(), Type.Null()]),
});

export const OfferwallOffersResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  offers: Type.Array(OfferwallOfferSchema),
  // Backward-compatible provider list for clients released before CMS-managed cards.
  networks: Type.Array(OfferwallNetworkSchema),
});
export type OfferwallOffersResponse = Static<typeof OfferwallOffersResponseSchema>;
