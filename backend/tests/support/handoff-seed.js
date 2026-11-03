import { readFileSync } from 'node:fs';
import { hashSeatToken } from '../../handoff-store.js';
import { suggestEleven } from '../../league-match.js';

export function takeElevens(count) {
  const pool = JSON.parse(readFileSync(new URL('../../../cards.json', import.meta.url), 'utf8'));
  const groups = [];
  for (let index = 0; index < count; index += 1) {
    const suggestion = suggestEleven(pool);
    if (!suggestion) throw new Error('catalog cannot fill another XI');
    const ids = new Set(suggestion.cards.map((card) => String(card.id)));
    for (let cursor = pool.length - 1; cursor >= 0; cursor -= 1) {
      if (ids.has(String(pool[cursor].id))) pool.splice(cursor, 1);
    }
    groups.push({
      token: `${index.toString(16).padStart(2, '0')}`.repeat(24).slice(0, 48),
      formation: suggestion.formation,
      assignments: suggestion.assignments.map((slot) => ({
        slotId: slot.slotId,
        cardId: String(slot.cardId)
      })),
      cardIds: suggestion.cards.map((card) => String(card.id))
    });
  }
  return groups;
}

export async function insertHandoffs(connection, groups) {
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await connection.collection('auctionhandoffs').insertMany(groups.map((group, index) => ({
    tokenHash: hashSeatToken(group.token),
    roomId: `room-${index}`,
    seatId: `seat-${index}`,
    cardIds: group.cardIds,
    createdAt: now,
    expiresAt: expires,
    claim: null
  })));
}
