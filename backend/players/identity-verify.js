/**
 * IDENTITY VERIFICATION
 * Proposes canonical identities for the image-derived catalogue.
 * Original player IDs and extracted values are copied through and never replaced.
 * This module does not read MongoDB and does not change auction eligibility.
 */

import { namesAreSimilar, normalizeName, playerIdFor } from './image-catalogue.js';

export const REFERENCE_DATE = '2022-09-30';
export const WIKIDATA_SOURCE = 'https://query.wikidata.org/sparql';

const PARTICLES = new Set(['da', 'de', 'del', 'der', 'di', 'do', 'dos', 'du', 'la', 'le', 'van', 'von', 'bin', 'al']);
const STEM = /fut23_([a-z0-9_]+)_(?:primary|card_\d{2})\.webp$/i;
const NATIONAL_SIDE = /national|olympic|youth|under[-\s]?\d+|reserves?\b|\bu-?\d{2}\b|\bamateurs?\b/i;

const POSITION_FAMILY = {
  GK: 'goalkeeper',
  CB: 'defender', LB: 'defender', RB: 'defender', LWB: 'defender', RWB: 'defender',
  CDM: 'midfielder', CM: 'midfielder', CAM: 'midfielder', LM: 'midfielder', RM: 'midfielder',
  LW: 'forward', RW: 'forward', CF: 'forward', ST: 'forward'
};

export function filenameTokens(sourceImage) {
  const match = String(sourceImage || '').match(STEM);
  if (!match) return null;
  return match[1].toLowerCase().split('_').filter(Boolean);
}

export function displayNameFromTokens(tokens) {
  return tokens.map((token, index) => {
    if (index > 0 && PARTICLES.has(token)) return token;
    return token.charAt(0).toUpperCase() + token.slice(1);
  }).join(' ');
}

export function evidenceField(value, status, source, confidence, evidence, sourceDate = REFERENCE_DATE) {
  return {
    value: value ?? null,
    status,
    source: source ?? null,
    sourceDate: source ? sourceDate : null,
    confidence: confidence ?? null,
    evidence: evidence ?? null
  };
}

function unknownField(evidence) {
  return evidenceField(null, 'unknown', null, null, evidence, null);
}

function wikiFamily(label) {
  const text = String(label || '').toLowerCase();
  if (/goalkeeper|goalie/.test(text)) return 'goalkeeper';
  if (/wing-back|full-back|fullback|centre-back|center-back|defender/.test(text)) return 'defender';
  if (/midfield/.test(text)) return 'midfielder';
  if (/forward|striker|winger/.test(text)) return 'forward';
  return null;
}

function spellingIssue(player) {
  const raw = `${player.ocrName || ''} ${player.name || ''}`;
  if (/\d/.test(raw)) return 'The OCR text contains a digit.';
  if (/(.)\1\1/i.test(player.name || '')) return 'The extracted name repeats a character three times.';
  const tokens = normalizeName(player.name).split(' ').filter(Boolean);
  if (tokens.some((token) => token.length >= 5 && !/[aeiouy]/.test(token))) {
    return 'A name token has no vowel.';
  }
  return null;
}

function clubOverlaps(membership) {
  const reference = Date.parse(`${REFERENCE_DATE}T00:00:00Z`);
  const start = membership.start ? Date.parse(membership.start) : null;
  const end = membership.end ? Date.parse(membership.end) : null;
  if (start == null && end == null) return false;
  if (start != null && start > reference) return false;
  if (end != null && end <= reference) return false;
  return true;
}

function seniorClubs(memberships) {
  return (memberships || []).filter((membership) => {
    if (!membership?.club || NATIONAL_SIDE.test(membership.club)) return false;
    return clubOverlaps(membership);
  });
}

function artworkEvidence() {
  return {
    flag: evidenceField(
      null,
      'unknown',
      null,
      0,
      'The flag crop on these cards includes the card background, so it was not used as a nationality.',
      null
    ),
    clubBadge: evidenceField(
      null,
      'unknown',
      null,
      0,
      'No reference crest set was matched. An uncertain badge was not turned into a club.',
      null
    )
  };
}

