import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERROR_CODES, ROOM_SCHEMA_VERSION } from '../constants.js';
import { RoomManager } from '../room-manager.js';
import { captureLiveRoom, materializeLiveRoom, indexCards } from '../room-snapshot.js';
import { MemoryRoomWriter } from '../room-store.js';
import { updateSeatLineup } from '../lineup-service.js';
import {
  FORMATION_IDS,
  FORMATIONS,
  LINEUP_ERRORS,
  SQUAD_RATING,
  evaluateSquad,
  positionSuitability
} from '../../shared/squad-evaluation.js';

function card(id, position, stats) {
  return {
    id,
    name: id,
    position,
    category: 'BASIC',
    basePrice: 10,
    stats
  };
}

function rated(id, position, overall) {
  return card(id, position, {
    pace: overall,
    shooting: overall,
    passing: overall,
    defense: overall,
    physical: overall,
    overall
  });
}

function xi() {
  return [
    rated('gk', 'GK', 80),
    rated('lb', 'LB', 70),
    rated('lcb', 'CB', 75),
    rated('rcb', 'CB', 74),
    rated('rb', 'RB', 71),
    rated('lcm', 'CM', 78),
    rated('cm', 'CM', 77),
    rated('rcm', 'CM', 76),
    rated('lw', 'LW', 82),
    rated('st', 'ST', 88),
    rated('rw', 'RW', 73),
    rated('bench', 'ST', 60)
  ];
}

function seat(cards = xi()) {
  const rooms = new RoomManager();
  const code = rooms.createRoom();
  const joined = rooms.takeSeat(code, 'sock-ada', 'ada');
  for (const owned of cards) rooms.addCardToTeam(code, 'sock-ada', owned);
  return { rooms, code, player: rooms.getPlayer(code, 'sock-ada'), seatId: joined.player.seatId };
}

function fullAssignments(formationId, cards) {
  return FORMATIONS[formationId].slots.map((slot, index) => ({
    slotId: slot.id,
    cardId: cards[index].id
  }));
}

describe('formation layouts', () => {
  it('defines 4-3-3, 4-2-3-1, and 3-5-2 as data with 11 unique places', () => {
    assert.deepEqual(FORMATION_IDS, ['4-3-3', '4-2-3-1', '3-5-2']);
    assert.deepEqual(Object.keys(FORMATIONS), FORMATION_IDS);

    const count = (formation, line) => formation.slots.filter((slot) => slot.line === line).length;
    assert.equal(count(FORMATIONS['4-3-3'], 'def'), 4);
    assert.equal(count(FORMATIONS['4-3-3'], 'mid'), 3);
    assert.equal(count(FORMATIONS['4-3-3'], 'att'), 3);
    assert.equal(count(FORMATIONS['4-2-3-1'], 'def'), 4);
    assert.equal(count(FORMATIONS['4-2-3-1'], 'dm'), 2);
    assert.equal(count(FORMATIONS['4-2-3-1'], 'am'), 3);
    assert.equal(count(FORMATIONS['4-2-3-1'], 'att'), 1);
    assert.equal(count(FORMATIONS['3-5-2'], 'def'), 3);
    assert.equal(count(FORMATIONS['3-5-2'], 'mid'), 5);
    assert.equal(count(FORMATIONS['3-5-2'], 'att'), 2);

    for (const formation of Object.values(FORMATIONS)) {
      assert.equal(formation.slots.length, 11);
      assert.equal(new Set(formation.slots.map((slot) => slot.id)).size, 11);
      assert.equal(formation.slots.filter((slot) => slot.role === 'GK').length, 1);
      for (const slot of formation.slots) {
        assert.equal(typeof slot.role, 'string');
        assert.ok(slot.x >= 0 && slot.x <= 100);
        assert.ok(slot.y >= 0 && slot.y <= 100);
      }
    }
  });
});

