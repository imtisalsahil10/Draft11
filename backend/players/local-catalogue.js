/**
 * LOCAL IMAGE CATALOGUE
 * Loads an original card-image catalogue into the local catalogue store.
 * The original source has source "card-images" and one selected image filename
 * per player. A published catalogue (source "image-catalogue", with stored card
 * versions) is refused: it has no source image on the player, so rebuilding it
 * would drop the source card filename and could treat archived alternatives as
 * selected cards. Live auction cards, rooms, squads, and the source files are
 * not modified. Nothing is deleted.
 */

import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { cardArtNameKey } from '../../shared/player-card-art.js';
import { applyFut23Import, createMemoryCatalogue, diffFut23Import } from './fut23-apply.js';
import { normalizeName } from './image-catalogue.js';

export const LOCAL_SOURCE = 'image-catalogue';
const ORIGINAL_SOURCE = 'card-images';
const PLAYER_ID = /^fut23_[a-z0-9_]+$/;
const ART_FILE = /^fut23_[a-z0-9_]+_(?:primary|card_\d{2})\.(?:webp|png)$/;
const ART_URL = /^\/player-cards\/fut23_[a-z0-9_]+_(?:primary|card_\d{2})\.(?:webp|png)$/;

export function isPublicCardArtPath(url) {
  return typeof url === 'string' && url.length <= 200 && ART_URL.test(url) && !url.includes('..');
}

export function selectedCardId(playerId) {
  return `${playerId}_selected`;
}

