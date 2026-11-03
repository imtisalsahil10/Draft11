/**
 * HISTORICAL LEAGUE EVIDENCE
 * A verified club is not a league. A league is accepted only when that club
 * has one domestic-league membership covering 30 September 2022.
 * Identity status is left unchanged.
 */

export const REFERENCE_DATE = '2022-09-30';
export const WIKIDATA_SOURCE = 'https://query.wikidata.org/sparql';

const NON_DOMESTIC = /champions league|europa league|conference league|\bcup\b|super cup|supercup|world cup|uefa|copa libertadores|fa cup|dfb-pokal|coppa|coupe de la ligue/i;

function evidenceField(value, status, evidence, confidence) {
  return {
    value: value ?? null,
    status,
    source: status === 'unknown' ? null : WIKIDATA_SOURCE,
    sourceDate: status === 'unknown' ? null : REFERENCE_DATE,
    confidence: confidence ?? null,
    evidence
  };
}

function covers(entry, referenceMs) {
  if (!entry?.league || /^Q\d+$/.test(entry.league) || NON_DOMESTIC.test(entry.league)) return false;
  const start = Date.parse(entry.start || '');
  if (Number.isNaN(start) || start > referenceMs) return false;
  const end = Date.parse(entry.end || '');
  if (!Number.isNaN(end) && end <= referenceMs) return false;
  return true;
}

function distinct(entries) {
  return [...new Set(entries.map((entry) => entry.league))];
}

export function leagueForClub(info, reference = REFERENCE_DATE) {
  if (!info || info.matchCount === 0) {
    return evidenceField(null, 'unknown', `No Wikidata club matched this exact name for a league lookup on ${reference}.`, null);
  }
  if (info.matchCount !== 1) {
    return evidenceField(
      null,
      'conflicting_sources',
      `${info.matchCount} Wikidata clubs share this exact name. No league was chosen.`,
      0.2
    );
  }
  const referenceMs = Date.parse(`${reference}T00:00:00Z`);
  const covering = (info.leagues || []).filter((entry) => covers(entry, referenceMs));
  const bracketed = covering.filter((entry) => entry.end && !Number.isNaN(Date.parse(entry.end)));
  const bracketedNames = distinct(bracketed);
  if (bracketedNames.length === 1) {
    const chosen = bracketed.find((entry) => entry.league === bracketedNames[0]);
    return evidenceField(
      bracketedNames[0],
      'verified',
      `Domestic league membership ${chosen.start.slice(0, 10)} to ${chosen.end.slice(0, 10)} covers ${reference}. The club name alone was not used.`,
      0.9
    );
  }
  if (bracketedNames.length > 1) {
    return evidenceField(
      null,
      'conflicting_sources',
      `More than one domestic league covers ${reference}: ${bracketedNames.join(', ')}.`,
      0.3
    );
  }
  const openNames = distinct(covering.filter((entry) => !entry.end || Number.isNaN(Date.parse(entry.end))));
  if (openNames.length === 1) {
    return evidenceField(
      openNames[0],
      'high_confidence',
      `A domestic league membership covers ${reference} but has no end date, so it was not marked verified.`,
      0.8
    );
  }
  if (openNames.length > 1) {
    return evidenceField(
      null,
      'conflicting_sources',
      `More than one open-ended domestic league covers ${reference}: ${openNames.join(', ')}.`,
      0.3
    );
  }
  return evidenceField(null, 'unknown', `No domestic league membership covers ${reference}.`, null);
}

export function applyLeagueEvidence(records, clubs = {}) {
  return (records || []).map((record) => {
    const club = record.enriched?.club;
    if (record.verificationStatus !== 'verified' || club?.status !== 'verified' || !club.value) return record;
    const league = leagueForClub(clubs[club.value]);
    return {
      ...record,
      verificationStatus: record.verificationStatus,
      enriched: {
        ...record.enriched,
        league
      }
    };
  });
}