describe('squad rating', () => {
  it('rates position fit and squad strength without inventing missing attributes', () => {
    assert.equal(positionSuitability('ST', 'ST'), 100);
    assert.equal(positionSuitability('GK', 'GK'), 100);
    assert.equal(positionSuitability('GK', 'CB'), 12);
    assert.ok(positionSuitability('CB', 'ST') < SQUAD_RATING.compromiseAt);
    assert.equal(positionSuitability('LW  RM,LM,RW', 'RW'), 100);
    assert.ok(positionSuitability('LB', 'LWB') >= SQUAD_RATING.suitableAt);
    assert.equal(positionSuitability('', 'ST'), null);
    assert.equal(positionSuitability(null, 'ST'), null);
    assert.equal(positionSuitability('UNKNOWN', 'ST'), null);

    const natural = evaluateSquad(
      [rated('st', 'ST', 80)],
      { formation: '4-3-3', slots: [{ slotId: 'st', cardId: 'st' }] }
    );
    assert.equal(natural.slots.find((slot) => slot.slotId === 'st').score, 89);
    assert.equal(natural.strength, 89);
    assert.equal(natural.complete, false);
    assert.equal(natural.filled, 1);
    assert.equal(natural.coverage.percent, 9);
    assert.equal(natural.coverage.suitable, 1);
    assert.equal(natural.slots.find((slot) => slot.slotId === 'st').fit.label, 'Natural');

    const mismatch = evaluateSquad(
      [rated('cb', 'CB', 90)],
      { formation: '4-3-3', slots: [{ slotId: 'st', cardId: 'cb' }] }
    );
    const mismatchSlot = mismatch.slots.find((slot) => slot.slotId === 'st');
    assert.equal(mismatchSlot.score, 63);
    assert.equal(mismatchSlot.fit.key, 'mismatch');
    assert.ok(mismatch.weak.some((item) => item.slotId === 'st' && item.reason === 'Out of position'));

    const blank = evaluateSquad(
      [card('ghost', 'ST', {})],
      { formation: '4-3-3', slots: [{ slotId: 'st', cardId: 'ghost' }] }
    );
    const blankSlot = blank.slots.find((slot) => slot.slotId === 'st');
    assert.equal(blankSlot.overall, null);
    assert.equal(blankSlot.attributeFit, null);
    assert.equal(blankSlot.score, 100);
    assert.notEqual(blankSlot.score, 75);
    for (const key of ['pace', 'shooting', 'passing', 'physical', 'overall']) {
      assert.ok(blankSlot.missing.includes(key));
    }
    assert.ok(blank.weak.some((item) => item.reason === 'Missing attributes'));

    const noPosition = evaluateSquad(
      [card('mystery', null, { overall: 80 })],
      { formation: '4-3-3', slots: [{ slotId: 'st', cardId: 'mystery' }] }
    );
    const mystery = noPosition.slots.find((slot) => slot.slotId === 'st');
    assert.equal(mystery.suitability, null);
    assert.equal(mystery.score, 80);
    assert.ok(mystery.missing.includes('position'));
    assert.equal(noPosition.weak.some((item) => item.slotId === 'st' && item.reason === 'Position unknown'), true);

    const clamped = evaluateSquad(
      [card('wild', 'ST', { overall: 150 })],
      { formation: '4-3-3', slots: [{ slotId: 'st', cardId: 'wild' }] }
    );
    assert.equal(clamped.slots.find((slot) => slot.slotId === 'st').overall, 99);
    assert.equal(clamped.strength, 100);

    assert.equal(evaluateSquad([], { formation: 'nope' }).strength, null);
    assert.doesNotThrow(() => evaluateSquad(null, null));
  });

  it('marks an incomplete lineup and lists the empty places', () => {
    const evaluation = evaluateSquad(
      [rated('gk', 'GK', 80), rated('st', 'ST', 90)],
      {
        formation: '4-2-3-1',
        slots: [
          { slotId: 'gk', cardId: 'gk' },
          { slotId: 'st', cardId: 'st' }
        ]
      }
    );
    assert.equal(evaluation.complete, false);
    assert.equal(evaluation.filled, 2);
    const empty = evaluation.weak.filter((item) => item.reason === 'Empty');
    assert.equal(empty.length, 9);
    assert.equal(evaluation.slots.filter((slot) => slot.cardId == null).length, 9);
  });
});