export function stableRowNumber(playerId, taken) {
  let hash = 2166136261;
  for (let index = 0; index < playerId.length; index += 1) {
    hash ^= playerId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let row = 7000000 + ((hash >>> 0) % 1000000);
  while (taken.has(row)) row += 1;
  taken.add(row);
  return row;
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function sameFile(left, right) {
  let leftStat;
  let rightStat;
  try {
    leftStat = fs.statSync(left);
    rightStat = fs.statSync(right);
  } catch {
    return false;
  }
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  return sha256(left) === sha256(right);
}

function insideDirectory(root, file) {
  const base = path.resolve(root);
  const target = path.resolve(file);
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function publicFile(publicDir, imagePath) {
  if (!isPublicCardArtPath(imagePath)) return null;
  const filename = imagePath.slice('/player-cards/'.length);
  const target = path.resolve(publicDir, filename);
  if (!insideDirectory(publicDir, target)) return null;
  return target;
}

function extensionFor(file) {
  const ext = path.extname(file || '').toLowerCase();
  if (ext === '.webp' || ext === '.png') return ext;
  if (ext === '.png'.toLowerCase()) return '.png';
  return null;
}

function candidateNames(playerId, ext) {
  const names = [`${playerId}_primary${ext}`];
  for (let index = 1; index <= 99; index += 1) {
    names.push(`${playerId}_card_${String(index).padStart(2, '0')}${ext}`);
  }
  return names;
}

function claimFilename(playerId, ext, sourcePath, publicDir, reserved) {
  for (const name of candidateNames(playerId, ext)) {
    if (!ART_FILE.test(name) || reserved.has(name)) continue;
    const dest = path.resolve(publicDir, name);
    if (!insideDirectory(publicDir, dest)) continue;
    if (!fs.existsSync(dest)) {
      reserved.add(name);
      return { filename: name, dest, needsCopy: true };
    }
    if (sameFile(sourcePath, dest)) {
      reserved.add(name);
      return { filename: name, dest, needsCopy: false };
    }
  }
  return null;
}

function reserveExisting(imagePath, publicDir, reserved) {
  const file = publicFile(publicDir, imagePath);
  if (!file || !fs.existsSync(file)) return null;
  const filename = path.basename(file);
  reserved.add(filename);
  return `/player-cards/${filename}`;
}

/**
 * Copy the selected source into public/player-cards when it is not already there.
 * Existing public files are never overwritten.
 */
export function publishSelectedImage(player, { publicDir, reserved, storedCard = null } = {}) {
  fs.mkdirSync(publicDir, { recursive: true });
  const storedHash = storedCard?.sourceImageHash || null;
  const sameSelection = storedHash && storedHash === player?.sourceImageHash;
  if (sameSelection) {
    const kept = reserveExisting(storedCard.imagePath, publicDir, reserved);
    if (kept) return { imagePath: kept, copied: false, missing: false, broken: false };
  }
  const published = reserveExisting(player?.imagePath, publicDir, reserved);
  if (published) return { imagePath: published, copied: false, missing: false, broken: false };

  const sourcePath = player?.sourcePath ? path.resolve(player.sourcePath) : '';
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { imagePath: null, copied: false, missing: true, broken: false, reason: 'Selected image file is missing.' };
  }
  if (insideDirectory(publicDir, sourcePath)) {
    const filename = path.basename(sourcePath);
    if (ART_FILE.test(filename)) {
      reserved.add(filename);
      return { imagePath: `/player-cards/${filename}`, copied: false, missing: false, broken: false };
    }
  }
  const ext = extensionFor(sourcePath);
  if (!ext) {
    return {
      imagePath: null,
      copied: false,
      missing: false,
      broken: true,
      reason: 'Selected image is not a PNG or WebP file.'
    };
  }
  const claim = claimFilename(player.playerId, ext, sourcePath, publicDir, reserved);
  if (!claim) {
    return {
      imagePath: null,
      copied: false,
      missing: false,
      broken: true,
      reason: 'No free public filename for the selected card.'
    };
  }
  if (claim.needsCopy) {
    try {
      fs.copyFileSync(sourcePath, claim.dest, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      return {
        imagePath: null,
        copied: false,
        missing: false,
        broken: true,
        reason: `The selected image could not be copied: ${err.message}`
      };
    }
    if (!sameFile(sourcePath, claim.dest)) {
      fs.rmSync(claim.dest, { force: true });
      return {
        imagePath: null,
        copied: false,
        missing: false,
        broken: true,
        reason: 'The public copy does not match the selected image.'
      };
    }
  }
  return { imagePath: `/player-cards/${claim.filename}`, copied: claim.needsCopy, missing: false, broken: false };
}

function emptyList(value) {
  return Array.isArray(value) && value.length ? value.filter((item) => typeof item === 'string') : [];
}

function keeperOrNull(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keeper = {};
  for (const key of ['diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning']) {
    if (typeof value[key] === 'number') keeper[key] = value[key];
  }
  return Object.keys(keeper).length ? keeper : null;
}

function rowFor(playerId, existingCard, taken) {
  const current = existingCard?.sourceRowNumber;
  if (Number.isInteger(current) && current > 0 && !taken.has(current)) {
    taken.add(current);
    return current;
  }
  return stableRowNumber(playerId, taken);
}

export function buildLocalCataloguePlan(sourcePlayers, publications, now = new Date(), existingCards = []) {
  const incoming = new Set((sourcePlayers || []).map((player) => player?.playerId).filter(Boolean));
  const existingByPlayer = new Map();
  const taken = new Set();
  for (const card of existingCards || []) {
    if (!card?.playerId) continue;
    if (!existingByPlayer.has(card.playerId)) existingByPlayer.set(card.playerId, card);
    if (!incoming.has(card.playerId) && Number.isInteger(card.sourceRowNumber)) taken.add(card.sourceRowNumber);
  }
  const players = [];
  const cards = [];
  const excluded = [];
  const ordered = [...(sourcePlayers || [])].sort((left, right) => String(left.playerId).localeCompare(String(right.playerId)));
  const seenIds = new Set();
  const seenNames = new Set();
  for (const source of ordered) {
    const playerId = source?.playerId;
    const name = typeof source?.name === 'string' ? source.name.trim() : '';
    if (!PLAYER_ID.test(playerId || '') || !name) {
      excluded.push({
        playerId: playerId || null,
        name: name || null,
        reason: 'The card identity has no stable player id or printed name.'
      });
      continue;
    }
    if (seenIds.has(playerId)) {
      excluded.push({ playerId, name, reason: 'The source catalogue listed this player id twice. The first record was kept.' });
      continue;
    }
    const normalizedName = normalizeName(name);
    if (!normalizedName) {
      excluded.push({ playerId, name, reason: 'The printed name cannot be stored as a catalogue key.' });
      continue;
    }
    if (seenNames.has(normalizedName)) {
      excluded.push({
        playerId,
        name,
        reason: 'Another catalogue identity already uses this normalised name. The records were not merged.'
      });
      continue;
    }
    seenIds.add(playerId);
    seenNames.add(normalizedName);
    const publication = publications.get(playerId) || { imagePath: null, missing: true, broken: false };
    const cardId = selectedCardId(playerId);
    const imagePath = isPublicCardArtPath(publication.imagePath) ? publication.imagePath : null;
    const card = {
      cardId,
      playerId,
      source: LOCAL_SOURCE,
      sourceVersion: 'card-images',
      sourceRowNumber: rowFor(playerId, existingByPlayer.get(playerId), taken),
      sourceCardId: source.sourceImage || cardId,
      overallRating: typeof source.overall === 'number' ? source.overall : null,
      position: source.position || null,
      alternatePositions: emptyList(source.alternatePositions),
      pace: typeof source.pace === 'number' ? source.pace : null,
      shooting: typeof source.shooting === 'number' ? source.shooting : null,
      passing: typeof source.passing === 'number' ? source.passing : null,
      dribbling: typeof source.dribbling === 'number' ? source.dribbling : null,
      defending: typeof source.defending === 'number' ? source.defending : null,
      physical: typeof source.physical === 'number' ? source.physical : null,
      goalkeeperAttributes: keeperOrNull(source.goalkeeperAttributes),
      cardType: source.cardType || null,
      imagePath,
      imageAssociation: imagePath ? 'selected-card' : null,
      ocrName: source.ocrName || null,
      sourceImage: source.sourceImage || null,
      sourceImageHash: source.sourceImageHash || null,
      sourcePath: source.sourcePath || null,
      selectionReason: source.selectionReason || null,
      auctionEligible: false,
      isPrimary: true,
      createdAt: now,
      updatedAt: now
    };
    cards.push(card);
    players.push({
      playerId,
      name,
      normalizedName,
      source: LOCAL_SOURCE,
      sourcePlayerId: playerId,
      identityStatus: 'card_image',
      imageStatus: imagePath ? 'selected_local' : (publication.missing ? 'missing' : 'broken'),
      primaryCardId: cardId,
      nationality: source.nationality ?? null,
      club: source.club ?? null,
      league: source.league ?? null,
      age: null,
      sofifaId: null,
      createdAt: now,
      updatedAt: now
    });
  }
  players.sort((left, right) => left.playerId.localeCompare(right.playerId));
  cards.sort((left, right) => left.cardId.localeCompare(right.cardId));
  return { players, cards, excluded };
}

function conflictRecord(conflict) {
  return {
    playerId: conflict.kind === 'player' ? conflict.id : null,
    cardId: conflict.kind === 'card' ? conflict.id : null,
    reason: conflict.reason
  };
}

function letterDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index]);
  for (let column = 1; column <= right.length; column += 1) rows[0][column] = column;
  for (let y = 1; y <= left.length; y += 1) {
    for (let x = 1; x <= right.length; x += 1) {
      const cost = left[y - 1] === right[x - 1] ? 0 : 1;
      rows[y][x] = Math.min(rows[y - 1][x] + 1, rows[y][x - 1] + 1, rows[y - 1][x - 1] + cost);
    }
  }
  return rows[left.length][right.length];
}