function localProposal(player) {
  const normalizedName = normalizeName(player.name);
  const ocrTokens = normalizedName.split(' ').filter(Boolean);
  const stem = filenameTokens(player.sourceImage);
  const agrees = Boolean(stem && ocrTokens.length && ocrTokens.every((token) => stem.includes(token)));
  const proposedTokens = agrees ? stem : (ocrTokens.length > 1 ? ocrTokens : null);
  const proposedCanonicalName = proposedTokens ? displayNameFromTokens(proposedTokens) : null;
  return {
    normalizedName,
    ocrTokens,
    stem,
    filenameAgrees: agrees,
    proposedCanonicalName,
    lookupKey: proposedCanonicalName ? normalizeName(proposedCanonicalName) : null
  };
}

function duplicatePairs(players) {
  const pairs = [];
  const names = players.map((player) => ({
    player,
    key: normalizeName(player.name)
  })).filter((item) => item.key);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      if (!namesAreSimilar(names[i].key, names[j].key)) continue;
      const [left, right] = [names[i].player, names[j].player]
        .sort((a, b) => a.playerId.localeCompare(b.playerId));
      pairs.push({
        playerId: left.playerId,
        otherPlayerId: right.playerId,
        extractedName: left.name,
        otherExtractedName: right.name,
        suggestedMatch: null,
        supportingEvidence: 'The card names are similar. Similarity alone is not enough to merge them.',
        reviewDecision: 'unresolved'
      });
    }
  }
  return pairs;
}

function enrichFromWiki(proposal, wiki, cardPosition) {
  const empty = {
    fullName: unknownField('No unique Wikidata footballer was accepted for this record.'),
    nationality: unknownField('Nationality was not verified.'),
    club: unknownField(`No single senior club membership covers ${REFERENCE_DATE}.`),
    league: unknownField('Wikidata has no dated 2022-23 league membership for this record. The current league was not copied.'),
    position: unknownField('The card position was left as originally extracted.'),
    aliases: unknownField('No alias list was accepted.')
  };
  if (!wiki || wiki.matchCount !== 1) {
    if (wiki && wiki.matchCount > 1) {
      empty.fullName = evidenceField(
        null,
        'conflicting_sources',
        WIKIDATA_SOURCE,
        0.2,
        `${wiki.matchCount} Wikidata footballers share this exact name. None was selected.`
      );
    }
    return empty;
  }
  const label = wiki.labels?.[0] || proposal.proposedCanonicalName;
  empty.fullName = evidenceField(
    label,
    'high_confidence',
    WIKIDATA_SOURCE,
    0.8,
    'Exact English Wikidata label for one association football player. Not written over the OCR name.'
  );
  const citizenships = [...new Set(wiki.citizenships || [])];
  if (citizenships.length === 1) {
    empty.nationality = evidenceField(
      citizenships[0],
      'high_confidence',
      WIKIDATA_SOURCE,
      0.84,
      'One Wikidata country of citizenship. The card flag was not used.'
    );
  } else if (citizenships.length > 1) {
    empty.nationality = evidenceField(
      null,
      'conflicting_sources',
      WIKIDATA_SOURCE,
      0.3,
      `Wikidata lists more than one citizenship: ${citizenships.join(', ')}.`
    );
  }
  const clubs = seniorClubs(wiki.memberships);
  if (clubs.length === 1) {
    const club = clubs[0];
    const bracketed = Boolean(club.start && club.end);
    empty.club = evidenceField(
      club.club,
      bracketed ? 'high_confidence' : 'high_confidence',
      WIKIDATA_SOURCE,
      bracketed ? 0.9 : 0.8,
      bracketed
        ? `Senior club membership ${club.start.slice(0, 10)} to ${club.end.slice(0, 10)} covers ${REFERENCE_DATE}.`
        : `Senior club membership starts ${club.start ? club.start.slice(0, 10) : 'without a start date'} and has no end date before ${REFERENCE_DATE}.`
    );
  } else if (clubs.length > 1) {
    empty.club = evidenceField(
      null,
      'conflicting_sources',
      WIKIDATA_SOURCE,
      0.3,
      `More than one senior club covers ${REFERENCE_DATE}: ${clubs.map((club) => club.club).join(', ')}.`
    );
  }
  const cardFamily = POSITION_FAMILY[cardPosition] || null;
  const wikiFamilies = [...new Set((wiki.positions || []).map(wikiFamily).filter(Boolean))];
  if (cardPosition && wikiFamilies.length) {
    if (wikiFamilies.includes(cardFamily)) {
      empty.position = evidenceField(
        cardPosition,
        'high_confidence',
        WIKIDATA_SOURCE,
        0.86,
        `The card position ${cardPosition} agrees with the Wikidata role ${wiki.positions.join(', ')}. The extracted position was kept.`
      );
    } else {
      empty.position = evidenceField(
        cardPosition,
        'conflicting_sources',
        WIKIDATA_SOURCE,
        0.25,
        `The card position ${cardPosition} does not agree with ${wiki.positions.join(', ')}. The extracted position was kept.`
      );
    }
  } else if (!cardPosition && wiki.positions?.length === 1) {
    empty.position = evidenceField(
      wiki.positions[0],
      'unverified',
      WIKIDATA_SOURCE,
      0.55,
      'Wikidata has a role and the card position was not read. It was not copied into the extracted position.'
    );
  }
  if (wiki.aliases?.length) {
    empty.aliases = evidenceField(
      wiki.aliases.slice(0, 8),
      'unverified',
      WIKIDATA_SOURCE,
      0.5,
      'English Wikidata aliases. They were not used to merge records.'
    );
  }
  return empty;
}

