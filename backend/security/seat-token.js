/**
 * Seat credentials. Newly issued tokens are stored only as a SHA-256 hash.
 * A legacy raw seatToken is still accepted until the live migration removes it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashSeatToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function issueSeatToken() {
  return randomBytes(24).toString('hex');
}

function sameHex(stored, computed) {
  if (typeof stored !== 'string' || typeof computed !== 'string') return false;
  if (!/^[a-f0-9]{64}$/i.test(stored) || !/^[a-f0-9]{64}$/i.test(computed)) return false;
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(computed, 'hex'));
}

function sameRaw(stored, presented) {
  if (typeof stored !== 'string' || typeof presented !== 'string') return false;
  if (stored.length !== presented.length || stored.length < 32 || stored.length > 128) return false;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(presented));
}

export function credentialMatches(player, presented) {
  if (!player || typeof presented !== 'string' || presented.length < 32 || presented.length > 128) {
    return false;
  }
  if (typeof player.seatTokenHash === 'string') {
    return sameHex(player.seatTokenHash, hashSeatToken(presented));
  }
  if (typeof player.seatToken === 'string') return sameRaw(player.seatToken, presented);
  return false;
}
