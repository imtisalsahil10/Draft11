import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'url';
import { FifaImportError, importFifaCsv } from '../players/fifa-import.js';
import { findLocalPhoto, readApprovals } from '../players/images.js';
import { suggestEleven } from '../league-match.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const csvPath = path.join(repoRoot, 'data', 'imports', 'fifa.csv');

const HEADER = [
  'sofifa_id', 'player_url', 'short_name', 'long_name', 'age', 'nationality', 'club_name',
  'league_name', 'overall', 'potential', 'player_positions', 'pace', 'shooting', 'passing',
  'dribbling', 'defending', 'physic', 'gk_diving', 'gk_handling', 'gk_kicking',
  'gk_reflexes', 'gk_speed', 'gk_positioning'
];

function line(values) {
  const record = Object.fromEntries(HEADER.map((column) => [column, '']));
  Object.assign(record, values);
  return HEADER.map((column) => {
    const value = String(record[column] ?? '');
    return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(',');
}

function csv(rows) {
  return [HEADER.join(','), ...rows.map((row) => line(row))].join('\n');
}

function player(overrides) {
  return {
    sofifa_id: '158023',
    player_url: 'https://sofifa.com/player/158023/lionel-messi/150002',
    short_name: 'L. Messi',
    long_name: 'Lionel Messi',
    age: '27',
    nationality: 'Argentina',
    club_name: 'FC Barcelona',
    league_name: 'Spain Primera Division',
    overall: '93',
    potential: '95',
    player_positions: 'CF',
    pace: '93',
    shooting: '89',
    passing: '86',
    dribbling: '96',
    defending: '27',
    physic: '63',
    ...overrides
  };
}

describe('FIFA importer', () => {
  it('imports only overall 85+ players from the five leagues in the supplied CSV', () => {
    const result = importFifaCsv(fs.readFileSync(csvPath, 'utf8'), {
      importedAt: '2026-10-31T00:00:00.000Z'
    });
    assert.equal(result.report.rowsRead, 16155);
    assert.equal(result.report.imported, 45);
    assert.deepEqual(result.report.byLeague, {
      'Premier League': 15,
      'La Liga': 13,
      'Bundesliga': 12,
      'Ligue 1': 3,
      'Serie A': 2
    });
    assert.deepEqual(result.report.excludedLeagues, {});
    assert.equal(result.cards.every((card) => card.stats.overall >= 85), true);
    assert.equal(JSON.stringify(result.cards).includes('sofifa.com'), false);
    assert.equal(JSON.stringify(result.cards).includes('http'), false);
  });

  it('keeps stable ids and does not duplicate a player when import runs again', () => {
    const text = fs.readFileSync(csvPath, 'utf8');
    const first = importFifaCsv(text, { importedAt: '2026-10-31T00:00:00.000Z' });
    const second = importFifaCsv(text, { importedAt: '2026-11-01T00:00:00.000Z' });
    assert.deepEqual(second.cards.map((card) => card.id), first.cards.map((card) => card.id));
    assert.equal(new Set(first.cards.map((card) => card.id)).size, 45);
    const messi = first.cards.find((card) => card.source.sofifaId === 158023);
    assert.equal(messi.id, 'fifa_158023');
    assert.equal(messi.name, 'L. Messi');
    assert.equal(messi.club, 'FC Barcelona');
    assert.equal(messi.league, 'La Liga');
    assert.equal(messi.nationality, 'Argentina');
    assert.equal(messi.age, 27);
    assert.equal(messi.potential, 95);
    assert.equal(messi.stats.pace, 93);
    assert.equal(messi.stats.overall, 93);
    assert.equal(messi.source.dataset, 'fifa');
    assert.equal(messi.source.version, 'sofifa-150002');
    assert.equal(second.cards.find((card) => card.id === 'fifa_158023').source.sofifaId, 158023);
  });

  it('can fill four non-overlapping squads from the imported catalog', () => {
    const { cards } = importFifaCsv(fs.readFileSync(csvPath, 'utf8'), {
      importedAt: '2026-10-31T00:00:00.000Z'
    });
    const pool = [...cards];
    let filled = 0;
    while (pool.length) {
      const suggestion = suggestEleven(pool);
      if (!suggestion) break;
      filled += 1;
      const ids = new Set(suggestion.cards.map((card) => card.id));
      for (let index = pool.length - 1; index >= 0; index -= 1) {
        if (ids.has(pool[index].id)) pool.splice(index, 1);
      }
    }
    assert.equal(filled, 4);
  });

  it('rejects a missing required column and a duplicate sofifa id', () => {
    const header = HEADER.filter((column) => column !== 'overall').join(',');
    assert.throws(
      () => importFifaCsv(`${header}\n1`),
      (error) => error instanceof FifaImportError && error.code === 'MISSING_COLUMNS' && error.details.columns.includes('overall')
    );
    assert.throws(
      () => importFifaCsv(csv([player(), player({ short_name: 'Copy' })])),
      (error) => error instanceof FifaImportError && error.code === 'DUPLICATE_ID' && error.details.sofifaId === 158023
    );
  });

  it('drops players below 85 and players outside the five leagues', () => {
    const result = importFifaCsv(csv([
      player({ sofifa_id: '1', overall: '84', short_name: 'Low' }),
      player({ sofifa_id: '2', league_name: 'Holland Eredivisie', short_name: 'Other', overall: '90' }),
      player({ sofifa_id: '3' })
    ]), { importedAt: '2026-10-31T00:00:00.000Z' });
    assert.deepEqual(result.cards.map((card) => card.id), ['fifa_3']);
    assert.equal(result.report.excludedLeagues['Holland Eredivisie'], 1);
  });

  it('omits missing and zero ratings and maps goalkeeper attributes', () => {
    const result = importFifaCsv(csv([
      player({
        sofifa_id: '4',
        short_name: 'M. Neuer',
        player_positions: 'GK',
        league_name: 'German 1. Bundesliga',
        club_name: 'FC Bayern München',
        overall: '90',
        pace: '',
        shooting: '0',
        passing: '',
        dribbling: '',
        defending: '',
        physic: '',
        gk_diving: '87',
        gk_handling: '85',
        gk_kicking: '92',
        gk_reflexes: '86',
        gk_speed: '60',
        gk_positioning: '90'
      })
    ]), { importedAt: '2026-10-31T00:00:00.000Z' });
    const card = result.cards[0];
    assert.equal(card.position, 'GK');
    assert.equal(card.league, 'Bundesliga');
    assert.equal(card.stats.overall, 90);
    assert.equal(card.stats.pace, undefined);
    assert.equal(card.stats.shooting, undefined);
    assert.deepEqual(card.goalkeeping, {
      diving: 87,
      handling: 85,
      kicking: 92,
      reflexes: 86,
      speed: 60,
      positioning: 90
    });
  });

  it('stores a local photo only when the file exists and approves it only when listed', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fifa-images-'));
    fs.writeFileSync(path.join(directory, '158023.png'), 'png');
    const result = importFifaCsv(csv([player(), player({ sofifa_id: '99', short_name: 'No Photo', overall: '85' })]), {
      importedAt: '2026-10-31T00:00:00.000Z',
      approvals: [158023],
      imageFor: (id) => findLocalPhoto(directory, id)
    });
    const messi = result.cards.find((card) => card.id === 'fifa_158023');
    const other = result.cards.find((card) => card.id === 'fifa_99');
    assert.equal(messi.photoRef, '/player-images/158023.png');
    assert.equal(messi.photoApproved, true);
    assert.equal(other.photoRef, undefined);
    assert.equal(other.photoApproved, undefined);
    assert.equal(findLocalPhoto(directory, '../escape'), null);
    assert.equal(findLocalPhoto(directory, '158023/../../escape'), null);
    const unapproved = importFifaCsv(csv([player()]), {
      importedAt: '2026-10-31T00:00:00.000Z',
      approvals: readApprovals(path.join(repoRoot, 'data', 'player-image-approvals.json')),
      imageFor: (id) => findLocalPhoto(directory, id)
    });
    assert.equal(unapproved.cards[0].photoRef, '/player-images/158023.png');
    assert.equal(unapproved.cards[0].photoApproved, false);
    assert.equal(unapproved.report.images.approvalPending, true);
    assert.equal(unapproved.report.images.silhouettes, 1);
  });
});