export function overlayPrintedReadings(plan, readings, sourcePlayers = []) {
  const byId = new Map();
  for (const reading of readings || []) {
    if (reading?.playerId) byId.set(reading.playerId, reading);
  }
  const sourceById = new Map((sourcePlayers || []).filter((player) => player?.playerId).map((player) => [player.playerId, player]));
  const cardsByPlayer = new Map(plan.cards.map((card) => [card.playerId, card]));
  const mismatches = [];
  const outfield = ['pace', 'shooting', 'passing', 'dribbling', 'defending', 'physical'];
  for (const player of plan.players) {
    const source = sourceById.get(player.playerId) || {};
    const card = cardsByPlayer.get(player.playerId);
    const reading = byId.get(player.playerId);
    player.previousName = typeof source.name === 'string' ? source.name : player.name;
    if (card) card.previousOcrName = source.ocrName || null;
    if (!reading || !card) continue;
    const reasons = Array.isArray(reading.reviewReasons) ? reading.reviewReasons.filter((item) => typeof item === 'string') : [];
    if (reading.nameConfident === true && typeof reading.displayName === 'string' && reading.displayName.trim()) {
      const next = reading.displayName.trim();
      const nextKey = normalizeName(next);
      const nextLetters = nextKey.replace(/ /g, '');
      const previousLetters = normalizeName(player.previousName).replace(/ /g, '');
      if (nextKey && nextLetters.length >= 3) {
        const samePlayer = previousLetters === nextLetters;
        const cardAddsLetters = previousLetters && nextLetters.includes(previousLetters) && nextLetters.length > previousLetters.length;
        const storedNameIsFuller = previousLetters.includes(nextLetters) && previousLetters.length > nextLetters.length;
        if (typeof reading.ocrName === 'string' && reading.ocrName) card.ocrName = reading.ocrName;
        const nearMiss = !cardAddsLetters && previousLetters.length >= 4 && letterDistance(previousLetters, nextLetters) <= 2;
        if (nearMiss) {
          reasons.push('The printed name was close to the stored name but not clear enough to replace it.');
        } else if (!samePlayer && !storedNameIsFuller && (cardAddsLetters || previousLetters.length < 4 || previousLetters !== nextLetters)) {
          mismatches.push({
            playerId: player.playerId,
            previousName: player.previousName,
            printedName: next
          });
          player.name = next;
          player.normalizedName = nextKey;
        } else if (storedNameIsFuller) {
          reasons.push('The printed name was only partly read, so the stored name was kept.');
        }
      }
    }
    if (reading.overallConfident === true && typeof reading.overall === 'number') card.overallRating = reading.overall;
    if (reading.positionConfident === true && typeof reading.position === 'string' && reading.position) card.position = reading.position;
    if (reading.attributesConfident === true && reading.goalkeeperAttributes) {
      card.goalkeeperAttributes = keeperOrNull(reading.goalkeeperAttributes);
      for (const field of outfield) card[field] = null;
    } else {
      for (const field of outfield) {
        if (typeof reading[field] === 'number') card[field] = reading[field];
      }
      if (reading.attributesConfident === true) card.goalkeeperAttributes = null;
      else if (reading.goalkeeperAttributes) card.goalkeeperAttributes = keeperOrNull(reading.goalkeeperAttributes);
    }
    if (reading.nationalityConfident === true && typeof reading.nationality === 'string' && reading.nationality) {
      player.nationality = reading.nationality;
    }
    card.crestOnCard = reading.crestOnCard === true;
    card.flagOnCard = reading.flagOnCard === true;
    card.reviewReasons = reasons;
    card.cardPixelReading = {
      ocrName: reading.ocrName || null,
      displayName: reading.displayName || null,
      overall: typeof reading.overall === 'number' ? reading.overall : null,
      position: reading.position || null,
      nationality: reading.nationality || null,
      nameConfident: reading.nameConfident === true,
      overallConfident: reading.overallConfident === true,
      positionConfident: reading.positionConfident === true,
      nationalityConfident: reading.nationalityConfident === true,
      attributesConfident: reading.attributesConfident === true,
      rawOcr: reading.rawOcr || null,
      reviewReasons: reasons
    };
    card.auctionEligible = false;
  }
  const grouped = new Map();
  for (const player of plan.players) {
    if (!grouped.has(player.normalizedName)) grouped.set(player.normalizedName, []);
    grouped.get(player.normalizedName).push(player.playerId);
  }
  const collisions = [...grouped.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([normalizedName, playerIds]) => ({ normalizedName, playerIds }));
  return { mismatches, collisions };
}