function promoteVerified(enriched, identityVerified) {
  if (!identityVerified) return enriched;
  const next = { ...enriched };
  for (const key of ['fullName', 'nationality', 'club']) {
    const field = next[key];
    const clubIsBracketed = key !== 'club' || / to \d{4}-\d{2}-\d{2}/.test(field.evidence || '');
    if (field.status === 'high_confidence' && field.value && clubIsBracketed) {
      next[key] = { ...field, status: 'verified', confidence: Math.max(field.confidence || 0, 0.9) };
    }
  }
  if (next.position.status === 'high_confidence' && next.position.value) {
    next.position = { ...next.position, status: 'verified', confidence: Math.max(next.position.confidence || 0, 0.9) };
  }
  return next;
}

/**
 * @param {object[]} players catalogue records
 * @param {object[]} alternatives archived card versions
 * @param {Record<string, object>} wikidata keyed by normalizeName(canonical name)
 */
export function buildIdentityCatalogue(players, alternatives = [], wikidata = {}) {
  const input = [...(players || [])];
  const altsByPlayer = new Map();
  for (const card of alternatives || []) {
    if (!altsByPlayer.has(card.playerId)) altsByPlayer.set(card.playerId, []);
    altsByPlayer.get(card.playerId).push(card);
  }
  const proposals = input.map((player) => ({ player, ...localProposal(player) }));
  const similar = new Map();
  for (let i = 0; i < proposals.length; i += 1) {
    for (let j = i + 1; j < proposals.length; j += 1) {
      if (!namesAreSimilar(proposals[i].normalizedName, proposals[j].normalizedName)) continue;
      for (const [left, right] of [[i, j], [j, i]]) {
        if (!similar.has(proposals[left].player.playerId)) similar.set(proposals[left].player.playerId, []);
        similar.get(proposals[left].player.playerId).push(proposals[right].player.playerId);
      }
    }
  }
  const proposedOwners = new Map();
  for (const item of proposals) {
    if (!item.lookupKey) continue;
    if (!proposedOwners.has(item.lookupKey)) proposedOwners.set(item.lookupKey, []);
    proposedOwners.get(item.lookupKey).push(item.player.playerId);
  }

  const records = proposals.map((item) => {
    const { player } = item;
    const wiki = item.lookupKey ? wikidata[item.lookupKey] : null;
    const issue = spellingIssue(player);
    const versions = altsByPlayer.get(player.playerId) || [];
    const versionPositions = [...new Set(versions.map((card) => card.position).filter(Boolean))];
    const evidence = [];
    if (item.filenameAgrees) {
      evidence.push(`OCR tokens sit inside the image filename ${player.sourceImage}.`);
    } else if (item.stem) {
      evidence.push('The image filename and the OCR name do not agree, so the filename was not used as a correction.');
    }
    if (versions.length) {
      evidence.push(`${versions.length} archived card versions stay attached to ${player.playerId}.`);
    }
    if (versionPositions.length > 1) {
      evidence.push(`Archived versions also show positions ${versionPositions.join(', ')}. The selected card was kept.`);
    }
    const shared = item.lookupKey && (proposedOwners.get(item.lookupKey) || []).length > 1;
    let status = 'manual_review';
    let reason = 'The record needs a person to check it before a canonical name is accepted.';
    let matchConfidence = 0.4;
    const positionConflict = Boolean(
      player.position && wiki?.matchCount === 1
      && (wiki.positions || []).length
      && !(wiki.positions || []).map(wikiFamily).includes(POSITION_FAMILY[player.position])
    );

    if (!item.normalizedName || item.normalizedName.length < 3 || (issue && /digit/.test(issue))) {
      status = 'unidentified';
      reason = issue || 'The extracted name is too short to identify a player.';
      matchConfidence = 0.1;
    } else if (shared || (wiki && wiki.matchCount > 1) || positionConflict) {
      status = 'ambiguous';
      reason = shared
        ? 'More than one catalogue record points at the same proposed name. They were not merged.'
        : positionConflict
          ? 'The card position conflicts with the reference footballer. No correction was applied.'
          : 'The reference dataset has more than one footballer with this exact name.';
      matchConfidence = 0.3;
    } else if (issue) {
      status = 'manual_review';
      reason = `${issue} The name was not corrected automatically.`;
      matchConfidence = 0.35;
    } else if (wiki?.matchCount === 1 && (item.filenameAgrees || item.ocrTokens.length > 1) && player.position) {
      status = 'verified';
      reason = 'The card name, one Wikidata footballer, and the card position agree. The original OCR name was kept.';
      matchConfidence = 0.92;
      evidence.push(`Wikidata ${wiki.ids?.[0] || ''} is the only association football player with this exact English name.`.trim());
    } else if (wiki?.matchCount === 1 && (item.filenameAgrees || item.ocrTokens.length > 1)) {
      status = 'high_confidence_candidate';
      reason = 'One Wikidata footballer matches the proposed name. The card position was not read, so this stays a candidate.';
      matchConfidence = 0.78;
      evidence.push('Wikidata returned one association football player. Verification still needs the card position.');
    } else if (item.filenameAgrees && item.stem && item.stem.length > item.ocrTokens.length) {
      status = 'high_confidence_candidate';
      reason = 'The filename expands the OCR surname. No unique reference footballer was accepted, so this stays a candidate.';
      matchConfidence = 0.62;
    } else if (item.ocrTokens.length < 2) {
      status = 'manual_review';
      reason = 'The card only shows part of the name. A surname on its own was not looked up and was not corrected.';
      matchConfidence = 0.4;
    }

    if (status === 'verified' && item.proposedCanonicalName == null) status = 'manual_review';
    const identityVerified = status === 'verified';
    const enriched = promoteVerified(
      enrichFromWiki(item, status === 'unidentified' ? null : wiki, player.position),
      identityVerified
    );
    if (status === 'ambiguous' && wiki?.matchCount > 1) {
      enriched.fullName = evidenceField(
        null,
        'conflicting_sources',
        WIKIDATA_SOURCE,
        0.2,
        `${wiki.matchCount} Wikidata footballers share this exact name. None was selected.`
      );
    }
    const proposedCanonicalName = identityVerified || status === 'high_confidence_candidate'
      ? (enriched.fullName.value || item.proposedCanonicalName)
      : null;
    const nameChanged = Boolean(
      proposedCanonicalName && normalizeName(proposedCanonicalName) !== item.normalizedName
    );
    return {
      playerId: player.playerId,
      extractedName: player.name,
      ocrName: player.ocrName || null,
      normalizedName: item.normalizedName,
      overall: player.overall ?? null,
      position: player.position ?? null,
      imagePath: player.imagePath || null,
      sourceImage: player.sourceImage,
      sourcePath: player.sourcePath,
      extractionConfidence: player.extractionConfidence ?? null,
      identityConfidence: player.identityConfidence ?? null,
      auctionEligible: false,
      cardArtApproved: false,
      imageRightsStatus: 'unverified',
      identity: {
        status,
        proposedCanonicalName,
        proposedPlayerId: proposedCanonicalName ? playerIdFor(proposedCanonicalName) : null,
        matchConfidence,
        evidence,
        reason,
        nameCorrectionProposed: nameChanged,
        originalNamePreserved: true
      },
      enriched,
      artwork: artworkEvidence(),
      similarPlayerIds: (similar.get(player.playerId) || []).sort(),
      verificationStatus: status
    };
  });

  const pairs = duplicatePairs(input);
  const byId = new Map(records.map((record) => [record.playerId, record]));
  for (const pair of pairs) {
    const left = byId.get(pair.playerId);
    const right = byId.get(pair.otherPlayerId);
    if (left?.identity.proposedCanonicalName && right?.identity.proposedCanonicalName
      && normalizeName(left.identity.proposedCanonicalName) === normalizeName(right.identity.proposedCanonicalName)) {
      pair.suggestedMatch = left.identity.proposedCanonicalName;
      pair.supportingEvidence = 'Both records propose the same canonical name. They were still not merged.';
    }
  }

  records.sort((left, right) => left.playerId.localeCompare(right.playerId));
  pairs.sort((left, right) => left.playerId.localeCompare(right.playerId) || left.otherPlayerId.localeCompare(right.otherPlayerId));

  const summary = {
    totalIdentities: records.length,
    verified: records.filter((record) => record.verificationStatus === 'verified').length,
    highConfidenceCandidates: records.filter((record) => record.verificationStatus === 'high_confidence_candidate').length,
    manualReview: records.filter((record) => record.verificationStatus === 'manual_review').length,
    ambiguous: records.filter((record) => record.verificationStatus === 'ambiguous').length,
    unidentified: records.filter((record) => record.verificationStatus === 'unidentified').length,
    namesCorrected: records.filter((record) => record.identity.nameCorrectionProposed && record.verificationStatus === 'verified').length,
    verifiedNationality: records.filter((record) => record.enriched.nationality.status === 'verified').length,
    verifiedClub: records.filter((record) => record.enriched.club.status === 'verified').length,
    verifiedLeague: records.filter((record) => record.enriched.league.status === 'verified').length,
    possibleDuplicates: pairs.length,
    uncertain: records.filter((record) => record.verificationStatus !== 'verified').length,
    referenceDate: REFERENCE_DATE,
    source: WIKIDATA_SOURCE,
    liveAuctionActivated: false
  };

  return { summary, records, duplicates: pairs };
}

export function wikidataQueryNames(players) {
  const names = new Set();
  for (const player of players || []) {
    const proposal = localProposal(player);
    if (!proposal.lookupKey) continue;
    if (proposal.filenameAgrees || proposal.ocrTokens.length > 1) names.add(proposal.lookupKey);
  }
  return [...names].sort();
}
