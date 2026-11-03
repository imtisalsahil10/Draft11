/**
 * Idempotent seat-token migration for live room documents.
 * Copies only the seat credential fields that change. Balances, card ids,
 * auction state, and ownership are left as they were.
 */

import { hashSeatToken } from './seat-token.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function migrateRoomDocument(doc) {
  const next = clone(doc);
  let changed = false;
  const seats = next?.state?.seats;
  if (!Array.isArray(seats)) return { doc: next, changed: false };

  for (const seat of seats) {
    if (typeof seat.seatToken !== 'string' || seat.seatToken.length < 32) continue;
    const hash = hashSeatToken(seat.seatToken);
    if (typeof seat.seatTokenHash === 'string' && seat.seatTokenHash !== hash) continue;
    if (seat.seatTokenHash !== hash) seat.seatTokenHash = hash;
    delete seat.seatToken;
    changed = true;
  }
  return { doc: next, changed };
}

export function verifySeatTokenBackup(source, backup) {
  if (!Array.isArray(source) || !Array.isArray(backup) || source.length !== backup.length) return false;
  for (let index = 0; index < source.length; index += 1) {
    const left = source[index];
    const right = backup[index];
    if (!left || !right) return false;
    if (left.roomId !== right.roomId || left.code !== right.code) return false;
    if (left.hostSeatId !== right.hostSeatId) return false;
    const leftSeats = left.state?.seats || [];
    const rightSeats = right.state?.seats || [];
    if (leftSeats.length !== rightSeats.length) return false;
    for (let seat = 0; seat < leftSeats.length; seat += 1) {
      if (leftSeats[seat].seatId !== rightSeats[seat].seatId) return false;
      if (leftSeats[seat].seatToken !== rightSeats[seat].seatToken) return false;
      if (leftSeats[seat].balance !== rightSeats[seat].balance) return false;
      if (JSON.stringify(leftSeats[seat].cardIds) !== JSON.stringify(rightSeats[seat].cardIds)) return false;
    }
  }
  return true;
}