export function withoutConflicts(existingPlayers, existingCards, plan, protectedIds = [], options = {}) {
  const preview = diffFut23Import(existingPlayers, existingCards, plan, protectedIds, options);
  if (!preview.conflicts.length) return { plan, excluded: [] };
  const blockedPlayers = new Set();
  const blockedCards = new Set();
  for (const conflict of preview.conflicts) {
    if (conflict.kind === 'player') blockedPlayers.add(conflict.id);
    if (conflict.kind === 'card') blockedCards.add(conflict.id);
  }
  for (const card of plan.cards) {
    if (blockedCards.has(card.cardId)) blockedPlayers.add(card.playerId);
  }
  return {
    excluded: preview.conflicts.map(conflictRecord),
    plan: {
      players: plan.players.filter((player) => !blockedPlayers.has(player.playerId)),
      cards: plan.cards.filter((card) => !blockedPlayers.has(card.playerId) && !blockedCards.has(card.cardId))
    }
  };
}

export function auditLocalCatalogue(stored, publicDir, excluded = []) {
  const players = stored?.players || [];
  const cards = (stored?.cards || []).filter((card) => card.isPrimary !== false);
  const playerById = new Map(players.map((player) => [player.playerId, player]));
  const missingImageFiles = [];
  const brokenPaths = [];
  const playersWithFallback = [];
  const byPath = new Map();
  const byHash = new Map();
  let imagesServed = 0;
  for (const card of cards) {
    const player = playerById.get(card.playerId);
    const name = player?.name || card.playerId;
    const entry = { playerId: card.playerId, name, imagePath: card.imagePath || null };
    if (card.sourceImageHash) {
      if (!byHash.has(card.sourceImageHash)) byHash.set(card.sourceImageHash, []);
      byHash.get(card.sourceImageHash).push(card.playerId);
    }
    if (!card.imagePath || !isPublicCardArtPath(card.imagePath)) {
      brokenPaths.push({ ...entry, reason: card.imagePath ? 'Image path is not a public card file.' : 'No image path is stored.' });
      playersWithFallback.push({ ...entry, reason: 'No servable card image.' });
      continue;
    }
    const file = publicFile(publicDir, card.imagePath);
    if (!file || !fs.existsSync(file)) {
      missingImageFiles.push({ ...entry, reason: 'Image file is not in the public card directory.' });
      playersWithFallback.push({ ...entry, reason: 'Image file is missing.' });
      continue;
    }
    imagesServed += 1;
    if (!byPath.has(card.imagePath)) byPath.set(card.imagePath, []);
    byPath.get(card.imagePath).push(card.playerId);
  }
  const duplicateImageAssignments = [...byPath.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([imagePath, playerIds]) => ({ imagePath, playerIds }));
  const duplicateSourceImages = [...byHash.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([sourceImageHash, playerIds]) => ({ sourceImageHash, playerIds }));
  const selectedCards = cards.length;
  return {
    totalPlayerIdentities: players.length,
    totalSelectedCards: selectedCards,
    imagesServed,
    cardsWithArtworkFile: imagesServed,
    missingImageFiles,
    brokenPaths,
    duplicateImageAssignments,
    duplicateSourceImages,
    playersWithFallback,
    excluded,
    liveAuctionActivated: false,
    auctionEligible: false
  };
}

