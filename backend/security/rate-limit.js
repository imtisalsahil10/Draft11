/**
 * In-memory limits for public writes. No shared store: one game process
 * is the current deployment. Limits sit above a normal table of players
 * and a short reconnect burst.
 */

import { isProduction } from './production.js';

export const LIMITS = {
  roomCreate: { windowMs: 60 * 1000, max: 30 },
  roomJoin: { windowMs: 60 * 1000, max: 120 },
  leagueCreate: { windowMs: 10 * 60 * 1000, max: 20 },
  leagueJoin: { windowMs: 10 * 60 * 1000, max: 30 },
  squadWrite: { windowMs: 60 * 1000, max: 60 }
};

export function createRateLimiter({ windowMs, max, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const id = String(key || 'unknown');
      const time = now();
      const recent = (hits.get(id) || []).filter((stamp) => time - stamp < windowMs);
      if (recent.length >= max) {
        hits.set(id, recent);
        return false;
      }
      recent.push(time);
      hits.set(id, recent);
      return true;
    }
  };
}

export function httpLimit(limiter, message) {
  return function limitRequest(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    if (limiter.allow(key)) {
      next();
      return;
    }
    res.status(429).json({
      success: false,
      error: 'RATE_LIMITED',
      message
    });
  };
}

export function socketAddress(socket, env = process.env) {
  if (isProduction(env)) {
    const forwarded = socket?.handshake?.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const client = forwarded.split(',')[0].trim();
      if (client) return client;
    }
  }
  return socket?.handshake?.address || 'unknown';
}
