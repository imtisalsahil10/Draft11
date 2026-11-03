/**
 * FINISHED AUCTION HANDOFF
 *
 * A live room is removed by the existing sweep and disconnect timers.
 * This record is the only thing kept so a manager can still link that
 * squad. It stores the hash of the seat token, the seat id, and the card
 * ids copied from the server team at the moment the auction finished.
 * The raw token, the socket id, the balance, and the rest of the room
 * are not stored.
 *
 * A record lasts 24 hours. Cleanup deletes expired records, including
 * ones already claimed, because the league member document is the
 * lasting association. Publishing the same seat again does not move
 * the expiry or the card ids and does not clear a claim.
 * Claiming is a compare-and-set: the first league member to present
 * the seat token owns it, and a retry by that same member returns the
 * same claim.
 */

import { AuctionHandoff } from './models.js';
import { hashSeatToken } from './security/seat-token.js';

export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

export { hashSeatToken };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function present(row) {
  if (!row) return null;
  return {
    tokenHash: row.tokenHash,
    roomId: row.roomId || null,
    seatId: row.seatId || null,
    cardIds: Array.isArray(row.cardIds) ? row.cardIds.map((id) => String(id)) : [],
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    claim: row.claim?.leagueId && row.claim?.memberId
      ? { leagueId: String(row.claim.leagueId), memberId: String(row.claim.memberId) }
      : null
  };
}

function buildRecord({ tokenHash, roomId, seatId, cardIds, now = Date.now() }) {
  if (typeof tokenHash !== 'string' || tokenHash.length !== 64) return null;
  const created = new Date(now);
  return {
    tokenHash,
    roomId: roomId ? String(roomId) : null,
    seatId: seatId ? String(seatId) : null,
    cardIds: (Array.isArray(cardIds) ? cardIds : [])
      .filter((id) => id != null && id !== '')
      .map((id) => String(id)),
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + HANDOFF_TTL_MS).toISOString(),
    claim: null
  };
}

export class MemoryHandoffStore {
  constructor() {
    this.rows = new Map();
  }

  async publish(input) {
    const record = buildRecord(input || {});
    if (!record) return null;
    const existing = this.rows.get(record.tokenHash);
    if (existing) return clone(existing);
    this.rows.set(record.tokenHash, record);
    return clone(record);
  }

  async find(tokenHash) {
    const row = this.rows.get(tokenHash);
    return row ? clone(row) : null;
  }

  async claim(tokenHash, claim, now = Date.now()) {
    const row = this.rows.get(tokenHash);
    if (!row) return { ok: false, reason: 'missing' };
    if (Date.parse(row.expiresAt) <= now) return { ok: false, reason: 'expired', record: clone(row) };
    if (!claim?.leagueId || !claim?.memberId) return { ok: false, reason: 'missing' };
    if (row.claim && (row.claim.leagueId !== claim.leagueId || row.claim.memberId !== claim.memberId)) {
      return { ok: false, reason: 'claimed', record: clone(row) };
    }
    row.claim = { leagueId: String(claim.leagueId), memberId: String(claim.memberId) };
    return { ok: true, record: clone(row) };
  }

  async deleteExpired(now = Date.now()) {
    const cutoff = new Date(now).toISOString();
    let removed = 0;
    for (const [hash, row] of this.rows) {
      if (row.expiresAt <= cutoff) {
        this.rows.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }
}

export class MongoHandoffStore {
  constructor(Model = null) {
    this.Model = Model || AuctionHandoff;
  }

  async publish(input) {
    const record = buildRecord(input || {});
    if (!record) return null;
    const doc = {
      ...record,
      createdAt: new Date(record.createdAt),
      expiresAt: new Date(record.expiresAt)
    };
    try {
      const created = await this.Model.create(doc);
      return present(typeof created.toObject === 'function' ? created.toObject() : created);
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const existing = await this.Model.findOne({ tokenHash: record.tokenHash }).lean();
      return present(existing);
    }
  }

  async find(tokenHash) {
    const row = await this.Model.findOne({ tokenHash }).lean();
    return present(row);
  }

  async claim(tokenHash, claim, now = Date.now()) {
    if (!claim?.leagueId || !claim?.memberId) return { ok: false, reason: 'missing' };
    const owned = { leagueId: String(claim.leagueId), memberId: String(claim.memberId) };
    const updated = await this.Model.findOneAndUpdate(
      {
        tokenHash,
        expiresAt: { $gt: new Date(now) },
        $or: [
          { claim: null },
          { claim: { $exists: false } },
          { 'claim.leagueId': owned.leagueId, 'claim.memberId': owned.memberId }
        ]
      },
      { $set: { claim: owned } },
      { new: true }
    ).lean();
    if (updated) return { ok: true, record: present(updated) };
    const existing = await this.Model.findOne({ tokenHash }).lean();
    if (!existing) return { ok: false, reason: 'missing' };
    const shown = present(existing);
    if (Date.parse(shown.expiresAt) <= now) return { ok: false, reason: 'expired', record: shown };
    return { ok: false, reason: 'claimed', record: shown };
  }

  async deleteExpired(now = Date.now()) {
    const result = await this.Model.deleteMany({ expiresAt: { $lte: new Date(now) } });
    return result.deletedCount || 0;
  }
}
