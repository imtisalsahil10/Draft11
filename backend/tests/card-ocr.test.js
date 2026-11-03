import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readCard(image, playerId) {
  const result = spawnSync('python', [
    'backend/players/image_card_ocr.py',
    'read',
    '--image',
    image,
    '--id',
    playerId
  ], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

describe('card artwork OCR', () => {
  it('reads ROMAGNOLI, 91 and CB from the card that was stored as -fts.', () => {
    const image = path.join(repoRoot, 'frontend', 'public', 'player-cards', 'fut23_fts_primary.png');
    const reading = readCard(image, 'fut23_fts');
    assert.equal(reading.ocrName, 'ROMAGNOLI');
    assert.equal(reading.displayName, 'Romagnoli');
    assert.equal(reading.overall, 91);
    assert.equal(reading.position, 'CB');
    assert.equal(reading.nationality, 'Italy');
    assert.equal(reading.pace, 86);
    assert.equal(reading.shooting, 52);
    assert.equal(reading.passing, 72);
    assert.equal(reading.dribbling, 78);
    assert.equal(reading.defending, 93);
    assert.equal(reading.physical, 90);
    assert.equal(reading.nameConfident, true);
    assert.deepEqual(reading.reviewReasons, []);
  });

  it('reads Henry, 98 and RW from the icon card without inventing a club', () => {
    const result = spawnSync('python', [
      'backend/players/image_card_recover.py',
      'read',
      '--image',
      path.join(repoRoot, 'frontend', 'public', 'player-cards', 'fut23_henry_primary.png')
    ], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const reading = JSON.parse(result.stdout);
    assert.equal(reading.displayName, 'Henry');
    assert.equal(reading.overall, 98);
    assert.equal(reading.position, 'RW');
    assert.equal(reading.nationality, 'France');
    assert.equal(reading.outfield.pace, 98);
    assert.equal(reading.outfield.shooting, 95);
    assert.equal(reading.outfield.passing, 93);
    assert.equal(reading.outfield.dribbling, 98);
    assert.equal(reading.outfield.defending, 70);
    assert.equal(reading.outfield.physical, 86);
    assert.equal(reading.club, undefined);
  });

  it('reads Messi, Mbappe and Haaland from their card artwork', () => {
    const root = path.join(repoRoot, 'frontend', 'public', 'player-cards');
    const messi = readCard(path.join(root, 'fut23_lionel_messi_primary.webp'), 'fut23_lionel_messi');
    const mbappe = readCard(path.join(root, 'fut23_kylian_mbappe_primary.webp'), 'fut23_kylian_mbappe');
    const haaland = readCard(path.join(root, 'fut23_erling_haaland_primary.webp'), 'fut23_erling_haaland');
    assert.equal(messi.displayName, 'Messi');
    assert.equal(messi.overall, 98);
    assert.equal(messi.nationality, 'Argentina');
    assert.equal(mbappe.displayName, 'Mbappe');
    assert.equal(mbappe.overall, 97);
    assert.equal(mbappe.position, 'ST');
    assert.equal(mbappe.nationality, 'France');
    assert.equal(haaland.displayName, 'Haaland');
    assert.equal(haaland.overall, 91);
    assert.equal(haaland.position, 'ST');
    assert.equal(haaland.dribbling, 87);
  });
});
