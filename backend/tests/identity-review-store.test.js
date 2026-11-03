import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import express from 'express';
import { createReviewStore } from '../players/identity-review-store.js';
import { createIdentityReviewRouter } from '../players/identity-review-routes.js';
import { applyLeagueEvidence } from '../players/league-enrichment.js';

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'draft11-review-'));
  return createReviewStore(path.join(directory, 'store.json'));
}

function player(overrides = {}) {
  return {
    playerId: 'fut23_messi',
    verificationStatus: 'verified',
    ocrName: 'MESSI',
    extractedName: 'Messi',
    enriched: {
      club: {
        value: 'Paris Saint-Germain FC',
        status: 'verified',
        source: 'https://query.wikidata.org/sparql',
        sourceDate: '2022-09-30',
        confidence: 0.9,
        evidence: 'Dated club membership.'
      },
      nationality: { value: 'Argentina', status: 'verified' },
      league: { value: null, status: 'unknown' },
      position: { value: 'ST', status: 'verified' }
    },
    ...overrides
  };
}

describe('identity review store', () => {
  it('keeps a decision across a new store reading the same file', async () => {
    const store = temporaryStore();
    await store.saveDecision({
      playerId: 'fut23_messi',
      ocrName: 'MESSI',
      proposedCanonicalName: 'Lionel Messi',
      decision: 'confirm',
      expectedRevision: 0,
      sessionId: 'unauthenticated-a'
    });
    const reopened = createReviewStore(store.filePath);
    const saved = await reopened.read();
    assert.equal(saved.decisions.fut23_messi.decision, 'confirm');
    assert.equal(saved.decisions.fut23_messi.ocrName, 'MESSI');
    assert.equal(saved.decisions.fut23_messi.authenticated, false);
    assert.equal(saved.audit.length, 1);
  });

  it('rejects a stale revision and keeps the newer decision', async () => {
    const store = temporaryStore();
    await store.saveDecision({
      playerId: 'fut23_messi',
      ocrName: 'MESSI',
      decision: 'confirm',
      expectedRevision: 0,
      sessionId: 'unauthenticated-a'
    });
    await assert.rejects(
      () => store.saveDecision({
        playerId: 'fut23_messi',
        ocrName: 'MESSI',
        decision: 'reject',
        expectedRevision: 0,
        sessionId: 'unauthenticated-b'
      }),
      (error) => error.status === 409
    );
    const saved = await store.read();
    assert.equal(saved.decisions.fut23_messi.decision, 'confirm');
  });

  it('undoes a correction and keeps both versions in the audit', async () => {
    const store = temporaryStore();
    await store.saveDecision({
      playerId: 'fut23_messi',
      ocrName: 'MESSI',
      decision: 'confirm',
      expectedRevision: 0,
      sessionId: 'unauthenticated-a'
    });
    const corrected = await store.saveDecision({
      playerId: 'fut23_messi',
      ocrName: 'MESSI',
      decision: 'correct',
      correctedName: 'Lionel Andrés Messi',
      expectedRevision: 1,
      sessionId: 'unauthenticated-a'
    });
    assert.equal(corrected.correctedName, 'Lionel Andrés Messi');
    const undone = await store.undoDecision('fut23_messi', { expectedRevision: 2, sessionId: 'unauthenticated-a' });
    assert.equal(undone.decision, 'confirm');
    assert.equal(undone.correctedName, null);
    const saved = await store.read();
    assert.equal(saved.decisions.fut23_messi.ocrName, 'MESSI');
    assert.equal(saved.audit.some((item) => item.type === 'undo'), true);
  });

  it('plans a duplicate match without removing either player', async () => {
    const store = temporaryStore();
    const saved = await store.saveDuplicate({
      playerId: 'fut23_messi',
      otherPlayerId: 'fut23_messi_atar',
      decision: 'same',
      expectedRevision: 0,
      sessionId: 'unauthenticated-a'
    });
    assert.equal(saved.mergePlan.executed, false);
    assert.equal(saved.mergePlan.reversible, true);
    const players = ['fut23_messi', 'fut23_messi_atar'];
    assert.deepEqual(players.filter((id) => id === saved.playerId || id === saved.otherPlayerId).sort(), players.sort());
  });

  it('does not let an older backup replace a newer decision', async () => {
    const store = temporaryStore();
    const first = await store.saveDecision({
      playerId: 'fut23_messi',
      ocrName: 'MESSI',
      decision: 'confirm',
      expectedRevision: 0,
      sessionId: 'unauthenticated-a'
    });
    const backup = await store.read();
    await store.saveDecision({
      playerId: 'fut23_messi',
      ocrName: 'MESSI',
      decision: 'reject',
      expectedRevision: first.revision,
      sessionId: 'unauthenticated-a'
    });
    const result = await store.restore(backup);
    const saved = await store.read();
    assert.equal(saved.decisions.fut23_messi.decision, 'reject');
    assert.equal(result.ignoredNewer, 1);
  });

  it('serves the same conflict through the review routes', async () => {
    const store = temporaryStore();
    const app = express();
    app.use(express.json());
    app.use('/api/identity-review', createIdentityReviewRouter(store));
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const port = server.address().port;
    try {
      const body = JSON.stringify({
        ocrName: 'MESSI',
        decision: 'confirm',
        expectedRevision: 0,
        sessionId: 'unauthenticated-a'
      });
      const first = await fetch(`http://127.0.0.1:${port}/api/identity-review/decisions/fut23_messi`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      const second = await fetch(`http://127.0.0.1:${port}/api/identity-review/decisions/fut23_messi`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      assert.equal(first.status, 200);
      assert.equal(second.status, 409);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('league enrichment', () => {
  it('verifies one dated domestic league and leaves the identity status alone', () => {
    const [record] = applyLeagueEvidence([player()], {
      'Paris Saint-Germain FC': {
        matchCount: 1,
        leagues: [
          { league: 'Ligue 1', start: '2022-08-01T00:00:00Z', end: '2023-06-30T00:00:00Z' },
          { league: 'UEFA Champions League', start: '2022-08-01T00:00:00Z', end: '2023-06-30T00:00:00Z' }
        ]
      }
    });
    assert.equal(record.verificationStatus, 'verified');
    assert.equal(record.ocrName, 'MESSI');
    assert.equal(record.enriched.club.value, 'Paris Saint-Germain FC');
    assert.equal(record.enriched.league.value, 'Ligue 1');
    assert.equal(record.enriched.league.status, 'verified');
    assert.equal(record.enriched.league.source, 'https://query.wikidata.org/sparql');
    assert.match(record.enriched.league.evidence, /2022-09-30/);
  });

  it('ignores a league that is only a Wikidata id', () => {
    const [record] = applyLeagueEvidence([player()], {
      'Paris Saint-Germain FC': {
        matchCount: 1,
        leagues: [{ league: 'Q15804', start: '2022-08-01T00:00:00Z', end: '2023-06-30T00:00:00Z' }]
      }
    });
    assert.equal(record.enriched.league.value, null);
    assert.equal(record.enriched.league.status, 'unknown');
  });

  it('does not treat an open-ended league as verified', () => {
    const [record] = applyLeagueEvidence([player()], {
      'Paris Saint-Germain FC': {
        matchCount: 1,
        leagues: [{ league: 'Ligue 1', start: '1974-01-01T00:00:00Z', end: null }]
      }
    });
    assert.equal(record.enriched.league.value, 'Ligue 1');
    assert.equal(record.enriched.league.status, 'high_confidence');
  });

  it('keeps a conflict empty and does not enrich an unverified identity', () => {
    const [conflict] = applyLeagueEvidence([player()], {
      'Paris Saint-Germain FC': {
        matchCount: 1,
        leagues: [
          { league: 'Ligue 1', start: '2022-08-01T00:00:00Z', end: '2023-06-30T00:00:00Z' },
          { league: 'Premier League', start: '2022-08-01T00:00:00Z', end: '2023-06-30T00:00:00Z' }
        ]
      }
    });
    assert.equal(conflict.enriched.league.value, null);
    assert.equal(conflict.enriched.league.status, 'conflicting_sources');
    const [candidate] = applyLeagueEvidence([
      player({ verificationStatus: 'high_confidence_candidate' })
    ], {
      'Paris Saint-Germain FC': {
        matchCount: 1,
        leagues: [{ league: 'Ligue 1', start: '2022-08-01T00:00:00Z', end: '2023-06-30T00:00:00Z' }]
      }
    });
    assert.equal(candidate.enriched.league.status, 'unknown');
    assert.equal(candidate.verificationStatus, 'high_confidence_candidate');
  });
});
