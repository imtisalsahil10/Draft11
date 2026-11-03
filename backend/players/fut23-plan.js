/**
 * FIFA 23 PLAN
 * Builds catalogue players and card versions from the FUT csv and the master
 * workbook. Eligibility uses the same name link as the reconciliation workbook.
 * Biography that the FUT file does not provide stays null. Nothing is written.
 */

import { cardArtNameKey } from '../../shared/player-card-art.js';

const STOP = new Set([
  'de', 'da', 'do', 'dos', 'das', 'del', 'della', 'van', 'von', 'di',
  'la', 'le', 'el', 'al', 'bin', 'ibn', 'st', 'jr', 'ii', 'iii'
]);

const IMAGE_FILE = /^(fut23_[a-z0-9_]+)_(primary|card_(\d{2}))\.webp$/;
const PLAYER_ID = /^fut23_[a-z0-9_]+$/;

export class Fut23PlanError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'Fut23PlanError';
    this.code = code;
    this.details = details;
  }
}

export function fut23CardId(rowNumber) {
  const row = Number(rowNumber);
  if (!Number.isInteger(row) || row <= 0 || row > 999999) {
    throw new Fut23PlanError(`Source row ${rowNumber} cannot form a stable card id.`, 'BAD_ROW', { rowNumber });
  }
  return `fut23row_${String(row).padStart(6, '0')}`;
}

export function expectedPlayerId(normalizedName) {
  const key = String(normalizedName || '').trim();
  const id = `fut23_${key.replaceAll(' ', '_')}`;
  if (!PLAYER_ID.test(id)) {
    throw new Fut23PlanError(`Normalized name "${key}" cannot form a fut23 player id.`, 'BAD_PLAYER_ID', { normalizedName: key });
  }
  return id;
}

function text(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function rating(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0 || number > 99) return null;
  return Math.round(number);
}

function blank(value) {
  return text(value) === '';
}

export function isRepresentative(value) {
  return value === true || ['yes', 'true', '1'].includes(String(value ?? '').trim().toLowerCase());
}

export function parseFutPosition(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { position: null, alternatePositions: null };
  const parts = raw.split(/\s{2,}/);
  const position = parts[0].trim().toUpperCase();
  const alternates = parts.slice(1)
    .join(' ')
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  return {
    position: position || null,
    alternatePositions: alternates.length ? alternates : null
  };
}

function tokensOf(normalized) {
  return String(normalized || '').split(' ').filter(Boolean);
}

function usefulTokens(parts) {
  return parts.filter((part) => part.length >= 3 && !STOP.has(part));
}

/**
 * One live card can claim at most one master player. Two equally specific
 * master names claim nobody. SoFIFA ids are not used: the master left them blank.
 */
export function linkLiveCards(liveCards, masters) {
  const links = [];
  for (const card of liveCards || []) {
    const longKey = cardArtNameKey(card?.longName);
    const shortKey = cardArtNameKey(card?.name);
    const longTokens = new Set(longKey.split(' ').filter(Boolean));
    const shortTokens = new Set(shortKey.split(' ').filter(Boolean));
    const shortUseful = usefulTokens(shortKey.split(' ').filter(Boolean));
    const hits = [];
    for (const item of masters) {
      const reasons = [];
      if (item.normalizedName && item.normalizedName === shortKey) reasons.push('exact short name');
      if (item.normalizedName && item.normalizedName === longKey) reasons.push('exact long name');
      const masterTokens = tokensOf(item.normalizedName);
      const useful = usefulTokens(masterTokens);
      if (useful.length && useful.every((part) => longTokens.has(part))) {
        reasons.push('long name contains the master name');
      } else if (useful.length && useful.every((part) => shortTokens.has(part))) {
        reasons.push('short name contains the master name');
      }
      if (reasons.length) hits.push({ item, reasons, useful: useful.length });
    }
    const exact = hits.filter((hit) => hit.reasons.includes('exact short name') || hit.reasons.includes('exact long name'));
    const pool = exact.length ? exact : hits;
    let winner = null;
    let ambiguous = [];
    if (pool.length) {
      const best = Math.max(...pool.map((hit) => hit.useful));
      let winners = pool.filter((hit) => hit.useful === best);
      const exactWinners = winners.filter((hit) => (
        hit.reasons.includes('exact short name') || hit.reasons.includes('exact long name')
      ));
      if (exactWinners.length) winners = exactWinners;
      if (winners.length > 1 && shortUseful.length) {
        const narrowed = winners.filter((hit) => shortUseful.some((part) => tokensOf(hit.item.normalizedName).includes(part)));
        if (narrowed.length === 1) winners = narrowed;
      }
      if (winners.length === 1) winner = winners[0];
      else ambiguous = winners.map((hit) => hit.item);
    }
    links.push({
      cardId: card?.id == null ? null : String(card.id),
      winner,
      ambiguous
    });
  }
  return links;
}