export function toClientCard(player, card) {
  const goalkeeping = keeperOrNull(card.goalkeeperAttributes);
  return {
    id: player.playerId,
    name: player.name,
    position: card.position || '',
    nationality: player.nationality || '',
    club: player.club || '',
    league: player.league || '',
    category: 'BASIC',
    stats: {
      overall: card.overallRating ?? null,
      pace: card.pace ?? null,
      shooting: card.shooting ?? null,
      passing: card.passing ?? null,
      dribbling: card.dribbling ?? null,
      defense: card.defending ?? null,
      physical: card.physical ?? null
    },
    ...(goalkeeping ? { goalkeeping } : {}),
    alternatePositions: emptyList(card.alternatePositions),
    localCatalogue: true,
    cardArtExpected: true,
    auctionEligible: false,
    ocrName: card.ocrName || null,
    crestOnCard: card.crestOnCard === true,
    flagOnCard: card.flagOnCard === true,
    reviewReasons: Array.isArray(card.reviewReasons) ? card.reviewReasons : [],
    cardArtUrl: card.imagePath || '',
    cardArtApproved: Boolean(card.imagePath),
    cardArtApprovalStatus: card.imagePath ? 'approved_for_use' : '',
    cardArtTesting: true,
    cardArtValidated: true
  };
}

