/**
 * FIFA CSV IMPORT
 * Builds Draft11 cards from the local SoFIFA export. Identity is sofifa_id.
 * The card id is fifa_<sofifa_id> and does not change between imports.
 * Overall ratings below 85 and leagues outside the five mapped competitions
 * are left out. Missing ratings stay missing. Zero is not treated as a rating.
 */

import { rowsToObjects } from './csv.js';

export const MIN_OVERALL = 85;

export const LEAGUE_NAMES = {
  'English Premier League': 'Premier League',
  'Spain Primera Division': 'La Liga',
  'Italian Serie A': 'Serie A',
  'German 1. Bundesliga': 'Bundesliga',
  'French Ligue 1': 'Ligue 1'
};

const REQUIRED_COLUMNS = [
  'sofifa_id',
  'short_name',
  'nationality',
  'club_name',
  'league_name',
  'overall',
  'player_positions',
  'pace',
  'shooting',
  'passing',
  'dribbling',
  'defending',
  'physic',
  'gk_diving',
  'gk_handling',
  'gk_kicking',
  'gk_reflexes',
  'gk_speed',
  'gk_positioning'
];

const ROLES = new Set([
  'GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'
]);

const OUTFIELD_STATS = [
  ['pace', 'pace'],
  ['shooting', 'shooting'],
  ['passing', 'passing'],
  ['dribbling', 'dribbling'],
  ['defending', 'defense'],
  ['physic', 'physical']
];

const GOALKEEPING_STATS = [
  ['gk_diving', 'diving'],
  ['gk_handling', 'handling'],
  ['gk_kicking', 'kicking'],
  ['gk_reflexes', 'reflexes'],
  ['gk_speed', 'speed'],
  ['gk_positioning', 'positioning']
];

const CATEGORY_PRICE = {
  LEGENDARY: 25,
  RARE: 15,
  BASIC: 10
};

export class FifaImportError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'FifaImportError';
    this.code = code;
    this.details = details;
  }
}

function rating(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0 || number > 99) return null;
  return Math.round(number);
}

function integer(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isInteger(number) || number <= 0) return null;
  return number;
}

