import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';

// Registered directly (not via app.register) so it applies at the root, unencapsulated —
// every route in every module gets the same {error:{code,message}} contract from 03 §errors.
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    });
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      if (error.details) {
        request.log.warn({ code: error.code, ...error.details }, error.message);
      }
      reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.publicDetails ?? {}) },
      });
      return;
    }

    if (error.validation) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: error.message } });
      return;
    }

    request.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
        message: statusCode >= 500 ? 'Internal server error' : error.message,
      },
    });
  });
}