describe('lineup updates', () => {
  it('assigns and removes a player without dropping acquired cards', () => {
    const { rooms, code, player } = seat();
    const owned = player.team.map((ownedCard) => ownedCard.id);

    const assigned = updateSeatLineup(rooms, code, 'sock-ada', {
      formation: '4-3-3',
      assignments: [
        { slotId: 'gk', cardId: 'gk' },
        { slotId: 'st', cardId: 'st' }
      ],
      expectedRevision: 0
    }, 'finished');
    assert.equal(assigned.ok, true);
    assert.equal(assigned.lineup.revision, 1);
    assert.equal(assigned.lineup.assignments.find((slot) => slot.slotId === 'gk').cardId, 'gk');
    assert.equal(assigned.lineup.evaluation.filled, 2);

    const removed = updateSeatLineup(rooms, code, 'sock-ada', {
      assignments: assigned.lineup.assignments.map((slot) => (
        slot.slotId === 'st' ? { slotId: slot.slotId, cardId: null } : slot
      )),
      expectedRevision: 1
    }, 'finished');
    assert.equal(removed.ok, true);
    assert.equal(removed.lineup.assignments.find((slot) => slot.slotId === 'st').cardId, null);
    assert.equal(removed.lineup.assignments.find((slot) => slot.slotId === 'gk').cardId, 'gk');
    assert.deepEqual(player.team.map((ownedCard) => ownedCard.id), owned);
  });

  it('rejects a duplicate assignment and leaves the lineup untouched', () => {
    const { rooms, code, player } = seat();
    const result = updateSeatLineup(rooms, code, 'sock-ada', {
      assignments: [
        { slotId: 'st', cardId: 'st' },
        { slotId: 'lw', cardId: 'st' }
      ],
      expectedRevision: 0
    }, 'finished');
    assert.equal(result.ok, false);
    assert.equal(result.error, LINEUP_ERRORS.DUPLICATE_PLAYER);
    assert.equal(ERROR_CODES.DUPLICATE_PLAYER, LINEUP_ERRORS.DUPLICATE_PLAYER);
    assert.equal(player.lineup, undefined);
    assert.equal(player.team.length, 12);
  });

  it('rejects a player the room does not own', () => {
    const { rooms, code, player } = seat();
    const result = updateSeatLineup(rooms, code, 'sock-ada', {
      assignments: [{ slotId: 'st', cardId: 'not-on-this-team' }],
      expectedRevision: 0
    }, 'finished');
    assert.equal(result.ok, false);
    assert.equal(result.error, LINEUP_ERRORS.CARD_NOT_OWNED);
    assert.equal(player.lineup, undefined);
  });

  it('rejects confirmation until every place is filled', () => {
    const { rooms, code, player } = seat();
    const result = updateSeatLineup(rooms, code, 'sock-ada', {
      assignments: [{ slotId: 'gk', cardId: 'gk' }],
      expectedRevision: 0,
      confirm: true
    }, 'finished');
    assert.equal(result.ok, false);
    assert.equal(result.error, LINEUP_ERRORS.TEAM_INCOMPLETE);
    assert.equal(player.lineup, undefined);
    assert.equal(player.teamBuilt, undefined);
  });

  it('confirms a full lineup and keeps the spare player on the bench', () => {
    const { rooms, code, player } = seat();
    const result = updateSeatLineup(rooms, code, 'sock-ada', {
      formation: '4-3-3',
      assignments: fullAssignments('4-3-3', player.team),
      expectedRevision: 0,
      confirm: true
    }, 'finished');
    assert.equal(result.ok, true);
    assert.equal(result.lineup.confirmed, true);
    assert.equal(result.lineup.evaluation.complete, true);
    assert.equal(player.teamBuilt, true);
    assert.equal(player.builtTeam.length, 11);
    assert.equal(player.team.length, 12);
    assert.equal(player.builtTeam.find((item) => item.id === 'bench'), undefined);
    assert.equal(player.teamOverall, result.lineup.evaluation.strength);
    assert.equal(typeof player.teamOverall, 'number');
  });

  it('changes formation without deleting acquired players', () => {
    const { rooms, code, player } = seat();
    const owned = player.team.map((ownedCard) => ownedCard.id);
    const placed = updateSeatLineup(rooms, code, 'sock-ada', {
      formation: '4-3-3',
      assignments: [
        { slotId: 'gk', cardId: 'gk' },
        { slotId: 'lb', cardId: 'lb' },
        { slotId: 'lcm', cardId: 'lcm' }
      ],
      expectedRevision: 0
    }, 'finished');
    assert.equal(placed.ok, true);

    const switched = updateSeatLineup(rooms, code, 'sock-ada', {
      formation: '4-2-3-1',
      expectedRevision: placed.lineup.revision
    }, 'finished');
    assert.equal(switched.ok, true);
    assert.equal(switched.lineup.formation, '4-2-3-1');
    assert.equal(switched.lineup.confirmed, false);
    assert.equal(switched.lineup.assignments.find((slot) => slot.slotId === 'gk').cardId, 'gk');
    assert.equal(switched.lineup.assignments.find((slot) => slot.slotId === 'lb').cardId, 'lb');
    assert.equal(switched.lineup.assignments.some((slot) => slot.cardId === 'lcm'), false);
    assert.equal(player.team.some((ownedCard) => ownedCard.id === 'lcm'), true);
    assert.deepEqual(player.team.map((ownedCard) => ownedCard.id), owned);
    assert.equal(updateSeatLineup(rooms, code, 'sock-ada', {
      formation: '2-2-6',
      expectedRevision: switched.lineup.revision
    }, 'finished').error, LINEUP_ERRORS.INVALID_FORMATION);
  });

  it('rejects a lineup change before the auction is finished', () => {
    const { rooms, code } = seat();
    const result = updateSeatLineup(rooms, code, 'sock-ada', {
      assignments: [{ slotId: 'gk', cardId: 'gk' }],
      expectedRevision: 0
    }, 'bidding');
    assert.equal(result.ok, false);
    assert.equal(result.error, LINEUP_ERRORS.AUCTION_NOT_FINISHED);
  });

  it('rejects a competing lineup update and a stale room snapshot', async () => {
    const { rooms, code, player, seatId } = seat();
    const first = updateSeatLineup(rooms, code, 'sock-ada', {
      assignments: [{ slotId: 'gk', cardId: 'gk' }],
      expectedRevision: 0
    }, 'finished');
    const second = updateSeatLineup(rooms, code, 'sock-ada', {
      assignments: [{ slotId: 'gk', cardId: 'st' }],
      expectedRevision: 0
    }, 'finished');
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.error, LINEUP_ERRORS.STALE_LINEUP);
    assert.equal(second.lineup.revision, 1);
    assert.equal(player.lineup.revision, 1);
    assert.equal(player.lineup.slots.find((slot) => slot.slotId === 'gk').cardId, 'gk');

    const doc = captureLiveRoom(rooms.getRoom(code), null);
    doc.stateVersion = 1;
    const writer = new MemoryRoomWriter();
    assert.equal(await writer.save(doc, 0), true);
    const stale = JSON.parse(JSON.stringify(doc));
    stale.stateVersion = 2;
    stale.state.seats[0].lineup.slots.find((slot) => slot.slotId === 'gk').cardId = 'st';
    assert.equal(await writer.save(stale, 0), false);
    const saved = writer.docs.get(code);
    assert.equal(saved.state.seats[0].lineup.slots.find((slot) => slot.slotId === 'gk').cardId, 'gk');
    assert.equal(saved.schemaVersion, ROOM_SCHEMA_VERSION);
    assert.equal(ROOM_SCHEMA_VERSION, 1);
    assert.equal(seatId, player.seatId);
  });

  it('restores a confirmed lineup after the room is rebuilt', () => {
    const { rooms, code, player, seatId } = seat();
    const cards = player.team.map((ownedCard) => ({ ...ownedCard }));
    const saved = updateSeatLineup(rooms, code, 'sock-ada', {
      formation: '3-5-2',
      assignments: fullAssignments('3-5-2', player.team),
      expectedRevision: 0,
      confirm: true
    }, 'finished');
    assert.equal(saved.ok, true);
    const before = saved.lineup.evaluation.strength;

    const doc = captureLiveRoom(rooms.getRoom(code), null);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.state.seats[0].lineup.formation, '3-5-2');
    assert.equal(doc.state.seats[0].lineup.revision, 1);
    assert.equal(doc.state.seats[0].lineup.confirmed, true);
    assert.equal(doc.state.seats[0].cardIds.length, 12);

    const live = materializeLiveRoom(doc, { catalog: indexCards(cards), socketsDead: true });
    const restored = live.room.players.get(seatId);
    assert.equal(restored.lineup.formation, '3-5-2');
    assert.equal(restored.lineup.revision, 1);
    assert.equal(restored.lineup.confirmed, true);
    assert.equal(restored.team.length, 12);
    assert.deepEqual(
      restored.lineup.slots.map((slot) => slot.cardId),
      player.lineup.slots.map((slot) => slot.cardId)
    );
    assert.equal(restored.teamBuilt, true);
    assert.equal(restored.builtTeam.length, 11);
    assert.equal(restored.builtTeam[0].assignedPosition, 'GK');
    const again = evaluateSquad(restored.team, restored.lineup);
    assert.equal(again.strength, before);
    assert.equal(again.complete, true);

    rooms.resetForRematch(code);
    assert.equal(player.lineup, null);
    assert.deepEqual(player.team, []);
  });
});
