/**
 * LIVE IMAGE AUCTION POOL
 * One selected card per image-catalogue identity. Missing ratings and
 * attributes stay empty. A card without a real selected image is archived
 * out of the pool and is not given a placeholder.
 */

import fs from 'fs';
import path from 'path';
import { isAllowedPlayerCardArt } from '../../shared/player-card-art.js';

export const UNRATED_OPENING_PRICE = 10;

export const OVERALL_BAND_PRICES = {
  LEGENDARY: 25,
  RARE: 15,
  BASIC: 10
};

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function nameKey(value) {
  return text(value)?.toLowerCase() || '';
}

function ratingForPrice(value) {
  const rating = finite(value);
  if (rating == null || rating < 1 || rating > 99) return null;
  return rating;
}

function bandFor(index, total) {
  const percentile = total > 0 ? index / total : 1;
  if (percentile < 0.10) return 'LEGENDARY';
  if (percentile < 0.40) return 'RARE';
  return 'BASIC';
}

function goalkeepingOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keeper = {};
  for (const key of ['diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning']) {
    const rating = finite(value[key]);
    if (rating != null) keeper[key] = rating;
  }
  return Object.keys(keeper).length ? keeper : null;
}

function selectedCard(player, cards) {
  const list = (cards || []).filter((card) => card && card.isPrimary !== false);
  if (!list.length) return null;
  const primary = list.find((card) => card.cardId === player.primaryCardId);
  if (primary) return primary;
  if (list.length === 1) return list[0];
  return null;
}

function historicalIdsFor(player, historicalByName) {
  const keys = [nameKey(player?.name), nameKey(player?.normalizedName)].filter(Boolean);
  const ids = new Set();
  for (const key of keys) {
    for (const id of historicalByName.get(key) || []) ids.add(id);
  }
  return [...ids];
}

/**
 * Confirms a public card file has a PNG or WebP header.
 * Full decode results from the migration are applied by the caller via fileExists.
 */