export function artMapFromCatalogue(stored) {
  const map = new Map();
  const cards = new Map((stored?.cards || []).filter((card) => card.isPrimary !== false).map((card) => [card.playerId, card]));
  for (const player of stored?.players || []) {
    const card = cards.get(player.playerId);
    const key = cardArtNameKey(player.name);
    if (!key || !card?.imagePath || !isPublicCardArtPath(card.imagePath) || map.has(key)) continue;
    map.set(key, card.imagePath);
  }
  return map;
}

function readJson(file, fallback) {
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sourcePlayerShape(player) {
  if (!player || typeof player !== 'object' || Array.isArray(player)) return 'other';
  const hasSourceImage = typeof player.sourceImage === 'string' && player.sourceImage.trim() !== '';
  const hasPublishedIdentity = typeof player.normalizedName === 'string'
    || typeof player.primaryCardId === 'string'
    || player.identityStatus === 'card_image';
  if (hasSourceImage && hasPublishedIdentity) return 'mixed';
  if (hasSourceImage) return 'original';
  if (hasPublishedIdentity) return 'published';
  return 'other';
}

/**
 * Original card-image selections are the only supported import.
 * A published catalogue is a different document and is not applied.
 */
export function classifyImageCatalogueSource(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.players)) {
    return {
      format: 'invalid',
      reason: 'The catalogue file is not a JSON catalogue object. Nothing was imported.'
    };
  }
  let publishedPlayers = 0;
  let originalPlayers = 0;
  let mixedPlayers = 0;
  for (const player of document.players) {
    const shape = sourcePlayerShape(player);
    if (shape === 'published') publishedPlayers += 1;
    else if (shape === 'original') originalPlayers += 1;
    else if (shape === 'mixed') mixedPlayers += 1;
  }
  const hasCards = Array.isArray(document.cards);
  const publishedSignals = (document.source === LOCAL_SOURCE ? 1 : 0)
    + (hasCards ? 1 : 0)
    + (publishedPlayers > 0 ? 1 : 0);
  const originalSignals = (document.source === ORIGINAL_SOURCE ? 1 : 0) + (originalPlayers > 0 ? 1 : 0);
  if (mixedPlayers > 0 || (publishedPlayers > 0 && originalPlayers > 0) || (publishedSignals > 0 && originalSignals > 0)) {
    return {
      format: 'mixed',
      reason: 'This file mixes an original card-image source with a published catalogue. Nothing was imported, and the store was left unchanged.'
    };
  }
  if (publishedSignals > 0) {
    return {
      format: 'published',
      reason: 'This file is a published catalogue, not an original card-image source. Importing it would rebuild source card ids without their image filenames and could return archived alternatives to the selected-card partition. The store was left unchanged.'
    };
  }
  if (originalSignals > 0 || document.players.length === 0) {
    return { format: 'original', reason: null };
  }
  return {
    format: 'unrecognized',
    reason: 'The catalogue file is not an original card-image source. Nothing was imported, and the store was left unchanged.'
  };
}

function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const backupDir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(backupDir, `catalogue-${stamp}.json`));
  }
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

