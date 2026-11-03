import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'url';
import { buildIdentityCatalogue } from '../players/identity-verify.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function player(overrides) {
  return {
    playerId: 'fut23_messi',
    name: 'Messi',
    ocrName: 'MESSI',
    overall: 99,
    position: 'ST',
    sourceImage: 'fut23_lionel_messi_card_08.webp',
    sourcePath: 'd:/Draft11/frontend/public/player-cards/fut23_lionel_messi_card_08.webp',
    imagePath: '/player-cards/fut23_lionel_messi_card_08.webp',
    extractionConfidence: 1,
    identityConfidence: 0.35,
    ...overrides
  };
}

const messiWiki = {
  'lionel messi': {
    matchCount: 1,
    ids: ['http://www.wikidata.org/entity/Q615'],
    labels: ['Lionel Messi'],
    citizenships: ['Argentina'],
    positions: ['forward'],
    aliases: ['Leo Messi'],
    memberships: [
      { club: 'Paris Saint-Germain FC', start: '2021-08-01T00:00:00Z', end: '2023-06-30T00:00:00Z' },
      { club: 'Argentina national football team', start: '2005-01-01T00:00:00Z', end: null }
    ]
  }
};

describe('identity verification', () => {
  it('keeps the original player id and OCR name while proposing a canonical name', () => {
    const result = buildIdentityCatalogue([player({})], [], messiWiki);
    const record = result.records[0];
    assert.equal(record.playerId, 'fut23_messi');
    assert.equal(record.ocrName, 'MESSI');
    assert.equal(record.extractedName, 'Messi');
    assert.equal(record.verificationStatus, 'verified');
    assert.equal(record.identity.proposedCanonicalName, 'Lionel Messi');
    assert.equal(record.identity.proposedPlayerId, 'fut23_lionel_messi');
    assert.equal(record.identity.originalNamePreserved, true);
    assert.equal(record.auctionEligible, false);
    assert.equal(record.enriched.nationality.value, 'Argentina');
    assert.equal(record.enriched.nationality.status, 'verified');
    assert.equal(record.enriched.nationality.source, 'https://query.wikidata.org/sparql');
    assert.equal(record.enriched.club.value, 'Paris Saint-Germain FC');
    assert.equal(record.enriched.club.status, 'verified');
    assert.equal(record.enriched.league.status, 'unknown');
    assert.equal(record.enriched.league.value, null);
    assert.equal(record.artwork.clubBadge.status, 'unknown');
  });

  it('does not merge similar names', () => {
    const result = buildIdentityCatalogue([
      player({}),
      player({
        playerId: 'fut23_kessie',
        name: 'Kessie',
        ocrName: 'KESSIE',
        sourceImage: 'fut23_franck_kessie_primary.webp',
        position: 'CM'
      })
    ], [], messiWiki);
    assert.equal(result.records.length, 2);
    assert.equal(result.records.map((record) => record.playerId).sort().join(), 'fut23_kessie,fut23_messi');
    assert.equal(result.records.find((record) => record.playerId === 'fut23_messi').verificationStatus, 'verified');
    assert.equal(result.records.find((record) => record.playerId === 'fut23_kessie').playerId, 'fut23_kessie');
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].reviewDecision, 'unresolved');
    assert.match(result.duplicates[0].supportingEvidence, /not enough to merge/i);
  });

  it('keeps two reference footballers ambiguous and does not pick one', () => {
    const result = buildIdentityCatalogue([
      player({
        playerId: 'fut23_silva',
        name: 'Thiago Silva',
        ocrName: 'THIAGO SILVA',
        sourceImage: '117652710.png',
        position: 'CB'
      })
    ], [], {
      'thiago silva': { matchCount: 2, ids: ['Q1', 'Q2'], labels: [], citizenships: [], positions: [], aliases: [], memberships: [] }
    });
    assert.equal(result.records[0].verificationStatus, 'ambiguous');
    assert.equal(result.records[0].identity.proposedCanonicalName, null);
    assert.equal(result.records[0].enriched.club.value, null);
    assert.equal(result.records[0].enriched.fullName.status, 'conflicting_sources');
  });

  it('records conflicting clubs instead of choosing one', () => {
    const result = buildIdentityCatalogue([player({})], [], {
      'lionel messi': {
        ...messiWiki['lionel messi'],
        memberships: [
          { club: 'Paris Saint-Germain FC', start: '2021-08-01T00:00:00Z', end: '2023-06-30T00:00:00Z' },
          { club: 'FC Barcelona', start: '2022-01-01T00:00:00Z', end: '2023-01-01T00:00:00Z' }
        ]
      }
    });
    assert.equal(result.records[0].enriched.club.status, 'conflicting_sources');
    assert.equal(result.records[0].enriched.club.value, null);
  });

  it('does not verify an open-ended club membership', () => {
    const result = buildIdentityCatalogue([
      player({
        playerId: 'fut23_haaland',
        name: 'Haaland',
        ocrName: 'HAALAND',
        sourceImage: 'fut23_erling_haaland_card_05.webp',
        position: 'ST'
      })
    ], [], {
      'erling haaland': {
        matchCount: 1,
        ids: ['Q21621995'],
        labels: ['Erling Haaland'],
        citizenships: ['Norway'],
        positions: ['forward'],
        aliases: [],
        memberships: [{ club: 'Manchester City F.C.', start: '2022-01-01T00:00:00Z', end: null }]
      }
    });
    assert.equal(result.records[0].verificationStatus, 'verified');
    assert.equal(result.records[0].enriched.club.value, 'Manchester City F.C.');
    assert.equal(result.records[0].enriched.club.status, 'high_confidence');
  });

  it('does not invent a club for an unread surname', () => {
    const result = buildIdentityCatalogue([
      player({
        playerId: 'fut23_aaronson',
        name: 'Aaronson',
        ocrName: 'AARONSON',
        sourceImage: '67356225.png',
        imagePath: null,
        position: null
      })
    ], [], {});
    const record = result.records[0];
    assert.equal(record.verificationStatus, 'manual_review');
    assert.equal(record.identity.proposedCanonicalName, null);
    assert.equal(record.enriched.club.status, 'unknown');
    assert.equal(record.enriched.nationality.value, null);
    assert.equal(record.enriched.league.value, null);
  });

  it('returns the same verification when run again', () => {
    const cards = [player({}), player({ playerId: 'fut23_kessie', name: 'Kessie', ocrName: 'KESSIE', sourceImage: 'a.png', position: null })];
    const first = buildIdentityCatalogue(cards, [], messiWiki);
    const second = buildIdentityCatalogue([...cards].reverse(), [], messiWiki);
    assert.deepEqual(
      second.records.map((record) => record.playerId),
      first.records.map((record) => record.playerId)
    );
    assert.deepEqual(second.summary, first.summary);
  });

  it('does not import the live game database', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'backend', 'players', 'identity-verify.js'), 'utf8');
    assert.equal(source.includes('mongoose'), false);
    assert.equal(source.includes('mongodb'), false);
    assert.equal(source.includes('seed'), false);
  });
});
