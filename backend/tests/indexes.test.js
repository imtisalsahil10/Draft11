import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Player, Game, Card, Leaderboard, LiveRoom, League, Fixture } from '../models.js';

function optionsFor(schema, spec) {
  const found = schema.indexes().filter(([fields]) => JSON.stringify(fields) === spec);
  assert.equal(found.length, 1, `${spec} declared ${found.length} times`);
  return found[0][1];
}

function duplicateKeys(schema) {
  const seen = new Map();
  for (const [fields] of schema.indexes()) {
    const key = JSON.stringify(fields);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}

describe('schema indexes', () => {
  it('keeps one unique index for each identity field and does not declare it twice', () => {
    assert.deepEqual(duplicateKeys(Player.schema), []);
    assert.deepEqual(duplicateKeys(Game.schema), []);
    assert.deepEqual(duplicateKeys(Card.schema), []);
    assert.deepEqual(duplicateKeys(Leaderboard.schema), []);
    assert.deepEqual(duplicateKeys(LiveRoom.schema), []);

    assert.equal(optionsFor(LiveRoom.schema, '{"roomId":1}').unique, true);
    assert.equal(optionsFor(LiveRoom.schema, '{"code":1}').unique, true);
    assert.equal(LiveRoom.schema.indexes().some(([fields]) => fields.expiresAt === 1), true);
    assert.equal(LiveRoom.schema.indexes().some(([fields]) => fields.status === 1), true);

    assert.equal(optionsFor(Player.schema, '{"username":1}').unique, true);
    assert.equal(optionsFor(Game.schema, '{"code":1}').unique, true);
    assert.equal(optionsFor(Card.schema, '{"id":1}').unique, true);
    assert.equal(optionsFor(Leaderboard.schema, '{"playerId":1}').unique, true);
    assert.equal(optionsFor(Card.schema, '{"name":1}').unique, undefined);

    assert.deepEqual(duplicateKeys(League.schema), []);
    assert.deepEqual(duplicateKeys(Fixture.schema), []);
    assert.equal(optionsFor(League.schema, '{"leagueId":1}').unique, true);
    assert.equal(optionsFor(League.schema, '{"inviteCodeHash":1}').unique, true);
    assert.equal(optionsFor(Fixture.schema, '{"fixtureId":1}').unique, true);
    assert.equal(optionsFor(Fixture.schema, '{"leagueId":1,"pairKey":1}').unique, true);
    assert.equal(optionsFor(Fixture.schema, '{"leagueId":1,"round":1,"homeMemberId":1}').unique, true);
    assert.equal(optionsFor(Fixture.schema, '{"leagueId":1,"round":1,"awayMemberId":1}').unique, true);
    assert.equal(optionsFor(Fixture.schema, '{"leagueId":1,"round":1,"participants":1}').unique, true);

    assert.equal(Player.schema.indexes().some(([fields]) => fields.createdAt === -1), true);
    assert.equal(Game.schema.indexes().some(([fields]) => fields.status === 1), true);
    assert.equal(Card.schema.indexes().some(([fields]) => fields.position === 1), true);
    assert.equal(Card.schema.indexes().some(([fields]) => fields['stats.overall'] === -1), true);
  });
});
