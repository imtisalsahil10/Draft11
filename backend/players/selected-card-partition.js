/**
 * LIVE SELECTION
 * The stored catalogue keeps every OCR identity. The live catalogue and
 * auction pool keep one selected card when several records are the same
 * printed player. A shared display name is not enough.
 */

import { normalizeName, playerIdFor } from './image-catalogue.js';

const OUTFIELD = ['overallRating', 'pace', 'shooting', 'passing', 'dribbling', 'defending', 'physical'];
const KEEPER = ['diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning'];

function text(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function printedIdentity(card) {
  if (card?.cardPixelReading?.nameConfident !== true) return '';
  const raw = card.cardPixelReading.ocrName || card.ocrName || '';
  return normalizeName(raw).replaceAll(' ', '');
}

function displayIdentity(player) {
  return text(player?.normalizedName) || normalizeName(player?.name);
}

function ratingOf(card) {
  return typeof card?.overallRating === 'number' && Number.isFinite(card.overallRating)
    ? card.overallRating
    : -1;
}

function statFingerprint(card) {
  const keeper = card?.goalkeeperAttributes || {};
  return [
    ...OUTFIELD.map((field) => card?.[field] ?? ''),
    ...KEEPER.map((field) => keeper?.[field] ?? '')
  ].join('|');
}

function prefer(left, right, cardOf) {
  const ratingGap = ratingOf(cardOf(right)) - ratingOf(cardOf(left));
  if (ratingGap !== 0) return ratingGap;
  const canonical = playerIdFor(left?.name) || playerIdFor(displayIdentity(left));
  if (canonical) {
    if (left.playerId === canonical && right.playerId !== canonical) return -1;
    if (right.playerId === canonical && left.playerId !== canonical) return 1;
  }
  return String(left.playerId).localeCompare(String(right.playerId));
}

function statClusters(players, cardOf) {
  const clusters = [];
  const used = new Set();
  for (let index = 0; index < players.length; index += 1) {
    if (used.has(index)) continue;
    const cluster = [players[index]];
    used.add(index);
    const fingerprint = statFingerprint(cardOf(players[index]));
    for (let other = index + 1; other < players.length; other += 1) {
      if (used.has(other)) continue;
      if (statFingerprint(cardOf(players[other])) !== fingerprint) continue;
      cluster.push(players[other]);
      used.add(other);
    }
    if (cluster.length > 1) clusters.push(cluster);
  }
  return clusters;
}

function clustersFor(group, cardOf) {
  const byBody = new Map();
  const withoutBody = [];
  for (const player of group) {
    const body = text(cardOf(player)?.bodyType);
    if (!body) {
      withoutBody.push(player);
      continue;
    }
    if (!byBody.has(body)) byBody.set(body, []);
    byBody.get(body).push(player);
  }
  return [
    ...[...byBody.values()].filter((items) => items.length > 1),
    ...statClusters(withoutBody, cardOf)
  ];
}

function reasonFor(kept, extra, cardOf) {
  const keptCard = cardOf(kept);
  const extraCard = cardOf(extra);
  const sameCard = statFingerprint(keptCard) === statFingerprint(extraCard)
    && ratingOf(keptCard) === ratingOf(extraCard);
  if (sameCard) {
    return `Duplicate selected card of ${kept.name}. ${kept.playerId} stays in the live catalogue.`;
  }
  const keptRating = ratingOf(keptCard);
  return `Lower-rated version of ${kept.name}. ${kept.playerId} keeps the ${keptRating} selected card.`;
}

/**
 * @param {object|null} stored
 * @returns {{ live: object, archived: object, heldBack: object[] }}
 */
export function partitionSelectedCards(stored) {
  const players = Array.isArray(stored?.players) ? stored.players : [];
  const cards = Array.isArray(stored?.cards) ? stored.cards : [];
  const cardsByPlayer = new Map();
  for (const card of cards) {
    if (!card?.playerId || card.isPrimary === false) continue;
    if (!cardsByPlayer.has(card.playerId)) cardsByPlayer.set(card.playerId, card);
  }
  const cardOf = (player) => cardsByPlayer.get(player.playerId) || null;
  const groups = new Map();
  for (const player of players) {
    const card = cardOf(player);
    const printed = printedIdentity(card);
    const position = text(card?.position);
    const name = displayIdentity(player);
    if (!printed || !position || !name) continue;
    const key = `${name}|${printed}|${position}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(player);
  }

  const heldBack = [];
  const archivedIds = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const cluster of clustersFor(group, cardOf)) {
      const ranked = [...cluster].sort((left, right) => prefer(left, right, cardOf));
      const kept = ranked[0];
      for (const extra of ranked.slice(1)) {
        if (archivedIds.has(extra.playerId)) continue;
        archivedIds.add(extra.playerId);
        const card = cardOf(extra);
        heldBack.push({
          playerId: extra.playerId,
          cardId: card?.cardId || null,
          keptPlayerId: kept.playerId,
          name: extra.name,
          overall: card?.overallRating ?? null,
          position: card?.position || null,
          imagePath: card?.imagePath || null,
          sourceImage: card?.sourceImage || null,
          sourceImageHash: card?.sourceImageHash || null,
          reason: reasonFor(kept, extra, cardOf)
        });
      }
    }
  }

  const livePlayers = players.filter((player) => !archivedIds.has(player.playerId));
  const liveCards = cards.filter((card) => !archivedIds.has(card.playerId));
  const archivedPlayers = players.filter((player) => archivedIds.has(player.playerId));
  const archivedCards = cards.filter((card) => archivedIds.has(card.playerId));
  return {
    live: { ...(stored || {}), players: livePlayers, cards: liveCards },
    archived: { ...(stored || {}), players: archivedPlayers, cards: archivedCards },
    heldBack
  };
}

export function archiveEntry(player, card, held) {
  return {
    sourceImage: card?.sourceImage || null,
    sourcePath: card?.sourcePath || null,
    sourceImageHash: card?.sourceImageHash || null,
    name: player?.name || held?.name || null,
    overall: card?.overallRating ?? null,
    position: card?.position || null,
    alternatePositions: Array.isArray(card?.alternatePositions) ? card.alternatePositions : [],
    playerId: player?.playerId || held?.playerId || null,
    keptPlayerId: held?.keptPlayerId || null,
    identityName: displayIdentity(player),
    imagePath: card?.imagePath || null,
    heldFromLiveCatalogue: true,
    reasonNotSelected: held?.reason || 'Archived alternative version.'
  };
}
