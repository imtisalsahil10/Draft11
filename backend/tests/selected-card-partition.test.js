import assert from 'node:assert/strict';
import path from 'path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'url';
import { readStoredCatalogue } from '../players/local-catalogue.js';
import { partitionSelectedCards } from '../players/selected-card-partition.js';
import { buildLiveImagePool } from '../players/live-image-pool.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function player(playerId, name, normalizedName = name.toLowerCase()) {
  return { playerId, name, normalizedName, primaryCardId: `${playerId}_selected` };
}

function card(playerId, fields) {
  return {
    cardId: `${playerId}_selected`,
    playerId,
    isPrimary: true,
    imagePath: `/player-cards/${playerId}_primary.png`,
    sourceImageHash: `hash-${playerId}`,
    cardPixelReading: {
      ocrName: fields.ocrName,
      nameConfident: fields.nameConfident !== false
    },
    overallRating: fields.overall ?? null,
    position: fields.position,
    bodyType: fields.bodyType || null,
    pace: fields.pace ?? null,
    shooting: fields.shooting ?? null,
    passing: fields.passing ?? null,
    dribbling: fields.dribbling ?? null,
    defending: fields.defending ?? null,
    physical: fields.physical ?? null
  };
}

function catalogue(rows) {
  return {
    players: rows.map((row) => player(row.playerId, row.name, row.normalizedName)),
    cards: rows.map((row) => card(row.playerId, row))
  };
}

describe('selected card partition', () => {
  it('keeps the highest card when the printed name, position, and body match', () => {
    const stored = catalogue([
      { playerId: 'fut23_ca_al', name: 'Carvajal', ocrName: 'CARVAJAL', overall: 96, position: 'RB', bodyType: '173cm Unique' },
      { playerId: 'fut23_carvajal', name: 'Carvajal', ocrName: 'CARVAJAL', overall: 88, position: 'RB', bodyType: '173cm Unique', pace: 89 },
      { playerId: 'fut23_rvajal', name: 'Carvajal', ocrName: 'CARVAJAL', overall: 88, position: 'RB', bodyType: '173cm Unique', pace: 89 }
    ]);
    const selected = partitionSelectedCards(stored);
    assert.deepEqual(selected.live.players.map((item) => item.playerId), ['fut23_ca_al']);
    assert.deepEqual(selected.archived.players.map((item) => item.playerId).sort(), ['fut23_carvajal', 'fut23_rvajal']);
    assert.equal(selected.live.cards[0].overallRating, 96);
    assert.equal(selected.live.cards[0].position, 'RB');
    assert.equal(selected.live.players[0].name, 'Carvajal');
  });

  it('keeps different players that only share a similar name', () => {
    const stored = catalogue([
      { playerId: 'fut23_carvajal', name: 'Carvajal', ocrName: 'CARVAJAL', overall: 88, position: 'RB', bodyType: '173cm Unique' },
      { playerId: 'fut23_carvalho', name: 'Ricardo Carvalho', normalizedName: 'ricardocarvalho', ocrName: 'CARVALHO', overall: 96, position: 'CB', bodyType: '183cm Average' },
      { playerId: 'fut23_walker', name: 'Walker', normalizedName: 'walker', ocrName: 'WALKER', overall: 89, position: 'RB', bodyType: '183cm Lean' },
      { playerId: 'fut23_al_alker', name: 'Walker', normalizedName: 'walker', ocrName: 'WALKER', overall: 94, position: 'GK', bodyType: '188cm Average' }
    ]);
    const selected = partitionSelectedCards(stored);
    assert.equal(selected.archived.players.length, 0);
    assert.equal(selected.live.players.length, 4);
  });

  it('does not merge the same display name when the printed name or body differs', () => {
    const stored = catalogue([
      { playerId: 'fut23_silva_a', name: 'Silva', ocrName: 'SILVA', overall: 90, position: 'CB', bodyType: '183cm Average' },
      { playerId: 'fut23_silva_b', name: 'Silva', ocrName: 'BERNARDOSILVA', overall: 88, position: 'CM', bodyType: '173cm Lean' },
      { playerId: 'fut23_one', name: 'Same', ocrName: 'SAME', overall: 90, position: 'ST', bodyType: '180cm Average' },
      { playerId: 'fut23_two', name: 'Same', ocrName: 'SAME', overall: 86, position: 'ST', bodyType: '190cm Stocky' }
    ]);
    const selected = partitionSelectedCards(stored);
    assert.equal(selected.archived.players.length, 0);
    assert.equal(selected.live.players.length, 4);
  });

  it('archives an exact duplicate card and leaves the canonical id live when ratings tie', () => {
    const stored = catalogue([
      { playerId: 'fut23_ao_felix', name: 'João Félix', normalizedName: 'joao felix', ocrName: 'FELIX', overall: 96, position: 'CAM', pace: 90 },
      { playerId: 'fut23_joao_felix', name: 'João Félix', normalizedName: 'joao felix', ocrName: 'FELIX', overall: 96, position: 'CAM', pace: 90 }
    ]);
    const selected = partitionSelectedCards(stored);
    assert.deepEqual(selected.live.players.map((item) => item.playerId), ['fut23_joao_felix']);
    assert.equal(selected.archived.players[0].playerId, 'fut23_ao_felix');
  });

  it('keeps all 1147 stored identities and one live card for each selected player', () => {
    const stored = readStoredCatalogue(path.join(repoRoot, 'data', 'local-catalogue', 'catalogue.json'));
    const selected = partitionSelectedCards(stored);
    const liveIds = selected.live.players.map((player) => player.playerId);
    const cardIds = selected.live.cards.map((card) => card.cardId);
    const paths = selected.live.cards.map((card) => card.imagePath);
    assert.equal(stored.players.length, 1147);
    assert.equal(stored.cards.length, 1147);
    assert.equal(selected.live.players.length, 1009);
    assert.equal(selected.archived.players.length, 138);
    assert.equal(new Set(liveIds).size, liveIds.length);
    assert.equal(new Set(cardIds).size, cardIds.length);
    assert.equal(new Set(paths).size, paths.length);
    assert.equal(selected.live.cards.length, selected.live.players.length);
    const carvajal = selected.live.players.filter((player) => player.normalizedName === 'carvajal');
    assert.equal(carvajal.length, 1);
    assert.equal(carvajal[0].playerId, 'fut23_ca_al');
    assert.equal(carvajal[0].name, 'Carvajal');
    const kept = selected.live.cards.find((card) => card.playerId === 'fut23_ca_al');
    assert.equal(kept.overallRating, 96);
    assert.equal(kept.position, 'RB');
    assert.equal(selected.archived.players.some((player) => player.playerId === 'fut23_carvajal'), true);
    assert.equal(selected.archived.players.some((player) => player.playerId === 'fut23_rvajal'), true);
    assert.equal(selected.live.players.some((player) => player.playerId === 'fut23_carvalho'), true);
    const pool = buildLiveImagePool(selected.live, { fileExists: () => true });
    assert.equal(pool.cards.length, 1009);
    assert.equal(pool.cards.some((card) => card.id === 'fut23_carvajal' || card.id === 'fut23_rvajal'), false);
    assert.equal(pool.cards.find((card) => card.id === 'fut23_ca_al').stats.overall, 96);
  });
});
