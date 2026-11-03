/**
 * IMAGE CATALOGUE
 * Turns per-card readings into one player per distinct footballer. The
 * readings come from the card images. This module does not open the FIFA
 * workbook, does not fill a null from another card, and does not write to
 * MongoDB.
 */

import { MIN_OVERALL, LEAGUE_NAMES } from './fifa-import.js';

export { MIN_OVERALL };

export const SUPPORTED_LEAGUES = new Set(Object.values(LEAGUE_NAMES));

export const AUCTION_PRICES = {
  LEGENDARY: 25,
  RARE: 15,
  BASIC: 10
};

const ROLES = new Set([
  'GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM',
  'LM', 'RM', 'LW', 'RW', 'CF', 'ST'
]);

const STAT_LABELS = {
  PAC: 'pace',
  SHO: 'shooting',
  PAS: 'passing',
  DRI: 'dribbling',
  DEF: 'defending',
  PHY: 'physical'
};

const KEEPER_LABELS = {
  DIV: 'diving',
  HAN: 'handling',
  KIC: 'kicking',
  REF: 'reflexes',
  SPE: 'speed',
  SPD: 'speed',
  POS: 'positioning'
};

const LEAGUE_TEXT = [
  [/premier league/, 'Premier League'],
  [/la ?liga/, 'La Liga'],
  [/serie a/, 'Serie A'],
  [/bundesliga/, 'Bundesliga'],
  [/ligue 1/, 'Ligue 1'],
  [/eredivisie/, 'Eredivisie'],
  [/liga portugal|primeira liga/, 'Liga Portugal'],
  [/super lig/, 'Super Lig'],
  [/mls\b/, 'MLS'],
  [/championship/, 'Championship'],
  [/saudi pro league|pro league/, 'Saudi Pro League']
];

const CARD_TYPES = [
  'RULEBREAKERS', 'SHOWDOWN', 'FLASHBACK', 'SHAPESHIFTERS',
  'FUT BIRTHDAY', 'MOMENTS', 'HERO', 'ICON', 'TOTY', 'TOTS', 'TOTW', 'POTM'
];

const SPECIAL = {
  ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', ð: 'd', Ð: 'd',
  þ: 'th', Þ: 'th', ß: 'ss', ı: 'i', ŋ: 'n', Ŋ: 'n'
};

