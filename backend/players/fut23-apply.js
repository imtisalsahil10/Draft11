/**
 * APPLY A FIFA 23 PLAN
 * Inserts catalogue players and card versions. An id that already belongs to
 * a different person or a different source row stops the import. Identical
 * rows are skipped. This module has no MongoDB connection and cannot delete
 * the auction card collection.
 */

import { isDeepStrictEqual } from 'node:util';

const PLAYER_IDENTITY = ['playerId', 'name', 'normalizedName'];
const CARD_IDENTITY = ['cardId', 'playerId', 'sourceRowNumber', 'sourceCardId'];
const IGNORE = new Set(['createdAt', 'updatedAt', '_id', '__v']);

function plain(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (IGNORE.has(key)) continue;
      const next = value[key];
      out[key] = next == null ? null : plain(next);
    }
    return out;
  }
  return value;
}

function identityOf(doc, keys) {
  const out = {};
  for (const key of keys) out[key] = doc?.[key] ?? null;
  return out;
}

function changed(existing, incoming) {
  return !isDeepStrictEqual(plain(existing), plain(incoming));
}

export function diffFut23Import(existingPlayers = [], existingCards = [], plan, protectedIds = [], options = {}) {
  const allowPrintedNameCorrection = options.allowPrintedNameCorrection === true;
  const protectedSet = new Set((protectedIds || []).map((id) => String(id)));
  const playersById = new Map(existingPlayers.map((player) => [String(player.playerId), player]));
  const cardsById = new Map(existingCards.map((card) => [String(card.cardId), card]));
  const conflicts = [];
  const insertPlayers = [];
  const updatePlayers = [];
  const skipPlayers = [];
  const insertCards = [];
  const updateCards = [];
  const skipCards = [];

  for (const player of plan.players) {
    if (protectedSet.has(player.playerId)) {
      conflicts.push({ kind: 'player', id: player.playerId, reason: 'id is already an auction or legacy card' });
      continue;
    }
    const existing = playersById.get(player.playerId);
    if (!existing) {
      insertPlayers.push(player);
      continue;
    }
    if (!allowPrintedNameCorrection && !isDeepStrictEqual(identityOf(existing, PLAYER_IDENTITY), identityOf(player, PLAYER_IDENTITY))) {
      conflicts.push({
        kind: 'player',
        id: player.playerId,
        reason: 'existing player id belongs to a different identity',
        existing: identityOf(existing, PLAYER_IDENTITY),
        incoming: identityOf(player, PLAYER_IDENTITY)
      });
      continue;
    }
    if (changed(existing, player)) {
      updatePlayers.push({ ...player, createdAt: existing.createdAt || player.createdAt });
    } else {
      skipPlayers.push(player.playerId);
    }
  }

  for (const card of plan.cards) {
    if (protectedSet.has(card.cardId) || protectedSet.has(card.playerId)) {
      conflicts.push({ kind: 'card', id: card.cardId, reason: 'id is already an auction or legacy card' });
      continue;
    }
    const existing = cardsById.get(card.cardId);
    if (!existing) {
      insertCards.push(card);
      continue;
    }
    if (!isDeepStrictEqual(identityOf(existing, CARD_IDENTITY), identityOf(card, CARD_IDENTITY))) {
      conflicts.push({
        kind: 'card',
        id: card.cardId,
        reason: 'existing card id belongs to a different player or source row',
        existing: identityOf(existing, CARD_IDENTITY),
        incoming: identityOf(card, CARD_IDENTITY)
      });
      continue;
    }
    if (changed(existing, card)) updateCards.push({ ...card, createdAt: existing.createdAt || card.createdAt });
    else skipCards.push(card.cardId);
  }

  return {
    conflicts,
    insertPlayers,
    updatePlayers,
    skipPlayers,
    insertCards,
    updateCards,
    skipCards
  };
}

export function createMemoryCatalogue(initial = {}) {
  let players = new Map((initial.players || []).map((player) => [player.playerId, player]));
  let cards = new Map((initial.cards || []).map((card) => [card.cardId, card]));
  let protectedState = structuredClone(initial.protectedState || { cards: [], leagues: [], fixtures: [], handoffs: [] });
  const writes = [];
  return {
    writes,
    async readPlayers() {
      return [...players.values()].map((player) => structuredClone(player));
    },
    async readCards() {
      return [...cards.values()].map((card) => structuredClone(card));
    },
    async readProtected() {
      return structuredClone(protectedState);
    },
    async backup() {
      return {
        players: [...players.values()],
        cards: [...cards.values()]
      };
    },
    async transaction(work) {
      const playerSnap = structuredClone([...players.entries()]);
      const cardSnap = structuredClone([...cards.entries()]);
      const protectedSnap = structuredClone(protectedState);
      const tx = {
        insertPlayers(docs) {
          writes.push('catalogue_players');
          for (const doc of docs) players.set(doc.playerId, structuredClone(doc));
        },
        updatePlayers(docs) {
          writes.push('catalogue_players');
          for (const doc of docs) players.set(doc.playerId, structuredClone(doc));
        },
        insertCards(docs) {
          writes.push('player_cards');
          for (const doc of docs) cards.set(doc.cardId, structuredClone(doc));
        },
        updateCards(docs) {
          writes.push('player_cards');
          for (const doc of docs) cards.set(doc.cardId, structuredClone(doc));
        }
      };
      try {
        await work(tx);
      } catch (err) {
        players = new Map(playerSnap);
        cards = new Map(cardSnap);
        protectedState = protectedSnap;
        throw err;
      }
    }
  };
}

export async function applyFut23Import(adapter, plan, options = {}) {
  const existingPlayers = await adapter.readPlayers();
  const existingCards = await adapter.readCards();
  const diff = diffFut23Import(existingPlayers, existingCards, plan, options.protectedIds || [], options);
  if (diff.conflicts.length) {
    return {
      ok: false,
      written: false,
      code: 'IDENTITY_CONFLICT',
      ...diff
    };
  }
  const writes = diff.insertPlayers.length + diff.updatePlayers.length + diff.insertCards.length + diff.updateCards.length;
  if (!writes) {
    return { ok: true, written: false, backup: null, ...diff };
  }
  const backup = await adapter.backup();
  try {
    await adapter.transaction(async (tx) => {
      if (diff.insertPlayers.length) await tx.insertPlayers(diff.insertPlayers);
      if (diff.updatePlayers.length) await tx.updatePlayers(diff.updatePlayers);
      if (options.afterPlayerWrites) await options.afterPlayerWrites();
      if (diff.insertCards.length) await tx.insertCards(diff.insertCards);
      if (diff.updateCards.length) await tx.updateCards(diff.updateCards);
    });
  } catch (err) {
    return {
      ok: false,
      written: false,
      rolledBack: true,
      backup: Boolean(backup),
      code: 'ROLLED_BACK',
      error: err.message,
      ...diff
    };
  }
  return { ok: true, written: true, backup: Boolean(backup), rolledBack: false, ...diff };
}