function indexImages(imageFiles) {
  const byPlayer = new Map();
  const ignored = [];
  for (const file of imageFiles || []) {
    const name = String(file);
    const match = IMAGE_FILE.exec(name);
    if (!match) {
      ignored.push(name);
      continue;
    }
    const entry = {
      file: name,
      playerId: match[1],
      role: match[2] === 'primary' ? 'primary' : 'alternate',
      index: match[3] ? Number(match[3]) : 0
    };
    if (!byPlayer.has(entry.playerId)) byPlayer.set(entry.playerId, []);
    byPlayer.get(entry.playerId).push(entry);
  }
  for (const entries of byPlayer.values()) {
    entries.sort((left, right) => left.role.localeCompare(right.role) || left.index - right.index || left.file.localeCompare(right.file));
  }
  return { byPlayer, ignored };
}

function assignImages(playerId, cards, images = []) {
  const primaryFile = images.find((image) => image.role === 'primary' && image.playerId === playerId) || null;
  const alternates = images.filter((image) => image.role === 'alternate' && image.playerId === playerId);
  const primaryCard = cards.find((card) => card.isPrimary);
  const others = cards.filter((card) => !card.isPrimary)
    .sort((left, right) => left.sourceRowNumber - right.sourceRowNumber || left.cardId.localeCompare(right.cardId));
  const unassigned = [];
  if (primaryCard) {
    if (primaryFile) {
      primaryCard.imagePath = `/player-cards/${primaryFile.file}`;
      primaryCard.imageAssociation = 'primary-file';
    } else {
      primaryCard.imagePath = null;
      primaryCard.imageAssociation = null;
    }
  } else if (primaryFile) {
    unassigned.push(primaryFile.file);
  }
  alternates.forEach((image, index) => {
    const card = others[index];
    if (!card) {
      unassigned.push(image.file);
      return;
    }
    card.imagePath = `/player-cards/${image.file}`;
    card.imageAssociation = 'filename-order';
  });
  for (const card of cards) {
    if (card.imagePath === undefined) {
      card.imagePath = null;
      card.imageAssociation = null;
    }
  }
  return {
    hasImage: Boolean(primaryFile) || alternates.length > 0,
    unassigned
  };
}

function biographyLeftBlank(row) {
  return ['nationality', 'club_name', 'league_name', 'age', 'sofifa_id'].every((key) => blank(row?.[key]));
}

