import pino, { type Logger } from 'pino';
import { env } from './env';

// Anything that could be a credential is replaced before a log line is written.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-admin-key"]',
  'req.headers["x-control-key"]',
  'req.headers["x-paystack-signature"]',
  'req.headers["x-mock-signature"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.apiKey',
  '*.secret',
  '*.password',
];

let instance: Logger | undefined;

export function logger(): Logger {
  if (!instance) {
    const config = env();
    instance = pino({
      level: config.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: { service: 'api' },
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
        : {}),
    });
  }
  return instance;
}
