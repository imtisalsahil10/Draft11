/**
 * Shared browser-origin allowlist for Express and Socket.IO.
 * Production never reflects every origin and never treats "*" as allowed.
 */

import { isProduction } from './production.js';

const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function configuredOrigins(env = process.env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin && origin !== '*');
}

export function originAllowed(origin, env = process.env) {
  if (!origin) return true;
  if (origin === '*' || origin === 'null') return false;
  if (configuredOrigins(env).includes(origin)) return true;
  if (isProduction(env)) return false;
  return DEV_ORIGIN.test(origin);
}

export function createOriginGuard(env = process.env) {
  return function originGuard(req, res, next) {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    if (!originAllowed(origin, env)) {
      res.status(403).json({ success: false, error: 'Origin not allowed' });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

export function socketCors(env = process.env) {
  return {
    origin(origin, callback) {
      if (originAllowed(origin, env)) callback(null, true);
      else callback(new Error('Origin not allowed'), false);
    },
    methods: ['GET', 'POST']
  };
}
