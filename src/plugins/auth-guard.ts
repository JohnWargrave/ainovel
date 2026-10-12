import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { AppError } from '../lib/errors.js';
import {
  assertActiveSession,
  verifyAccessToken,
  type AccessTokenPayload,
} from '../modules/auth/jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AccessTokenPayload;
  }
}

// Not registered globally — each protected route opts in via `preHandler: createAuthGuard(accessJwt)`,
// since only some routes (bind, wallet) require a bearer token.
//
// Fastify's preHandler runner (hookRunnerGenerator in fastify/lib/hooks.js) always invokes hooks as
// `fn(request, reply, next)` and only calls `next()` itself when the hook's return value is a thenable —
// a plain sync function with no third `done` param and no Promise return leaves the chain stalled
// forever on success (thrown errors are still caught synchronously, so only the happy path hangs).
// Must keep returning a Promise here even though the body has no `await`.
export function createAuthGuard(accessJwt: JWT) {
  return async function authGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
    }
    const token = header.slice('Bearer '.length);
    request.authUser = verifyAccessToken(accessJwt, token);
    await assertActiveSession(request.authUser);
  };
}