export async function importImageCatalogue({
  sourceFile,
  storeFile,
  publicDir,
  protectedIds = [],
  now = new Date()
} = {}) {
  const source = readJson(sourceFile, { players: [] });
  const classification = classifyImageCatalogueSource(source);
  if (classification.format !== 'original') {
    return {
      ok: false,
      written: false,
      copied: 0,
      format: classification.format,
      code: 'UNSUPPORTED_SOURCE_FORMAT',
      error: classification.reason,
      excluded: [],
      audit: null
    };
  }
  const sourcePlayers = Array.isArray(source?.players) ? source.players : [];
  const existing = readJson(storeFile, { players: [], cards: [] });
  const existingPlayers = existing.players || [];
  const existingCards = existing.cards || [];
  const storedCards = new Map(existingCards.map((card) => [card.playerId, card]));
  const reserved = new Set();
  const publications = new Map();
  let copied = 0;
  const ordered = [...sourcePlayers].sort((left, right) => String(left.playerId).localeCompare(String(right.playerId)));
  for (const player of ordered) {
    const published = publishSelectedImage(player, {
      publicDir,
      reserved,
      storedCard: storedCards.get(player.playerId) || null
    });
    if (published.copied) copied += 1;
    publications.set(player.playerId, published);
  }
  const built = buildLocalCataloguePlan(sourcePlayers, publications, now, existingCards);
  const readingsFile = path.join(path.dirname(storeFile), 'card-readings.json');
  const readingsDoc = readJson(readingsFile, null);
  const readings = Array.isArray(readingsDoc) ? readingsDoc : (Array.isArray(readingsDoc?.readings) ? readingsDoc.readings : []);
  const overlay = readings.length
    ? overlayPrintedReadings(built, readings, sourcePlayers)
    : { mismatches: [], collisions: [] };
  const correction = { allowPrintedNameCorrection: readings.length > 0 };
  const safe = withoutConflicts(existingPlayers, existingCards, built, protectedIds, correction);
  const adapter = createMemoryCatalogue({ players: existingPlayers, cards: existingCards });
  const applied = await applyFut23Import(adapter, safe.plan, { protectedIds, ...correction });
  if (!applied.ok) {
    return {
      ok: false,
      written: false,
      copied,
      format: 'original',
      code: applied.code,
      error: applied.error || 'The local catalogue was not written.',
      excluded: [...built.excluded, ...safe.excluded],
      audit: null
    };
  }
  const players = await adapter.readPlayers();
  const cards = await adapter.readCards();
  const excluded = [...built.excluded, ...safe.excluded];
  const stored = {
    generatedAt: applied.written ? now.toISOString() : (existing.generatedAt || now.toISOString()),
    source: LOCAL_SOURCE,
    sourceCatalogue: sourceFile,
    liveAuctionActivated: false,
    auctionEligible: false,
    players,
    cards
  };
  if (applied.written) writeStore(storeFile, stored);
  const audit = auditLocalCatalogue(stored, publicDir, excluded);
  if (readings.length) {
    const pixelAuditFile = path.join(path.dirname(storeFile), 'card-ocr-audit.json');
    const pixelAudit = readJson(pixelAuditFile, {});
    const kept = new Set((applied.written ? players : safe.plan.players).map((player) => player.playerId));
    const corrected = overlay.mismatches.filter((item) => kept.has(item.playerId));
    fs.writeFileSync(pixelAuditFile, JSON.stringify({
      ...pixelAudit,
      recordsCorrected: corrected.length,
      imageToRecordMismatches: overlay.mismatches.length,
      duplicatePrintedNamesNotMerged: overlay.collisions,
      correctedExamples: corrected.slice(0, 8)
    }, null, 2));
  }
  const auditFile = path.join(path.dirname(storeFile), 'audit.json');
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  fs.writeFileSync(auditFile, JSON.stringify({ ...audit, copied, written: applied.written }, null, 2));
  return {
    ok: true,
    written: applied.written,
    copied,
    format: 'original',
    insertedPlayers: applied.insertPlayers?.length || 0,
    updatedPlayers: applied.updatePlayers?.length || 0,
    skippedPlayers: applied.skipPlayers?.length || 0,
    excluded,
    audit,
    storeFile
  };
}

export function readStoredCatalogue(file) {
  return readJson(file, null);
}