function clean(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function datasetVersion(records) {
  const versions = new Set();
  for (const record of records) {
    const url = String(record.player_url || '');
    const match = url.match(/\/(\d+)\s*$/);
    if (match) versions.add(match[1]);
  }
  if (versions.size === 1) return `sofifa-${[...versions][0]}`;
  return 'fifa-csv';
}

function positionsOf(value) {
  const tokens = String(value || '')
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
  const roles = [];
  for (const token of tokens) {
    if (!ROLES.has(token)) {
      throw new FifaImportError(
        `Position "${token}" is not a Draft11 role.`,
        'BAD_POSITION',
        { position: token }
      );
    }
    if (!roles.includes(token)) roles.push(token);
  }
  if (!roles.length) return null;
  return {
    position: roles.length === 1 ? roles[0] : `${roles[0]}  ${roles.slice(1).join(',')}`,
    alternatePositions: roles.slice(1)
  };
}

function categoryFor(index, total) {
  const percentile = total > 0 ? index / total : 1;
  if (percentile < 0.10) return 'LEGENDARY';
  if (percentile < 0.40) return 'RARE';
  return 'BASIC';
}

function cardId(sofifaId) {
  return `fifa_${sofifaId}`;
}

/**
 * @param {string} csvText
 * @param {{ importedAt?: string, approvals?: number[], imageFor?: (id: number) => string|null }} [options]
 */
export function importFifaCsv(csvText, options = {}) {
  const { headers, records } = rowsToObjects(csvText);
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length) {
    throw new FifaImportError(
      `The FIFA CSV is missing required columns: ${missing.join(', ')}.`,
      'MISSING_COLUMNS',
      { columns: missing }
    );
  }

  const importedAt = options.importedAt || new Date().toISOString();
  const version = datasetVersion(records);
  const approvals = new Set((options.approvals || []).map((id) => Number(id)));
  const imageFor = typeof options.imageFor === 'function' ? options.imageFor : () => null;
  const seen = new Map();
  const excluded = {};
  let belowOverall = 0;
  const pending = [];

  for (const record of records) {
    const overall = rating(record.overall);
    if (overall == null || overall < MIN_OVERALL) {
      belowOverall += 1;
      continue;
    }
    const league = LEAGUE_NAMES[clean(record.league_name)];
    if (!league) {
      const rawLeague = clean(record.league_name) || '(blank)';
      excluded[rawLeague] = (excluded[rawLeague] || 0) + 1;
      continue;
    }
    const sofifaId = integer(record.sofifa_id);
    if (!sofifaId) {
      throw new FifaImportError(
        'A player rated 85 or higher is missing a numeric sofifa_id.',
        'MISSING_ID',
        { name: clean(record.short_name) }
      );
    }
    if (seen.has(sofifaId)) {
      throw new FifaImportError(
        `Duplicate sofifa_id ${sofifaId}.`,
        'DUPLICATE_ID',
        { sofifaId, name: clean(record.short_name) }
      );
    }
    const name = clean(record.short_name);
    if (!name) {
      throw new FifaImportError(
        `sofifa_id ${sofifaId} has no player name.`,
        'MISSING_NAME',
        { sofifaId }
      );
    }
    const roles = positionsOf(record.player_positions);
    if (!roles) {
      throw new FifaImportError(
        `${name} has no position.`,
        'MISSING_POSITION',
        { sofifaId }
      );
    }

    const stats = { overall };
    for (const [column, key] of OUTFIELD_STATS) {
      const value = rating(record[column]);
      if (value != null) stats[key] = value;
    }
    const goalkeeping = {};
    if (roles.position.startsWith('GK')) {
      for (const [column, key] of GOALKEEPING_STATS) {
        const value = rating(record[column]);
        if (value != null) goalkeeping[key] = value;
      }
    }

    const photoRef = imageFor(sofifaId);
    const photoApproved = Boolean(photoRef) && approvals.has(sofifaId);
    const card = {
      id: cardId(sofifaId),
      name,
      position: roles.position,
      nationality: clean(record.nationality) || 'Unknown',
      club: clean(record.club_name) || 'Unknown',
      league,
      stats,
      category: 'BASIC',
      basePrice: CATEGORY_PRICE.BASIC,
      source: {
        dataset: 'fifa',
        version,
        sofifaId,
        importedAt
      }
    };
    const longName = clean(record.long_name);
    if (longName && longName !== name) card.longName = longName;
    const age = integer(record.age);
    if (age != null) card.age = age;
    const potential = rating(record.potential);
    if (potential != null) card.potential = potential;
    if (roles.alternatePositions.length) card.alternatePositions = roles.alternatePositions;
    if (Object.keys(goalkeeping).length) card.goalkeeping = goalkeeping;
    if (photoRef) {
      card.photoRef = photoRef;
      card.photoApproved = photoApproved;
    }
    seen.set(sofifaId, card);
    pending.push(card);
  }

  pending.sort((left, right) => (
    right.stats.overall - left.stats.overall || left.source.sofifaId - right.source.sofifaId
  ));
  pending.forEach((card, index) => {
    card.category = categoryFor(index, pending.length);
    card.basePrice = CATEGORY_PRICE[card.category];
  });

  const byLeague = {};
  for (const card of pending) byLeague[card.league] = (byLeague[card.league] || 0) + 1;
  const localFiles = pending.filter((card) => card.photoRef).length;
  const approved = pending.filter((card) => card.photoApproved === true).length;
  const ids = pending.map((card) => card.id);
  if (new Set(ids).size !== ids.length) {
    throw new FifaImportError('The import produced duplicate Draft11 card ids.', 'DUPLICATE_CARD');
  }

  return {
    cards: pending,
    report: {
      ok: true,
      dataset: 'fifa',
      version,
      importedAt,
      rowsRead: records.length,
      belowOverall,
      imported: pending.length,
      byLeague,
      excludedLeagues: excluded,
      ids,
      images: {
        localFiles,
        approved,
        silhouettes: pending.length - approved,
        approvalPending: approved === 0
      }
    }
  };
}
