import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyJwt, { type JWT } from '@fastify/jwt';
import { env, googleClientIds } from './config/env.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { AppError } from './lib/errors.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import type { AuthDeps } from './modules/auth/auth.service.js';
import { createAuthEmailSender, type AuthEmailSender } from './modules/auth/auth-email.js';
import type { AuthProviders, IdentityProvider, OAuthIdentity } from './modules/auth/ports.js';
import { GoogleIdentityProvider } from './modules/auth/google-provider.js';
import { FacebookIdentityProvider } from './modules/auth/facebook-provider.js';
import { registerWalletRoutes } from './modules/wallet-ledger/routes.js';
import { registerPostbackRoutes } from './modules/postback/routes.js';
import { registerRewardedAdsRoutes } from './modules/rewarded-ads/routes.js';
import { registerRewardedAdsAdminRoutes } from './modules/rewarded-ads/admin-routes.js';
import { registerRedemptionRoutes } from './modules/redemption/routes.js';
import { registerRedemptionAdminRoutes } from './modules/redemption/admin-routes.js';
import { registerConfigRoutes } from './modules/config/routes.js';
import { registerConfigAdminRoutes } from './modules/config/admin-routes.js';
import { registerCoinRewardSettingsAdminRoutes } from './modules/config/coin-reward-settings-admin-routes.js';
import { registerNovelRoutes } from './modules/novel/routes.js';
import { registerNovelAdminRoutes } from './modules/novel/admin-routes.js';
import { registerInboxRoutes } from './modules/inbox/routes.js';
import { registerFraudAdminRoutes } from './modules/fraud/admin-routes.js';
import { registerAdminUsersRoutes } from './modules/admin/users-routes.js';
import { registerAdminAuditRoutes } from './modules/admin/audit-routes.js';
import { registerAdminSessionRoutes } from './modules/admin/session-routes.js';
import { registerAdminAnalyticsRoutes } from './modules/admin/analytics-routes.js';
import { registerAdminRewardMonitorRoutes } from './modules/admin/reward-monitor.routes.js';
import { registerSpinRoutes } from './modules/spin/routes.js';
import { registerSpinAdminRoutes } from './modules/spin/admin-routes.js';
import { registerReferralRoutes } from './modules/referral/routes.js';
import { registerReferralAdminRoutes } from './modules/referral/admin-routes.js';
import { registerCatalogRoutes } from './modules/catalog/routes.js';
import { registerCatalogAdminRoutes } from './modules/catalog/admin-routes.js';
import { registerCheckinRoutes } from './modules/earning/checkin-routes.js';
import { registerDirectCoinRoutes } from './modules/earning/direct-coin-routes.js';
import { registerDirectCoinAdminRoutes } from './modules/earning/direct-coin-admin-routes.js';
import { registerOfferwallRoutes } from './modules/earning/offerwall-routes.js';
import { registerOfferwallAdminRoutes } from './modules/earning/offerwall-admin-routes.js';
import { registerTasksRoutes } from './modules/earning/tasks-routes.js';
import {
  createVerifierKeyStore,
  type VerifierKeyStore,
} from './modules/rewarded-ads/admob-verify.js';
import { createPostbackFraudHookQueue } from './jobs/postback-fraud-hook.js';
import { createReferralCreditQueue } from './jobs/referral-credit.js';

export interface BuildAppOverrides {
  providers?: Partial<AuthProviders>;
  verifierKeyStore?: VerifierKeyStore;
  authEmailSender?: AuthEmailSender;
}

function trustedProxies(): string[] | false {
  const proxies = (env.TRUST_PROXY ?? '')
    .split(',')
    .map((proxy) => proxy.trim())
    .filter((proxy) => proxy.length > 0);
  return proxies.length > 0 ? proxies : false;
}

const cmsDistDir = resolve(process.cwd(), 'admin/dist');
const cmsIndexPath = resolve(cmsDistDir, 'index.html');

const staticContentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

async function sendCmsFile(reply: FastifyReply, filePath: string): Promise<FastifyReply> {
  const extension = extname(filePath).toLowerCase();
  reply.type(staticContentTypes[extension] ?? 'application/octet-stream');
  // The path is resolved and constrained to admin/dist by cmsAssetPath before serving.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return reply.send(createReadStream(filePath));
}

async function cmsFileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function cmsAssetPath(requestPath: string): string | null {
  const relativePath = requestPath.replace(/^\/cms\/?/, '');
  if (!relativePath) return cmsIndexPath;

  const filePath = resolve(cmsDistDir, relativePath);
  if (filePath !== cmsDistDir && !filePath.startsWith(`${cmsDistDir}${sep}`)) return null;
  return filePath;
}

function registerCmsRoutes(app: FastifyInstance): void {
  app.get('/cms', async (_request, reply) => sendCmsFile(reply, cmsIndexPath));
  app.get('/cms/', async (_request, reply) => sendCmsFile(reply, cmsIndexPath));
  app.get('/cms/*', async (request, reply) => {
    const filePath = cmsAssetPath(request.url);
    if (!filePath) throw new AppError('CMS_ASSET_NOT_FOUND', 'CMS asset not found', 404);
    if (await cmsFileExists(filePath)) return sendCmsFile(reply, filePath);
    return sendCmsFile(reply, cmsIndexPath);
  });
}