export function normalizeName(value) {
  if (value == null) return '';
  let text = String(value).trim();
  if (!text) return '';
  text = text.replace(/[øØæÆœŒłŁđĐðÐþÞßıŋŊ]/g, (ch) => SPECIAL[ch] ?? ch);
  text = text.normalize('NFD').replace(/\p{M}+/gu, '');
  text = text.replace(/['’‘ʼ`]/g, '');
  text = text.toLowerCase();
  text = text.replace(/[^a-z0-9]+/g, ' ');
  return text.trim().replace(/\s+/g, ' ');
}

export function playerIdFor(name) {
  const key = normalizeName(name);
  if (!key) return null;
  const id = `fut23_${key.replaceAll(' ', '_')}`;
  return /^fut23_[a-z0-9_]+$/.test(id) ? id : null;
}

function cleanName(raw) {
  const text = String(raw || '')
    .toUpperCase()
    .replace(/[^A-ZÆØÅÄÖÜÉÈÁÍÓÚÂÊÎÔÛÇÑ .'’-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 3 || text.length > 32) return null;
  const tokens = text.split(' ').filter((token) => token.length > 1 || token === 'I');
  if (!tokens.length) return null;
  if (tokens.every((token) => ROLES.has(token))) return null;
  const titled = tokens.map((token) => token.charAt(0) + token.slice(1).toLowerCase()).join(' ');
  return normalizeName(titled) ? titled : null;
}

function ratingToken(value) {
  if (!/^\d{1,2}$/.test(value)) return null;
  const number = Number(value);
  if (number < 1 || number > 99) return null;
  return number;
}

function parseStats(text) {
  const tokens = String(text || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const joined = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const pair = `${tokens[index]}${tokens[index + 1] || ''}`;
    const triple = `${tokens[index]}${tokens[index + 1] || ''}${tokens[index + 2] || ''}`;
    if (STAT_LABELS[triple] || KEEPER_LABELS[triple]) {
      joined.push(triple);
      index += 2;
    } else if (STAT_LABELS[pair] || KEEPER_LABELS[pair]) {
      joined.push(pair);
      index += 1;
    } else {
      joined.push(tokens[index]);
    }
  }
  const outfield = {};
  const keeper = {};
  for (let index = 1; index < joined.length; index += 1) {
    const number = ratingToken(joined[index - 1]);
    if (number == null) continue;
    if (STAT_LABELS[joined[index]] && outfield[STAT_LABELS[joined[index]]] == null) {
      outfield[STAT_LABELS[joined[index]]] = number;
    }
    if (KEEPER_LABELS[joined[index]] && keeper[KEEPER_LABELS[joined[index]]] == null) {
      keeper[KEEPER_LABELS[joined[index]]] = number;
    }
  }
  return { outfield, keeper };
}

function leagueFromText(text) {
  const haystack = String(text || '').toLowerCase();
  for (const [pattern, name] of LEAGUE_TEXT) {
    if (pattern.test(haystack)) return name;
  }
  return null;
}

function cardTypeFromText(text) {
  const haystack = String(text || '').toUpperCase();
  return CARD_TYPES.find((type) => haystack.includes(type)) || null;
}

function firstOcrLine(text) {
  const line = String(text || '').split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  return line || null;
}

function filledCount(card) {
  const values = [
    card.name, card.overall, card.position, card.nationality, card.club, card.league, card.cardType,
    card.pace, card.shooting, card.passing, card.dribbling, card.defending, card.physical
  ];
  let count = values.filter((value) => value != null && value !== '').length;
  if (card.alternatePositions?.length) count += 1;
  if (card.goalkeeperAttributes && Object.keys(card.goalkeeperAttributes).length) count += 1;
  return count;
}

export function applyOcr(reading, nameText, statsText) {
  const rawOcr = [nameText, statsText].filter(Boolean).join('\n');
  const name = cleanName(nameText);
  const { outfield, keeper } = parseStats(statsText);
  const keeperCount = Object.keys(keeper).length;
  const outfieldCount = Object.keys(outfield).length;
  const useKeeper = reading.position === 'GK' || keeperCount > outfieldCount;
  const card = {
    sourceImage: reading.sourceImage,
    sourcePath: reading.sourcePath,
    sourceImageHash: reading.sourceImageHash,
    width: reading.width,
    height: reading.height,
    bytes: reading.bytes,
    name,
    overall: reading.overall ?? null,
    position: ROLES.has(reading.position) ? reading.position : null,
    alternatePositions: (reading.alternatePositions || []).filter((role) => ROLES.has(role)),
    nationality: null,
    club: null,
    league: leagueFromText(rawOcr),
    cardType: cardTypeFromText(rawOcr),
    pace: null,
    shooting: null,
    passing: null,
    dribbling: null,
    defending: null,
    physical: null,
    goalkeeperAttributes: null,
    flagSignature: reading.flagSignature || null,
    ocrName: firstOcrLine(nameText),
    rawOcr,
    overallDistance: reading.overallDistance ?? null,
    positionDistance: reading.positionDistance ?? null
  };
  if (useKeeper) {
    card.goalkeeperAttributes = keeperCount ? keeper : null;
  } else {
    Object.assign(card, outfield);
  }
  const expected = useKeeper ? 9 : 9;
  const present = [
    card.name, card.overall, card.position,
    ...(useKeeper
      ? ['diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning'].map((key) => keeper[key])
      : [card.pace, card.shooting, card.passing, card.dribbling, card.defending, card.physical])
  ].filter((value) => value != null).length;
  card.extractionConfidence = Math.round((present / expected) * 100) / 100;
  card.readableFields = filledCount(card);
  return card;
}

function levenshtein(left, right) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[left.length][right.length];
}

export function namesAreSimilar(left, right) {
  if (!left || !right || left === right) return false;
  if (levenshtein(left, right) <= 2 && Math.min(left.length, right.length) >= 5) return true;
  const leftTokens = left.split(' ');
  const rightTokens = right.split(' ');
  const [shorter, longer] = leftTokens.length <= rightTokens.length
    ? [leftTokens, rightTokens]
    : [rightTokens, leftTokens];
  if (shorter.length >= longer.length) return false;
  const longerSet = new Set(longer);
  if (!shorter.every((token) => longerSet.has(token))) return false;
  if (shorter.length >= 2) return true;
  return shorter[0].length >= 5;
}

function compareCards(left, right) {
  const rating = (right.overall ?? -1) - (left.overall ?? -1);
  if (rating) return rating;
  const confidence = (right.extractionConfidence || 0) - (left.extractionConfidence || 0);
  if (confidence) return confidence;
  const pixels = (right.width * right.height) - (left.width * left.height);
  if (pixels) return pixels;
  const bytes = (right.bytes || 0) - (left.bytes || 0);
  if (bytes) return bytes;
  return left.sourceImage.localeCompare(right.sourceImage);
}

function selectionReason(card, cards) {
  if (card.overall == null) {
    return 'No version has a readable overall. This card has the higher OCR confidence, then the sharper image.';
  }
  const sameRating = cards.filter((item) => item.overall === card.overall);
  if (sameRating.length === 1) return `Highest overall rating (${card.overall}).`;
  const sameConfidence = sameRating.filter((item) => (item.extractionConfidence || 0) === (card.extractionConfidence || 0));
  if (sameConfidence.length === 1) return `Tied on ${card.overall}. This card has higher OCR confidence.`;
  const samePixels = sameConfidence.filter((item) => item.width * item.height === card.width * card.height);
  if (samePixels.length === 1) return `Tied on ${card.overall} and OCR confidence. This image has more pixels.`;
  const sameBytes = samePixels.filter((item) => (item.bytes || 0) === (card.bytes || 0));
  if (sameBytes.length === 1) return `Tied on ${card.overall}, OCR confidence, and pixel size. This file is larger.`;
  return `Tied on ${card.overall}, OCR confidence, and image quality. Filename order selected ${card.sourceImage}.`;
}

function leagueStatusFor(league) {
  if (!league) return 'unknown';
  if (SUPPORTED_LEAGUES.has(league)) return 'verified';
  return 'needs_review';
}

function missingAttributeKeys(record) {
  if (record.position === 'GK' || record.goalkeeperAttributes) {
    const keeper = record.goalkeeperAttributes || {};
    return ['diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning']
      .filter((key) => keeper[key] == null);
  }
  return ['pace', 'shooting', 'passing', 'dribbling', 'defending', 'physical']
    .filter((key) => record[key] == null);
}

function uncertainOcr(record) {
  if (record.overall == null || (record.extractionConfidence || 0) < 0.7) return true;
  return /[0-9]/.test(record.ocrName || '');
}

function rejectionReason(card) {
  if (!card.name && card.overall == null) return 'Unreadable card. The name and the overall rating could not be read.';
  if (card.overall != null && card.overall < MIN_OVERALL) return `Overall ${card.overall} is below ${MIN_OVERALL}.`;
  if (card.league && !SUPPORTED_LEAGUES.has(card.league)) return `League "${card.league}" is outside the five supported leagues.`;
  if (!card.league) return 'The league is not printed on the card, so it was not assigned.';
  if (!card.position) return 'The position could not be read.';
  return 'Held for review.';
}

function priceFinal(players) {
  const ordered = [...players].sort((left, right) => (
    right.overall - left.overall || left.playerId.localeCompare(right.playerId)
  ));
  ordered.forEach((player, index) => {
    const percentile = ordered.length > 0 ? index / ordered.length : 1;
    const category = percentile < 0.10 ? 'LEGENDARY' : percentile < 0.40 ? 'RARE' : 'BASIC';
    player.category = category;
    player.basePrice = AUCTION_PRICES[category];
  });
  return ordered;
}

/**
 * @param {object[]} cards OCR-merged card readings
 */
export function buildImageCatalogue(cards) {
  const input = [...(cards || [])].sort((left, right) => left.sourceImage.localeCompare(right.sourceImage) || left.sourcePath.localeCompare(right.sourcePath));
  const junk = [];
  const usable = [];
  for (const card of input) {
    if (!card.name && card.overall == null) junk.push({ ...card, junk: true, reason: rejectionReason(card) });
    else usable.push(card);
  }

  const byName = new Map();
  for (const card of usable) {
    const key = card.name ? normalizeName(card.name) : '';
    if (!key) {
      junk.push({ ...card, junk: true, reason: 'The name could not be normalised from the card text.' });
      continue;
    }
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(card);
  }

  const names = [...byName.keys()].sort();
  const similarTo = new Map();
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      if (!namesAreSimilar(names[i], names[j])) continue;
      if (!similarTo.has(names[i])) similarTo.set(names[i], []);
      if (!similarTo.has(names[j])) similarTo.set(names[j], []);
      similarTo.get(names[i]).push(names[j]);
      similarTo.get(names[j]).push(names[i]);
    }
  }

  const identities = [];
  const review = [];
  for (const name of names) {
    const group = byName.get(name);
    const playerId = playerIdFor(group.find((card) => card.name)?.name || name);
    const ambiguous = similarTo.has(name) || !playerId;
    const reasons = [];
    if (similarTo.has(name)) reasons.push(`Similar card name kept separate: ${similarTo.get(name).join(', ')}.`);
    if (!playerId) reasons.push('The card name cannot form a stable player id.');
    identities.push({ name, playerId, cards: group, ambiguous, reasons });
  }

  const selected = [];
  const alternatives = [];
  for (const identity of identities) {
    const ranked = [...identity.cards].sort(compareCards);
    const chosen = ranked[0];
    const reason = selectionReason(chosen, identity.cards);
    selected.push({ ...chosen, playerId: identity.playerId, identityName: identity.name, ambiguous: identity.ambiguous, identityReasons: identity.reasons, selectionReason: reason });
    ranked.slice(1).forEach((card) => {
      alternatives.push({
        ...card,
        playerId: identity.playerId,
        identityName: identity.name,
        reasonNotSelected: card.overall == null
          ? 'A higher-rated readable card was selected. This version has no readable overall.'
          : card.overall < (chosen.overall ?? -1)
            ? `Not selected. Overall ${card.overall} is below the selected ${chosen.overall}.`
            : `Not selected. ${reason}`
      });
    });
  }

  const records = [];
  const excluded = junk.map((card) => ({ ...card, catalogueStatus: 'rejected' }));
  const reviewReports = {
    uncertainOcr: [],
    similarNames: [],
    missingPositions: [],
    unknownLeagues: [],
    missingAttributes: [],
    conflictingIdentities: []
  };
  for (const card of selected) {
    const record = {
      playerId: card.playerId,
      name: card.name,
      ocrName: card.ocrName || firstOcrLine(card.rawOcr),
      overall: card.overall,
      position: card.position,
      alternatePositions: card.alternatePositions?.length ? card.alternatePositions : [],
      nationality: card.nationality,
      club: card.club,
      league: card.league,
      leagueStatus: leagueStatusFor(card.league),
      pace: card.pace,
      shooting: card.shooting,
      passing: card.passing,
      dribbling: card.dribbling,
      defending: card.defending,
      physical: card.physical,
      goalkeeperAttributes: card.goalkeeperAttributes,
      cardType: card.cardType,
      imagePath: publicImagePath(card),
      sourceImage: card.sourceImage,
      sourceImageHash: card.sourceImageHash,
      sourcePath: card.sourcePath,
      extractionConfidence: card.extractionConfidence,
      identityConfidence: card.ambiguous ? 0.35 : card.name && card.name.includes(' ') ? 0.9 : 0.7,
      imageRightsStatus: 'unverified',
      cardArtApproved: false,
      auctionEligible: false,
      isVerified: false,
      rawOcr: card.rawOcr,
      selectionReason: card.selectionReason,
      width: card.width,
      height: card.height
    };
    const reviewReasons = [];
    if (card.ambiguous) reviewReasons.push(...(card.identityReasons || []));
    if (!record.playerId) reviewReasons.push('The card name cannot form a stable player id.');
    if (uncertainOcr(record)) reviewReasons.push('The OCR name or rating is uncertain and was not corrected.');
    if (!record.position) reviewReasons.push('The position could not be read.');
    const missingAttributes = missingAttributeKeys(record);
    if (missingAttributes.length) reviewReasons.push(`Unread attributes: ${missingAttributes.join(', ')}.`);
    if (record.league && !SUPPORTED_LEAGUES.has(record.league)) {
      reviewReasons.push(`League "${record.league}" is outside the five supported leagues.`);
    }
    record.reviewReasons = reviewReasons;
    record.catalogueStatus = reviewReasons.length ? 'needs_review' : 'identified';
    record.isVerified = record.catalogueStatus === 'identified';
    record.futureAuctionEligible = record.catalogueStatus === 'identified'
      && record.overall != null
      && record.overall >= MIN_OVERALL
      && Boolean(record.position)
      && record.leagueStatus === 'verified';
    records.push(record);

    const pointer = {
      playerId: record.playerId,
      name: record.name,
      ocrName: record.ocrName,
      overall: record.overall,
      position: record.position,
      league: record.league,
      leagueStatus: record.leagueStatus,
      sourceImage: record.sourceImage,
      sourcePath: record.sourcePath,
      extractionConfidence: record.extractionConfidence,
      identityConfidence: record.identityConfidence
    };
    if (uncertainOcr(record)) reviewReports.uncertainOcr.push({ ...pointer, reason: 'Uncertain OCR. The name was not corrected.' });
    if (card.ambiguous) {
      const similarReason = (card.identityReasons || []).join(' ');
      reviewReports.similarNames.push({ ...pointer, reason: similarReason });
      reviewReports.conflictingIdentities.push({ ...pointer, reason: similarReason });
    }
    if (!record.position) reviewReports.missingPositions.push({ ...pointer, reason: 'The position could not be read.' });
    if (record.leagueStatus === 'unknown') reviewReports.unknownLeagues.push({ ...pointer, reason: 'The league is not printed on the card.' });
    if (missingAttributes.length) reviewReports.missingAttributes.push({ ...pointer, reason: `Unread attributes: ${missingAttributes.join(', ')}.` });
    if (record.catalogueStatus === 'needs_review') {
      review.push({ ...record, reason: reviewReasons.join(' ') });
    }
  }

  const auctionCandidates = priceFinal(records.filter((record) => record.futureAuctionEligible));
  const summary = {
    imagesScanned: input.length,
    uniqueIdentities: identities.length,
    identitiesRetained: records.length,
    validCards: usable.length,
    belowOverall: records.filter((record) => record.overall != null && record.overall < MIN_OVERALL).length,
    cardsBelowOverall: input.filter((card) => card.overall != null && card.overall < MIN_OVERALL).length,
    excludedByLeague: records.filter((record) => record.league && !SUPPORTED_LEAGUES.has(record.league)).length,
    selectedCards: selected.length,
    alternativeCards: alternatives.length,
    ambiguousIdentities: identities.filter((identity) => identity.ambiguous).length,
    unreadableCards: junk.length,
    manualReview: review.length,
    identityReview: review.length,
    finalPlayers: records.length,
    auctionCandidates: auctionCandidates.length,
    futureAuctionImport: auctionCandidates.length,
    passedOverall: records.filter((record) => record.overall != null && record.overall >= MIN_OVERALL).length,
    cardsAtLeast85: input.filter((card) => card.overall != null && card.overall >= MIN_OVERALL).length,
    readablePositions: records.filter((record) => record.position).length,
    unknownLeagues: records.filter((record) => record.leagueStatus === 'unknown').length,
    verifiedLeagues: records.filter((record) => record.leagueStatus === 'verified').length,
    passedLeague: records.filter((record) => record.leagueStatus === 'verified').length,
    selectedLocalImages: records.filter((record) => record.sourceImage && record.sourcePath).length,
    publicLocalImages: records.filter((record) => record.imagePath).length,
    junkCards: junk.length,
    liveAuctionActivated: false
  };

  return {
    summary,
    players: records,
    records,
    auctionCandidates,
    selected,
    alternatives,
    review,
    reviewReports,
    excluded,
    junk
  };
}

export function publicImagePath(card) {
  const source = String(card?.sourcePath || '').replaceAll('\\', '/');
  const match = source.match(/\/player-cards\/(fut23_[a-z0-9_]+_(?:primary|card_\d{2})\.webp)$/i);
  if (!match) return null;
  return `/player-cards/${match[1]}`;
}

export function presentImageCataloguePlayer(player) {
  if (!player || typeof player !== 'object') return null;
  const imagePath = publicImagePath(player);
  return {
    playerId: player.playerId,
    name: player.name,
    overall: player.overall,
    position: player.position,
    alternatePositions: player.alternatePositions || [],
    nationality: player.nationality ?? null,
    club: player.club ?? null,
    league: player.league ?? null,
    leagueStatus: player.leagueStatus || (
      !player.league ? 'unknown' : SUPPORTED_LEAGUES.has(player.league) ? 'verified' : 'needs_review'
    ),
    catalogueStatus: player.catalogueStatus || null,
    category: AUCTION_PRICES[player.category] ? player.category : null,
    basePrice: AUCTION_PRICES[player.category] ? player.basePrice : null,
    imagePath,
    cardArtApproved: false,
    cardArtApprovalStatus: 'not_reviewed',
    cardArtRightsStatus: 'unverified',
    imageRightsStatus: 'unverified',
    auctionEligible: false,
    futureAuctionEligible: false,
    remoteImage: false
  };
}
