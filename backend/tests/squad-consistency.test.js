import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERROR_CODES } from '../constants.js';
import { RoomManager } from '../room-manager.js';
import { calculateTeamOverall } from '../team-builder.js';
import { commitBuiltTeam } from '../squad-service.js';
import { updateSeatLineup } from '../lineup-service.js';
import { captureLiveRoom, materializeLiveRoom, indexCards } from '../room-snapshot.js';
import {
  FORMATIONS,
  LINEUP_ERRORS,
  assignedStrength,
  evaluateSquad
} from '../../shared/squad-evaluation.js';

function rated(id, position, overall) {
  return {
    id,
    name: id,
    position,
    category: 'BASIC',
    basePrice: 10,
    stats: {
      pace: overall,
      shooting: overall,
      passing: overall,
      defense: overall,
      physical: overall,
      overall
    }
  };
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

function seat() {
  const rooms = new RoomManager();
  const code = rooms.createRoom();
  const joined = rooms.takeSeat(code, 'sock-ada', 'ada');
  for (const owned of xi()) rooms.addCardToTeam(code, 'sock-ada', owned);
  return { rooms, code, player: rooms.getPlayer(code, 'sock-ada'), seatId: joined.player.seatId };
}

describe('shared squad ratings', () => {
  it('does not replace a missing or zero overall with 75', () => {
    const bare = Array.from({ length: 11 }, (_, index) => ({
      id: `p${index}`,
      position: 'ST',
      assignedPosition: 'ST'
    }));
    assert.equal(calculateTeamOverall(bare), 100);
    assert.notEqual(calculateTeamOverall(bare), 75);

    const zeros = bare.map((card) => ({
      ...card,
      stats: { overall: 0, pace: 0, shooting: 0, passing: 0, defense: 0, physical: 0 }
    }));
    assert.equal(calculateTeamOverall(zeros), 45);
    assert.equal(calculateTeamOverall(zeros), assignedStrength(zeros));
  });
});

describe('built teams use one rating', () => {
  it('rejects a card the seat does not own and leaves the lineup untouched', () => {
    const { rooms, code, player } = seat();
    const result = commitBuiltTeam(rooms, code, 'sock-ada', {
      source: 'build',
      formation: '4-3-3',
      selectedCards: [{ id: 'not-owned', assignedPosition: 'GK' }]
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, ERROR_CODES.CARD_NOT_OWNED);
    assert.equal(player.lineup, undefined);
    assert.equal(player.teamBuilt, undefined);
    assert.equal(player.team.length, 12);
  });

  it('rejects a duplicate player', () => {
    const { rooms, code, player } = seat();
    const result = commitBuiltTeam(rooms, code, 'sock-ada', {
      source: 'build',
      formation: '4-3-3',
      selectedCards: [
        { id: 'gk', assignedPosition: 'GK' },
        { id: 'gk', assignedPosition: 'ST' }
      ]
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, ERROR_CODES.DUPLICATE_PLAYER);
    assert.equal(player.lineup, undefined);
  });

  it('stores an auto-built tactical XI with the shared strength', () => {
    const { rooms, code, player } = seat();
    const result = commitBuiltTeam(rooms, code, 'sock-ada', {
      source: 'auto',
      formation: '4-3-3'
    });
    assert.equal(result.ok, true);
    assert.equal(result.formation, '4-3-3');
    assert.equal(result.lineup.confirmed, true);
    assert.equal(result.lineup.revision, 1);
    assert.equal(player.team.length, 12);
    assert.equal(player.builtTeam.length, 11);
    assert.equal(player.builtTeam.some((card) => card.id === 'bench'), false);
    assert.equal(player.teamOverall, result.lineup.evaluation.strength);
    assert.equal(player.teamOverall, evaluateSquad(player.team, player.lineup).strength);
    assert.equal(player.teamOverall, calculateTeamOverall(player.builtTeam));
    assert.equal(result.overall, player.teamOverall);
  });

  it('rejects a stale lineup revision after an auto-build', () => {
    const { rooms, code, player } = seat();
    const built = commitBuiltTeam(rooms, code, 'sock-ada', {
      source: 'auto',
      formation: '4-3-3'
    });
    assert.equal(built.ok, true);
    const stale = updateSeatLineup(rooms, code, 'sock-ada', {
      formation: '4-3-3',
      assignments: built.lineup.assignments.map((slot) => (
        slot.slotId === 'gk' ? { slotId: 'gk', cardId: 'st' } : slot
      )),
      expectedRevision: 0,
      confirm: true
    }, 'finished');
    assert.equal(stale.ok, false);
    assert.equal(stale.error, LINEUP_ERRORS.STALE_LINEUP);
    assert.equal(player.lineup.revision, 1);
    assert.equal(player.lineup.slots.find((slot) => slot.slotId === 'gk').cardId, 'gk');
  });

  it('rates a legacy 4-4-2 with the shared formula and does not keep a second lineup', () => {
    const { rooms, code, player } = seat();
    const confirmed = updateSeatLineup(rooms, code, 'sock-ada', {
      formation: '4-3-3',
      assignments: FORMATIONS['4-3-3'].slots.map((slot, index) => ({
        slotId: slot.id,
        cardId: player.team[index].id
      })),
      expectedRevision: 0,
      confirm: true
    }, 'finished');
    assert.equal(confirmed.ok, true);

    const legacy = commitBuiltTeam(rooms, code, 'sock-ada', {
      source: 'auto',
      formation: '4-4-2'
    });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.formation, '4-4-2');
    assert.equal(legacy.lineup, null);
    assert.equal(player.lineup, null);
    assert.equal(player.teamOverall, calculateTeamOverall(player.builtTeam));
    assert.equal(player.teamOverall, assignedStrength(player.builtTeam));
    assert.notEqual(player.teamOverall, 75);
  });

  it('restores an auto-built lineup and the same strength', () => {
    const { rooms, code, player, seatId } = seat();
    const cards = player.team.map((owned) => ({ ...owned }));
    const built = commitBuiltTeam(rooms, code, 'sock-ada', {
      source: 'auto',
      formation: '3-5-2'
    });
    assert.equal(built.ok, true);
    assert.equal(built.overall, calculateTeamOverall(rooms.getPlayer(code, 'sock-ada').builtTeam));
    const before = built.lineup.evaluation.strength;

    const doc = captureLiveRoom(rooms.getRoom(code), null);
    const live = materializeLiveRoom(doc, { catalog: indexCards(cards), socketsDead: true });
    const restored = live.room.players.get(seatId);
    assert.equal(restored.lineup.formation, '3-5-2');
    assert.equal(restored.lineup.revision, 1);
    assert.equal(restored.lineup.confirmed, true);
    assert.equal(restored.teamOverall, before);
    assert.equal(evaluateSquad(restored.team, restored.lineup).strength, before);
    assert.equal(calculateTeamOverall(restored.builtTeam), before);
    assert.equal(restored.builtTeam.length, 11);
  });

  it('ignores a rating sent with the selected cards', () => {
    const { rooms, code, player } = seat();
    const result = commitBuiltTeam(rooms, code, 'sock-ada', {
      source: 'build',
      formation: '4-3-3',
      overall: 10,
      selectedCards: FORMATIONS['4-3-3'].slots.map((slot, index) => ({
        id: player.team[index].id,
        assignedPosition: slot.role,
        overall: 10
      }))
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.overall, evaluateSquad(player.team, player.lineup).strength);
    assert.notEqual(result.overall, 10);
    assert.equal(player.lineup.revision, 1);
    assert.equal(player.team.length, 12);
  });
});