function unconfiguredProvider(name: string): IdentityProvider {
  return {
    verify(): Promise<OAuthIdentity> {
      throw new AppError(
        'PROVIDER_NOT_CONFIGURED',
        `${name} identity provider is not configured`,
        500,
      );
    },
  };
}

// Real providers require Google/Facebook app credentials that may not exist in dev — env.ts leaves
// them optional so dev/test can boot
// without them; falling back to a stub here means a real request only fails loudly if it's actually
// routed to an unconfigured provider, while tests always inject fakes via `overrides.providers`.
function createDefaultProviders(): AuthProviders {
  const googleIds = googleClientIds();
  return {
    google:
      googleIds.length > 0 ? new GoogleIdentityProvider(googleIds) : unconfiguredProvider('Google'),
    facebook:
      env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET
        ? new FacebookIdentityProvider(env.FACEBOOK_APP_ID, env.FACEBOOK_APP_SECRET)
        : unconfiguredProvider('Facebook'),
  };
}

export async function buildApp(overrides?: BuildAppOverrides): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL },
    // Only addresses explicitly listed in TRUST_PROXY may supply X-Forwarded-For. This lets the
    // postback IP allowlist see the partner's address without trusting spoofed headers from clients.
    trustProxy: trustedProxies(),
  });

  registerErrorHandler(app);

  // access 1h / refresh 30d — user-approved resolution of the 03-API-CONTRACT.md vs backend_doing.md
  // duration conflict (see jwt.ts). Two namespaces so access/refresh tokens use distinct secrets and
  // can never be swapped for one another.
  await app.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
    namespace: 'access',
    sign: { expiresIn: '1h' },
  });
  await app.register(fastifyJwt, {
    secret: env.JWT_REFRESH_SECRET,
    namespace: 'refresh',
    sign: { expiresIn: '30d' },
  });
  const jwtNamespaces = app.jwt as unknown as { access: JWT; refresh: JWT };

  const providers: AuthProviders = { ...createDefaultProviders(), ...overrides?.providers };

  const authDeps: AuthDeps = {
    providers,
    accessJwt: jwtNamespaces.access,
    refreshJwt: jwtNamespaces.refresh,
    emailSender: overrides?.authEmailSender ?? createAuthEmailSender(),
  };

  app.get('/health', () => ({ status: 'ok' }));

  // Shared instance: both networks' credit paths enqueue into the same async fraud checkpoint
  // (05-FRAUD-ENGINE.md §1 "mỗi earning event").
  const fraudHookQueue = createPostbackFraudHookQueue();
  // Shared instance: both networks' credit paths enqueue into the same async referral-credit job
  // (11-REFERRAL.md §2 — each backed earning event spawns a REFERRAL_CREDIT for a qualified referrer).
  const referralCreditQueue = createReferralCreditQueue();

  const verifierKeyStore = overrides?.verifierKeyStore ?? createVerifierKeyStore();
  const registerJsonApiRoutes = (target: FastifyInstance): void => {
    registerConfigRoutes(target);
    registerAuthRoutes(target, authDeps);
    registerWalletRoutes(target, { accessJwt: authDeps.accessJwt });
    registerSpinRoutes(target, { accessJwt: authDeps.accessJwt });
    registerSpinAdminRoutes(target);
    registerReferralRoutes(target, { accessJwt: authDeps.accessJwt });
    registerReferralAdminRoutes(target);
    registerCatalogRoutes(target);
    registerCatalogAdminRoutes(target);
    registerCheckinRoutes(target, { accessJwt: authDeps.accessJwt });
    registerOfferwallRoutes(target);
    registerOfferwallAdminRoutes(target);
    registerTasksRoutes(target, { accessJwt: authDeps.accessJwt });
    registerRewardedAdsRoutes(target, {
      accessJwt: authDeps.accessJwt,
      verifierKeyStore,
      fraudHookQueue,
      referralCreditQueue,
    });
    registerRewardedAdsAdminRoutes(target);
    registerRedemptionRoutes(target, { accessJwt: authDeps.accessJwt });
    registerRedemptionAdminRoutes(target);
    registerInboxRoutes(target, { accessJwt: authDeps.accessJwt });
    registerFraudAdminRoutes(target);
    registerAdminSessionRoutes(target);
    registerAdminUsersRoutes(target);
    registerAdminAuditRoutes(target);
    registerAdminAnalyticsRoutes(target);
    registerAdminRewardMonitorRoutes(target);
    registerConfigAdminRoutes(target);
    registerCoinRewardSettingsAdminRoutes(target);
    registerDirectCoinRoutes(target, { accessJwt: authDeps.accessJwt });
    registerDirectCoinAdminRoutes(target);
    registerNovelRoutes(target, { accessJwt: authDeps.accessJwt });
    registerNovelAdminRoutes(target);
  };

  registerJsonApiRoutes(app);
  registerPostbackRoutes(app, { fraudHookQueue, referralCreditQueue });
  registerCmsRoutes(app);
  await app.register(
    (v1, _opts, done) => {
      registerJsonApiRoutes(v1);
      done();
    },
    { prefix: '/v1' },
  );

  return app;
}
