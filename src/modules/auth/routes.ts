import type { FastifyInstance } from 'fastify';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import { AppError } from '../../lib/errors.js';
import { checkRateLimit, checkSubjectRateLimit } from '../../lib/rate-limit.js';
import {
  bindIdentity,
  bindPasswordCredential,
  changePassword,
  guestSignup,
  oauthAuthenticate,
  passwordLogin,
  passwordRegister,
  requestPasswordReset,
  resetPassword,
  verifyPasswordEmail,
  getUserProfile,
  type AuthRequestContext,
  type AuthDeps,
  type DeviceInput,
} from './auth.service.js';
import { listActiveSessions, revokeAllSessions, revokeSession, rotateRefreshToken } from './jwt.js';
import { recordAuthEvent } from './auth-events.js';
import { normalizeInstallationId } from './fingerprint.js';
import { listLoginRewardOffers } from '../config/coin-reward-settings.service.js';
import {
  AppHeadersSchema,
  DeviceRegistrationHeadersSchema,
  BindBodySchema,
  ActiveSessionsResponseSchema,
  AuthMessageResponseSchema,
  EmailVerificationBodySchema,
  GuestSignupBodySchema,
  LoginRewardOffersResponseSchema,
  MeResponseSchema,
  OAuthAuthBodySchema,
  PasswordBindBodySchema,
  PasswordChangeBodySchema,
  PasswordForgotBodySchema,
  PasswordLoginBodySchema,
  PasswordRegisterBodySchema,
  PasswordResetBodySchema,
  RefreshBodySchema,
  SessionParamsSchema,
  type BindBody,
  type EmailVerificationBody,
  type DeviceInputBody,
  type GuestSignupBody,
  type OAuthAuthBody,
  type PasswordBindBody,
  type PasswordChangeBody,
  type PasswordForgotBody,
  type PasswordLoginBody,
  type PasswordRegisterBody,
  type PasswordResetBody,
  type RefreshBody,
  type SessionParams,
} from './schemas.js';

const AUTH_RATE_LIMIT_WINDOW_S = 60;
const AUTH_SIGNIN_RATE_LIMIT_MAX = 20;
const AUTH_REFRESH_RATE_LIMIT_MAX = 60;
const AUTH_BIND_RATE_LIMIT_MAX = 20;
const AUTH_PASSWORD_RATE_LIMIT_MAX = 10;
const AUTH_RECOVERY_RATE_LIMIT_MAX = 5;

function toDeviceInput(
  device: DeviceInputBody,
  appVersion: string | undefined,
  rawInstallationId: string | undefined,
): DeviceInput {
  const installationId = normalizeInstallationId(rawInstallationId);
  if (!installationId) {
    throw new AppError('INVALID_DEVICE_ID', 'X-Device-Id must be a non-zero UUID', 400);
  }
  return {
    installationId,
    gaid: device.gaid ?? null,
    model: device.model,
    os: device.os,
    buildProps: device.build_props,
    appVersion,
  };
}

