import { Type, type Static } from '@sinclair/typebox';

// General app requests validate these headers for presence. Account-creating routes use the stricter
// DeviceRegistrationHeadersSchema below because X-Device-Id is their installation identity.
export const AppHeadersSchema = Type.Object(
  {
    'x-app-version': Type.String({ minLength: 1 }),
    'x-device-id': Type.String({ minLength: 1 }),
    'accept-language': Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);

const InstallationIdSchema = Type.String({
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});

export const DeviceRegistrationHeadersSchema = Type.Object(
  {
    'x-app-version': Type.String({ minLength: 1 }),
    'x-device-id': InstallationIdSchema,
    'accept-language': Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);

export const DeviceInputSchema = Type.Object({
  gaid: Type.Optional(Type.Union([Type.String({ maxLength: 128 }), Type.Null()])),
  model: Type.String({ minLength: 1 }),
  os: Type.String({ minLength: 1 }),
  // Not in 03-API-CONTRACT.md's minimal body — added as an optional extension since the Android app
  // doesn't exist yet to confirm a richer payload (see auth.service.ts fingerprint comment).
  build_props: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type DeviceInputBody = Static<typeof DeviceInputSchema>;

export const GuestSignupBodySchema = Type.Object({
  device: DeviceInputSchema,
});
export type GuestSignupBody = Static<typeof GuestSignupBodySchema>;

export const OAuthAuthBodySchema = Type.Object({
  id_token: Type.String({ minLength: 1 }),
  device: DeviceInputSchema,
});
export type OAuthAuthBody = Static<typeof OAuthAuthBodySchema>;

export const BindBodySchema = Type.Object({
  provider: Type.Union([Type.Literal('google'), Type.Literal('facebook')]),
  id_token: Type.String({ minLength: 1 }),
});
export type BindBody = Static<typeof BindBodySchema>;

export const RefreshBodySchema = Type.Object({
  refresh: Type.String({ minLength: 1 }),
});
export type RefreshBody = Static<typeof RefreshBodySchema>;

const UsernameSchema = Type.String({ pattern: '^[A-Za-z0-9_]{3,24}$' });
const PasswordSchema = Type.String({ minLength: 12, maxLength: 128 });
const EmailSchema = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
});

export const PasswordRegisterBodySchema = Type.Object({
  username: UsernameSchema,
  email: EmailSchema,
  password: PasswordSchema,
  device: DeviceInputSchema,
});
export type PasswordRegisterBody = Static<typeof PasswordRegisterBodySchema>;

export const PasswordLoginBodySchema = Type.Object({
  username: UsernameSchema,
  password: PasswordSchema,
});
export type PasswordLoginBody = Static<typeof PasswordLoginBodySchema>;

export const PasswordBindBodySchema = Type.Object({
  username: UsernameSchema,
  email: EmailSchema,
  password: PasswordSchema,
});
export type PasswordBindBody = Static<typeof PasswordBindBodySchema>;

export const PasswordChangeBodySchema = Type.Object({
  current_password: PasswordSchema,
  new_password: PasswordSchema,
});
export type PasswordChangeBody = Static<typeof PasswordChangeBodySchema>;

export const PasswordForgotBodySchema = Type.Object({ email: EmailSchema });
export type PasswordForgotBody = Static<typeof PasswordForgotBodySchema>;

export const PasswordResetBodySchema = Type.Object({
  token: Type.String({ minLength: 32, maxLength: 256 }),
  new_password: PasswordSchema,
});
export type PasswordResetBody = Static<typeof PasswordResetBodySchema>;

export const EmailVerificationBodySchema = Type.Object({
  token: Type.String({ minLength: 32, maxLength: 256 }),
});
export type EmailVerificationBody = Static<typeof EmailVerificationBodySchema>;

export const AuthMessageResponseSchema = Type.Object({ message: Type.String() });

export const LoginRewardOffersResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      auth_provider: Type.Union([Type.Literal('password'), Type.Literal('google')]),
      welcome_coin: Type.Integer({ minimum: 0 }),
      provider_bonus_coin: Type.Integer({ minimum: 0 }),
      total_coin: Type.Integer({ minimum: 0 }),
    }),
  ),
  // link_required: a guest's welcome bonus waits until they link an account — show it as pending.
  welcome_mode: Type.Union([Type.Literal('instant'), Type.Literal('link_required')]),
  updated_at: Type.String(),
});

export const SessionParamsSchema = Type.Object({ id: Type.String() });
export type SessionParams = Static<typeof SessionParamsSchema>;

export const ActiveSessionSchema = Type.Object({
  id: Type.String(),
  provider: Type.String(),
  device_id: Type.Union([Type.String(), Type.Null()]),
  ip: Type.Union([Type.String(), Type.Null()]),
  user_agent: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  last_used_at: Type.String(),
  expires_at: Type.String(),
  current: Type.Boolean(),
});
export const ActiveSessionsResponseSchema = Type.Object({ items: Type.Array(ActiveSessionSchema) });

export const MeResponseSchema = Type.Object({
  id: Type.String(),
  // Display-only numeric ID ("ID 10284731"), as a string like other BIGINTs.
  public_id: Type.String(),
  username: Type.String(),
  avatar_url: Type.Union([Type.String(), Type.Null()]),
  auth_provider: Type.String(),
  trust_level: Type.Number(),
  region_id: Type.String(),
  referral_code: Type.Union([Type.String(), Type.Null()]),
  wallet: Type.Object({
    available_coin: Type.String(),
    pending_coin: Type.String(),
  }),
  active_boost: Type.Union([
    Type.Object({ multiplier: Type.Integer(), expires_at: Type.String() }),
    Type.Null(),
  ]),
  // The one-time welcome bonus: its amount, whether this account has received it, and the mode
  // (under link_required a guest receives it by linking an account).
  welcome: Type.Object({
    coin: Type.Integer(),
    claimed: Type.Boolean(),
    mode: Type.Union([Type.Literal('instant'), Type.Literal('link_required')]),
  }),
});
export type MeResponse = Static<typeof MeResponseSchema>;