export function cardArtHeaderOk(file) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const header = Buffer.alloc(12);
    const read = fs.readSync(handle, header, 0, 12, 0);
    if (read < 12) return false;
    const png = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
    const webp = header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !webp) return false;
    return fs.statSync(file).size > 32;
  } catch {
    return false;
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

export function servableCardArt(directory) {
  return (url) => {
    if (!isAllowedPlayerCardArt(url)) return false;
    const filename = url.slice('/player-cards/'.length);
    const root = path.resolve(directory || '');
    const target = path.resolve(root, filename);
    if (path.relative(root, target) !== filename) return false;
    return cardArtHeaderOk(target);
  };
}

/**
 * @param {object|null} stored local catalogue document
 * @param {{ fileExists?: (url: string) => boolean, historicalCards?: object[] }} [options]
 */
export function buildLiveImagePool(stored, { fileExists, historicalCards = [] } = {}) {
  const players = Array.isArray(stored?.players) ? stored.players : [];
  const byPlayer = new Map();
  for (const card of stored?.cards || []) {
    if (!card?.playerId) continue;
    if (!byPlayer.has(card.playerId)) byPlayer.set(card.playerId, []);
    byPlayer.get(card.playerId).push(card);
  }

  const historicalByName = new Map();
  for (const card of historicalCards || []) {
    if (typeof card?.id !== 'string' || !/^fifa_\d+$/.test(card.id)) continue;
    const key = nameKey(card.name);
    if (!key) continue;
    if (!historicalByName.has(key)) historicalByName.set(key, []);
    historicalByName.get(key).push(card.id);
  }

  const seen = new Set();
  const excluded = [];
  const cards = [];
  const overlaps = [];

  for (const player of players) {
    const playerId = text(player?.playerId);
    const name = text(player?.name);
    if (!playerId) {
      excluded.push({ playerId: null, name, reason: 'The catalogue identity has no record id.' });
      continue;
    }
    if (seen.has(playerId)) {
      excluded.push({ playerId, name, reason: 'This identity is already in the live pool.' });
      continue;
    }
    seen.add(playerId);
    const source = selectedCard(player, byPlayer.get(playerId));
    if (!source) {
      excluded.push({
        playerId,
        name,
        reason: 'No single selected card is stored for this identity.'
      });
      continue;
    }
    if (source.imageAssociation && source.imageAssociation !== 'selected-card') {
      excluded.push({
        playerId,
        name,
        imagePath: source.imagePath || null,
        reason: 'The stored image is not the selected card artwork.'
      });
      continue;
    }
    const imagePath = text(source.imagePath);
    if (!imagePath || !isAllowedPlayerCardArt(imagePath)) {
      excluded.push({ playerId, name, reason: 'The selected card has no servable image path.' });
      continue;
    }
    if (typeof fileExists === 'function' && !fileExists(imagePath)) {
      excluded.push({ playerId, name, imagePath, reason: 'The selected card image is missing or cannot be read as an image.' });
      continue;
    }
    const goalkeeping = goalkeepingOf(source.goalkeeperAttributes);
    const auctionCard = {
      id: playerId,
      catalogueCardId: source.cardId || null,
      name: name || '',
      position: text(source.position),
      nationality: text(player.nationality),
      club: text(player.club),
      league: text(player.league),
      basePrice: UNRATED_OPENING_PRICE,
      basePriceSource: 'unrated-opening',
      category: 'BASIC',
      stats: {
        overall: finite(source.overallRating),
        pace: finite(source.pace),
        shooting: finite(source.shooting),
        passing: finite(source.passing),
        dribbling: finite(source.dribbling),
        defense: finite(source.defending),
        physical: finite(source.physical)
      },
      alternatePositions: Array.isArray(source.alternatePositions)
        ? source.alternatePositions.filter((item) => typeof item === 'string' && item.trim())
        : [],
      imageCatalogue: true,
      auctionEligible: true,
      cardArtUrl: imagePath,
      cardArtApproved: true,
      cardArtApprovalStatus: 'approved_for_use',
      cardArtRightsStatus: 'approved_for_use',
      cardArtTesting: false,
      cardArtValidated: true
    };
    if (goalkeeping) auctionCard.goalkeeping = goalkeeping;
    const historicalCardIds = historicalIdsFor(player, historicalByName);
    if (historicalCardIds.length) {
      overlaps.push({ playerId, name, historicalCardIds });
    }
    cards.push(auctionCard);
  }

  const byPath = new Map();
  for (const card of cards) {
    if (!byPath.has(card.cardArtUrl)) byPath.set(card.cardArtUrl, []);
    byPath.get(card.cardArtUrl).push(card);
  }
  const duplicateImageAssignments = [];
  const duplicateIds = new Set();
  for (const [imagePath, group] of byPath) {
    if (group.length < 2) continue;
    const playerIds = group.map((card) => card.id);
    duplicateImageAssignments.push({ imagePath, playerIds });
    for (const card of group) {
      duplicateIds.add(card.id);
      excluded.push({
        playerId: card.id,
        name: card.name,
        imagePath,
        reason: 'The selected image is assigned to more than one catalogue identity.'
      });
    }
  }
  const uniqueCards = cards.filter((card) => !duplicateIds.has(card.id));

  const rated = uniqueCards.filter((card) => ratingForPrice(card.stats.overall) != null);
  rated.sort((left, right) => (
    right.stats.overall - left.stats.overall || String(left.id).localeCompare(String(right.id))
  ));
  rated.forEach((card, index) => {
    const category = bandFor(index, rated.length);
    card.category = category;
    card.basePrice = OVERALL_BAND_PRICES[category];
    card.basePriceSource = 'overall-band';
  });

  const withOverall = uniqueCards.filter((card) => finite(card.stats.overall) != null).length;
  return {
    cards: uniqueCards,
    report: {
      label: 'Live image catalogue',
      identities: players.length,
      entered: uniqueCards.length,
      excluded,
      duplicateImageAssignments,
      historicalOverlaps: overlaps.filter((item) => uniqueCards.some((card) => card.id === item.playerId)),
      withOverall,
      withoutOverall: uniqueCards.length - withOverall,
      unratedOpeningPrice: UNRATED_OPENING_PRICE,
      overallBands: OVERALL_BAND_PRICES,
      overallBandRule: 'Among cards with an extracted overall from 1 to 99, the top 10% open at £25, the next 30% at £15, and the rest at £10. Cards without that rating keep the £10 opening price and an empty overall.',
      liveAuctionActivated: true,
      auctionEligible: true
    }
  };
}