function authContext(request: {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}): AuthRequestContext {
  const userAgent = request.headers['user-agent'];
  const deviceId = request.headers['x-device-id'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
    deviceId: typeof deviceId === 'string' ? deviceId : undefined,
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.get(
    '/auth/login-offers',
    {
      schema: {
        headers: AppHeadersSchema,
        response: { 200: LoginRewardOffersResponseSchema },
      },
    },
    async (_request, reply) => {
      const offers = await listLoginRewardOffers();
      reply.code(200).send({
        ...offers,
        updated_at: offers.updated_at.toISOString(),
      });
    },
  );

  app.post<{ Body: GuestSignupBody }>(
    '/auth/guest',
    { schema: { headers: DeviceRegistrationHeadersSchema, body: GuestSignupBodySchema } },
    async (request, reply) => {
      await checkRateLimit(
        'auth-guest',
        request.ip,
        AUTH_RATE_LIMIT_WINDOW_S,
        AUTH_SIGNIN_RATE_LIMIT_MAX,
      );
      const appVersion = request.headers['x-app-version'] as string | undefined;
      const result = await guestSignup(
        deps,
        toDeviceInput(
          request.body.device,
          appVersion,
          request.headers['x-device-id'] as string | undefined,
        ),
        authContext(request),
      );
      reply.code(200).send(result);
    },
  );

  const registerOAuthRoute = (path: string, providerName: 'google' | 'facebook'): void => {
    app.post<{ Body: OAuthAuthBody }>(
      path,
      { schema: { headers: DeviceRegistrationHeadersSchema, body: OAuthAuthBodySchema } },
      async (request, reply) => {
        await checkRateLimit(
          `auth-${providerName}`,
          request.ip,
          AUTH_RATE_LIMIT_WINDOW_S,
          AUTH_SIGNIN_RATE_LIMIT_MAX,
        );
        const appVersion = request.headers['x-app-version'] as string | undefined;
        const result = await oauthAuthenticate(
          deps,
          providerName,
          request.body.id_token,
          toDeviceInput(
            request.body.device,
            appVersion,
            request.headers['x-device-id'] as string | undefined,
          ),
          authContext(request),
        );
        reply.code(200).send(result);
      },
    );
  };
  registerOAuthRoute('/auth/google', 'google');
  registerOAuthRoute('/auth/facebook', 'facebook');

  app.post<{ Body: BindBody }>(
    '/auth/bind',
    { schema: { headers: AppHeadersSchema, body: BindBodySchema }, preHandler: authGuard },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      await checkSubjectRateLimit(
        'auth-bind',
        request.authUser.sub,
        AUTH_RATE_LIMIT_WINDOW_S,
        AUTH_BIND_RATE_LIMIT_MAX,
      );
      const result = await bindIdentity(
        deps,
        request.authUser.sub,
        request.body.provider,
        request.body.id_token,
        authContext(request),
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Body: RefreshBody }>(
    '/auth/refresh',
    { schema: { headers: AppHeadersSchema, body: RefreshBodySchema } },
    async (request, reply) => {
      await checkRateLimit(
        'auth-refresh',
        request.ip,
        AUTH_RATE_LIMIT_WINDOW_S,
        AUTH_REFRESH_RATE_LIMIT_MAX,
      );
      const tokens = await rotateRefreshToken(
        deps.accessJwt,
        deps.refreshJwt,
        request.body.refresh,
        authContext(request),
      );
      reply.code(200).send(tokens);
    },
  );

  app.post<{ Body: PasswordRegisterBody }>(
    '/auth/password/register',
    { schema: { headers: DeviceRegistrationHeadersSchema, body: PasswordRegisterBodySchema } },
    async (request, reply) => {
      const username = request.body.username.trim().toLowerCase();
      await Promise.all([
        checkRateLimit('auth-password-register', request.ip, 60, AUTH_PASSWORD_RATE_LIMIT_MAX),
        checkSubjectRateLimit('auth-password-register-user', username, 60, 5),
      ]);
      const appVersion = request.headers['x-app-version'] as string | undefined;
      const result = await passwordRegister(
        deps,
        request.body,
        toDeviceInput(
          request.body.device,
          appVersion,
          request.headers['x-device-id'] as string | undefined,
        ),
        authContext(request),
      );
      reply.code(201).send(result);
    },
  );

  app.post<{ Body: PasswordLoginBody }>(
    '/auth/password/login',
    { schema: { headers: AppHeadersSchema, body: PasswordLoginBodySchema } },
    async (request, reply) => {
      const username = request.body.username.trim().toLowerCase();
      await Promise.all([
        checkRateLimit('auth-password-login', request.ip, 60, AUTH_PASSWORD_RATE_LIMIT_MAX),
        checkSubjectRateLimit('auth-password-login-user', username, 60, 5),
      ]);
      const result = await passwordLogin(
        deps,
        request.body.username,
        request.body.password,
        authContext(request),
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Body: PasswordBindBody }>(
    '/auth/password/bind',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        body: PasswordBindBodySchema,
        response: { 200: AuthMessageResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      await checkSubjectRateLimit('auth-password-bind', request.authUser.sub, 60, 5);
      await bindPasswordCredential(deps, request.authUser.sub, request.body, authContext(request));
      reply.code(200).send({ message: 'Password login linked. Check your email to verify it.' });
    },
  );

  app.post<{ Body: PasswordChangeBody }>(
    '/auth/password/change',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        body: PasswordChangeBodySchema,
        response: { 200: AuthMessageResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      await changePassword(
        request.authUser.sub,
        request.body.current_password,
        request.body.new_password,
        authContext(request),
      );
      reply.code(200).send({ message: 'Password changed. Sign in again on your devices.' });
    },
  );

  app.post<{ Body: PasswordForgotBody }>(
    '/auth/password/forgot',
    {
      schema: {
        headers: AppHeadersSchema,
        body: PasswordForgotBodySchema,
        response: { 200: AuthMessageResponseSchema },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      await Promise.all([
        checkRateLimit('auth-password-forgot', request.ip, 3600, AUTH_RECOVERY_RATE_LIMIT_MAX),
        checkSubjectRateLimit('auth-password-forgot-email', email, 3600, 3),
      ]);
      await requestPasswordReset(deps, email, authContext(request));
      reply.code(200).send({
        message: 'If a verified account exists, a password reset email has been sent.',
      });
    },
  );

  app.post<{ Body: PasswordResetBody }>(
    '/auth/password/reset',
    {
      schema: {
        headers: AppHeadersSchema,
        body: PasswordResetBodySchema,
        response: { 200: AuthMessageResponseSchema },
      },
    },
    async (request, reply) => {
      await checkRateLimit('auth-password-reset', request.ip, 60, AUTH_RECOVERY_RATE_LIMIT_MAX);
      await resetPassword(request.body.token, request.body.new_password, authContext(request));
      reply.code(200).send({ message: 'Password reset. Sign in with your new password.' });
    },
  );

  app.post<{ Body: EmailVerificationBody }>(
    '/auth/password/verify-email',
    {
      schema: {
        headers: AppHeadersSchema,
        body: EmailVerificationBodySchema,
        response: { 200: AuthMessageResponseSchema },
      },
    },
    async (request, reply) => {
      await checkRateLimit('auth-email-verify', request.ip, 60, AUTH_RECOVERY_RATE_LIMIT_MAX);
      await verifyPasswordEmail(request.body.token, authContext(request));
      reply.code(200).send({ message: 'Email verified.' });
    },
  );

  app.get(
    '/auth/sessions',
    {
      preHandler: authGuard,
      schema: { headers: AppHeadersSchema, response: { 200: ActiveSessionsResponseSchema } },
    },
    async (request, reply) => {
      if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      const sessions = await listActiveSessions(request.authUser.sub);
      reply.code(200).send({
        items: sessions.map((session) => ({
          ...session,
          current: session.id === request.authUser?.sid,
        })),
      });
    },
  );

  app.delete<{ Params: SessionParams }>(
    '/auth/sessions/:id',
    {
      preHandler: authGuard,
      schema: { headers: AppHeadersSchema, params: SessionParamsSchema },
    },
    async (request, reply) => {
      if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      await revokeSession(request.authUser.sub, request.params.id, 'user_session_revoked');
      reply.code(204).send();
    },
  );

  app.post(
    '/auth/logout',
    { preHandler: authGuard, schema: { headers: AppHeadersSchema } },
    async (request, reply) => {
      if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      const context = authContext(request);
      await revokeSession(request.authUser.sub, request.authUser.sid, 'user_logout');
      await recordAuthEvent({
        ...context,
        userId: request.authUser.sub,
        provider: 'session',
        eventType: 'logout',
        outcome: 'success',
      });
      reply.code(204).send();
    },
  );

  app.post(
    '/auth/logout-all',
    { preHandler: authGuard, schema: { headers: AppHeadersSchema } },
    async (request, reply) => {
      if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      const context = authContext(request);
      await revokeAllSessions(request.authUser.sub, 'user_logout_all');
      await recordAuthEvent({
        ...context,
        userId: request.authUser.sub,
        provider: 'session',
        eventType: 'logout_all',
        outcome: 'success',
      });
      reply.code(204).send();
    },
  );

  app.get(
    '/me',
    {
      preHandler: authGuard,
      schema: { headers: AppHeadersSchema, response: { 200: MeResponseSchema } },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const profile = await getUserProfile(request.authUser.sub);
      reply.code(200).send(profile);
    },
  );
}