function sameIdSet(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * @param {object} input
 * @param {Array<object>} input.csvRecords data rows with rowNumber
 * @param {Array<object>} input.masterRows
 * @param {Array<object>} input.workbookCards
 * @param {Array<object>} input.liveCards
 * @param {Array<object>} [input.legacyCards]
 * @param {string[]} [input.imageFiles] filenames that exist in player-cards
 * @param {{ safeIds?: string[], reviewIds?: string[], liveMasterIds?: string[] }} [input.reconciliation]
 * @param {string|Date} [input.now]
 */
export function buildFut23Plan(input) {
  const now = new Date(input.now || Date.now());
  if (Number.isNaN(now.getTime())) {
    throw new Fut23PlanError('Import timestamp is not a valid date.', 'BAD_TIME');
  }

  const masterRows = input.masterRows || [];
  const masters = [];
  const masterById = new Map();
  const masterByName = new Map();
  for (const row of masterRows) {
    const normalizedName = text(row.name_normalized);
    const name = text(row.display_name);
    const playerId = text(row.draft11_player_id);
    if (!playerId || !normalizedName || !name) {
      throw new Fut23PlanError('A master row is missing its id, name, or normalized name.', 'BAD_MASTER', { playerId });
    }
    if (playerId !== expectedPlayerId(normalizedName)) {
      throw new Fut23PlanError(
        `${playerId} does not match normalized name "${normalizedName}".`,
        'PLAYER_ID_MISMATCH',
        { playerId, normalizedName }
      );
    }
    if (cardArtNameKey(name) !== normalizedName) {
      throw new Fut23PlanError(
        `Display name "${name}" does not normalize to "${normalizedName}".`,
        'NAME_MISMATCH',
        { playerId }
      );
    }
    if (masterById.has(playerId) || masterByName.has(normalizedName)) {
      throw new Fut23PlanError(`Duplicate master identity ${playerId}.`, 'DUPLICATE_PLAYER', { playerId });
    }
    const item = {
      playerId,
      name,
      normalizedName,
      identityStatus: text(row.identity_status),
      reviewReason: text(row.identity_review_reason),
      biographyBlank: biographyLeftBlank(row)
    };
    masters.push(item);
    masterById.set(playerId, item);
    masterByName.set(normalizedName, item);
  }

  const csvByRow = new Map();
  let futRows = 0;
  let belowOverall = 0;
  const rawNames = new Set();
  const normalizedNames = new Set();
  for (const record of input.csvRecords || []) {
    futRows += 1;
    const rowNumber = Number(record.rowNumber);
    if (!Number.isInteger(rowNumber) || rowNumber <= 0) {
      throw new Fut23PlanError('A CSV record is missing its source row number.', 'BAD_ROW');
    }
    if (csvByRow.has(rowNumber)) {
      throw new Fut23PlanError(`Duplicate CSV source row ${rowNumber}.`, 'DUPLICATE_ROW', { rowNumber });
    }
    const overall = rating(record.RAT ?? record.overall);
    if (overall == null || overall < 85) {
      belowOverall += 1;
      csvByRow.set(rowNumber, null);
      continue;
    }
    const name = text(record.Name ?? record.name);
    const normalized = cardArtNameKey(name);
    rawNames.add(name);
    normalizedNames.add(normalized);
    csvByRow.set(rowNumber, { rowNumber, name, normalized, overall, record });
  }

  const cardsByPlayer = new Map();
  const seenCardIds = new Set();
  let workbookCardCount = 0;
  for (const row of input.workbookCards || []) {
    workbookCardCount += 1;
    const rowNumber = Number(row.source_row_number);
    const playerId = text(row.draft11_player_id);
    const cardId = text(row.source_card_id);
    const master = masterById.get(playerId);
    const csv = csvByRow.get(rowNumber);
    if (!master) {
      throw new Fut23PlanError(`Card row ${rowNumber} points at an unknown player ${playerId}.`, 'UNKNOWN_PLAYER', { rowNumber, playerId });
    }
    if (!csv) {
      throw new Fut23PlanError(`Workbook card row ${rowNumber} is not an overall-85 CSV row.`, 'ROW_NOT_IN_CSV', { rowNumber, playerId });
    }
    if (csv.normalized !== master.normalizedName || text(row.name_normalized) !== master.normalizedName) {
      throw new Fut23PlanError(
        `Source row ${rowNumber} does not belong to ${playerId}.`,
        'ROW_PLAYER_MISMATCH',
        { rowNumber, playerId, csvName: csv.name }
      );
    }
    if (cardId !== fut23CardId(rowNumber)) {
      throw new Fut23PlanError(
        `Source card id ${cardId} is not the stable id for row ${rowNumber}.`,
        'CARD_ID_MISMATCH',
        { cardId, rowNumber }
      );
    }
    if (seenCardIds.has(cardId)) {
      throw new Fut23PlanError(`Duplicate card id ${cardId}.`, 'DUPLICATE_CARD', { cardId });
    }
    seenCardIds.add(cardId);
    const roles = parseFutPosition(csv.record.POS ?? csv.record.position);
    if (!roles.position) {
      throw new Fut23PlanError(`Source row ${rowNumber} has no position.`, 'MISSING_POSITION', { rowNumber, playerId });
    }
    const version = text(csv.record.VER ?? csv.record.version);
    const card = {
      cardId,
      playerId,
      source: 'fifa23-fut',
      sourceVersion: 'fifa-23',
      sourceRowNumber: rowNumber,
      sourceCardId: cardId,
      overallRating: csv.overall,
      position: roles.position,
      alternatePositions: roles.alternatePositions,
      pace: rating(csv.record.PAC),
      shooting: rating(csv.record.SHO),
      passing: rating(csv.record.PAS),
      dribbling: rating(csv.record.DRI),
      defending: rating(csv.record.DEF),
      physical: rating(csv.record.PHY),
      goalkeeperAttributes: null,
      cardType: version || null,
      isPrimary: isRepresentative(row.is_representative),
      createdAt: now,
      updatedAt: now
    };
    if (!cardsByPlayer.has(playerId)) cardsByPlayer.set(playerId, []);
    cardsByPlayer.get(playerId).push(card);
  }

  const ratedRows = [...csvByRow.values()].filter(Boolean);
  if (ratedRows.length !== workbookCardCount) {
    throw new Fut23PlanError(
      `CSV has ${ratedRows.length} rows at overall 85 and the workbook has ${workbookCardCount} card rows.`,
      'CARD_COUNT_MISMATCH',
      { csv: ratedRows.length, workbook: workbookCardCount }
    );
  }
  for (const csv of ratedRows) {
    const master = masterByName.get(csv.normalized);
    if (!master) {
      throw new Fut23PlanError(
        `CSV row ${csv.rowNumber} (${csv.name}) has no master player.`,
        'CSV_WITHOUT_MASTER',
        { rowNumber: csv.rowNumber, name: csv.name }
      );
    }
  }
  for (const master of masters) {
    const cards = cardsByPlayer.get(master.playerId) || [];
    if (!cards.length) {
      throw new Fut23PlanError(`${master.playerId} has no FUT card row.`, 'PLAYER_WITHOUT_CARD', { playerId: master.playerId });
    }
    const primary = cards.filter((card) => card.isPrimary);
    if (primary.length !== 1) {
      throw new Fut23PlanError(
        `${master.playerId} has ${primary.length} representative cards.`,
        'PRIMARY_CARD',
        { playerId: master.playerId }
      );
    }
  }

  const liveCards = input.liveCards || [];
  const links = linkLiveCards(liveCards, masters);
  const linkedIds = new Set(links.filter((link) => link.winner).map((link) => link.winner.item.playerId));
  const blocked = new Set(linkedIds);
  for (const link of links) {
    for (const item of link.ambiguous) blocked.add(item.playerId);
  }
  const unresolved = masters.filter((item) => (
    item.identityStatus === 'name_group_consistent' && blocked.has(item.playerId) && !linkedIds.has(item.playerId)
  ));
  if (unresolved.length) {
    throw new Fut23PlanError(
      `${unresolved.length} consistent players have an ambiguous live-card link and were not imported.`,
      'AMBIGUOUS_LINK',
      { playerIds: unresolved.map((item) => item.playerId) }
    );
  }

  const alreadyLive = masters.filter((item) => linkedIds.has(item.playerId));
  const excludedReview = masters.filter((item) => item.identityStatus !== 'name_group_consistent' && !linkedIds.has(item.playerId));
  const eligible = masters.filter((item) => item.identityStatus === 'name_group_consistent' && !blocked.has(item.playerId));

  const reconciliation = input.reconciliation;
  if (reconciliation) {
    const problems = [];
    if (reconciliation.safeIds && !sameIdSet(reconciliation.safeIds, eligible.map((item) => item.playerId))) {
      problems.push('safe player ids');
    }
    if (reconciliation.reviewIds && !sameIdSet(reconciliation.reviewIds, excludedReview.map((item) => item.playerId))) {
      problems.push('identity-review ids');
    }
    if (reconciliation.liveMasterIds && !sameIdSet(reconciliation.liveMasterIds, alreadyLive.map((item) => item.playerId))) {
      problems.push('already-live ids');
    }
    if (problems.length) {
      throw new Fut23PlanError(
        `The recomputed plan does not match the reconciliation workbook (${problems.join(', ')}). No records were imported.`,
        'RECONCILIATION_MISMATCH',
        { problems }
      );
    }
  }

  const liveIds = new Set(liveCards.map((card) => String(card.id)));
  const legacyCards = input.legacyCards || [];
  const legacyIds = new Set(legacyCards.map((card) => String(card.id)));
  const { byPlayer: imagesByPlayer, ignored: ignoredImages } = indexImages(input.imageFiles);
  const players = [];
  const cards = [];
  const unassignedImages = [];
  for (const master of eligible) {
    const group = cardsByPlayer.get(master.playerId)
      .slice()
      .sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
    const imageInfo = assignImages(master.playerId, group, imagesByPlayer.get(master.playerId) || []);
    unassignedImages.push(...imageInfo.unassigned);
    const primary = group.find((card) => card.isPrimary);
    players.push({
      playerId: master.playerId,
      name: master.name,
      normalizedName: master.normalizedName,
      source: 'fifa23-fut',
      sourcePlayerId: null,
      identityStatus: master.identityStatus,
      imageStatus: imageInfo.hasImage ? 'present_unapproved' : 'missing',
      primaryCardId: primary.cardId,
      nationality: null,
      club: null,
      league: null,
      age: null,
      sofifaId: null,
      createdAt: now,
      updatedAt: now
    });
    cards.push(...group);
  }

  const importedIds = new Set([...players.map((player) => player.playerId), ...cards.map((card) => card.cardId)]);
  const overlap = [...importedIds].filter((id) => liveIds.has(id) || legacyIds.has(id));
  if (overlap.length) {
    throw new Fut23PlanError(
      'An imported id collides with an existing live or legacy card id.',
      'LEGACY_OVERLAP',
      { ids: overlap }
    );
  }

  const distinctImagePlayers = new Set();
  for (const [playerId, images] of imagesByPlayer) {
    if (images.length) distinctImagePlayers.add(playerId);
  }
  const withImages = players.filter((player) => player.imageStatus === 'present_unapproved');
  const withoutImages = players.filter((player) => player.imageStatus === 'missing');
  const multipleVersions = players.filter((player) => cards.filter((card) => card.playerId === player.playerId).length > 1);
  const referenced = cards.filter((card) => card.imagePath).map((card) => card.imagePath);
  const knownFiles = new Set([...(input.imageFiles || [])].map((file) => `/player-cards/${file}`));
  const missingReferences = referenced.filter((imagePath) => !knownFiles.has(imagePath));
  if (missingReferences.length) {
    throw new Fut23PlanError('A card references an image that was not in the verified file list.', 'MISSING_IMAGE', {
      paths: missingReferences.slice(0, 20)
    });
  }

  players.sort((left, right) => left.playerId.localeCompare(right.playerId));
  cards.sort((left, right) => left.cardId.localeCompare(right.cardId));

  return {
    players,
    cards,
    excludedReview: excludedReview
      .map((item) => ({
        playerId: item.playerId,
        name: item.name,
        normalizedName: item.normalizedName,
        identityStatus: item.identityStatus,
        reviewReason: item.reviewReason || null,
        disposition: 'excluded_from_import'
      }))
      .sort((left, right) => left.playerId.localeCompare(right.playerId)),
    alreadyLive: alreadyLive
      .map((item) => {
        const link = links.find((entry) => entry.winner?.item.playerId === item.playerId);
        return {
          playerId: item.playerId,
          name: item.name,
          identityStatus: item.identityStatus,
          liveCardId: link?.cardId || null,
          disposition: 'already_in_live_catalogue'
        };
      })
      .sort((left, right) => left.playerId.localeCompare(right.playerId)),
    summary: {
      masterPlayers: masters.length,
      futRows,
      belowOverall,
      rowsAt85: ratedRows.length,
      rawNamesAt85: rawNames.size,
      normalizedNamesAt85: normalizedNames.size,
      liveCards: liveCards.length,
      legacyCards: legacyCards.length,
      alreadyLive: alreadyLive.length,
      eligiblePlayers: players.length,
      excludedReview: excludedReview.length,
      unresolvedLinks: unresolved.length,
      importedCards: cards.length,
      extraCardVersions: cards.length - players.length,
      masterExtraCardVersions: workbookCardCount - masters.length,
      playersWithImages: withImages.length,
      playersWithoutImages: withoutImages.length,
      playersWithMultipleVersions: multipleVersions.length,
      distinctImagePlayers: distinctImagePlayers.size,
      imageFiles: (input.imageFiles || []).length,
      ignoredImageFiles: ignoredImages.length,
      referencedImages: referenced.length,
      unassignedImages: unassignedImages.length,
      unassignedImageFiles: unassignedImages,
      liveCardsUnlinked: links.filter((link) => !link.winner && !link.ambiguous.length).length,
      biographyBlankOnMaster: masters.every((item) => item.biographyBlank),
      preservedLiveIds: liveCards.length,
      preservedLegacyIds: legacyCards.length
    }
  };
}
