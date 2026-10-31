import { Prisma } from '@prisma/client';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

/**
 * Turns any thrown error into a consistent JSON shape:
 *   { error: { code, message, details?, requestId } }
 * Unknown errors never leak stack traces or SQL to the client; the details go
 * to the log, correlated by requestId.
 */
export function errorHandler(isProduction: boolean): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = String(req.id ?? '');

    if (err instanceof AppError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details, requestId },
      });
      return;
    }

    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          requestId,
        },
      });
      return;
    }

    // body-parser errors (malformed JSON, payload too large) carry a `type`.
    const type = (err as { type?: string }).type;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body', requestId } });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', requestId } });
      return;
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({
        error: { code: 'DUPLICATE', message: 'A record with these unique fields already exists', requestId },
      });
      return;
    }

    req.log?.error({ err }, 'unhandled error');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: isProduction ? 'Something went wrong' : String((err as Error)?.message ?? err),
        requestId,
      },
    });
  };
}
