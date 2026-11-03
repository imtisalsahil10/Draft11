import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RoomManager } from '../room-manager.js';
import { GAME_CONFIG } from '../constants.js';

const card = (id) => ({ id, name: id, basePrice: 10 });

describe('room membership', () => {
  it('seats a player once, preserves a rejoin, and rejects a sixth player', () => {
    const rooms = new RoomManager();
    const code = rooms.createRoom();
    assert.equal(code.length, 6);

    let first = null;
    for (let i = 1; i <= 5; i += 1) {
      const seat = rooms.takeSeat(code, `s${i}`, `player${i}`);
      if (i === 1) first = seat;
      assert.equal(seat.rejoined, false);
      assert.ok(seat.player);
    }
    assert.deepEqual(rooms.takeSeat(code, 's6', 'player6'), { error: 'full' });

    rooms.getPlayer(code, 's1').balance = 640;
    rooms.addCardToTeam(code, 's1', card('alpha'));
    const token = first.seatToken;
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 48);
    assert.equal(first.player.seatToken, undefined);
    assert.equal(typeof first.player.seatTokenHash, 'string');
    assert.equal(rooms.takeSeat(code, 's1-new', 'player1').error, 'seat-taken');
    assert.equal(rooms.takeSeat(code, 's1-new', 'player1', 'wrong-token').error, 'seat-taken');
    assert.equal(rooms.getPlayer(code, 's1').balance, 640);
    const rejoined = rooms.takeSeat(code, 's1-new', 'player1', token);
    assert.equal(rejoined.rejoined, true);
    assert.equal(rejoined.replaced, true);
    assert.equal(rejoined.player.balance, 640);
    assert.equal(rejoined.player.team.length, 1);
    assert.equal(rooms.getPlayer(code, 's1'), undefined);
    assert.equal(rooms.getRoomPlayers(code).length, 5);
  });

  it('lets a player buy more than 11 cards when budget and unique ownership allow it', () => {
    const rooms = new RoomManager();
    const code = rooms.createRoom();
    rooms.takeSeat(code, 's1', 'ada');
    for (let i = 0; i < 15; i += 1) {
      assert.equal(rooms.addCardToTeam(code, 's1', card(`c${i}`)), true);
    }
    assert.equal(rooms.getPlayer(code, 's1').team.length, 15);
    assert.equal(GAME_CONFIG.REQUIRED_TEAM_SIZE, 11);
    assert.equal(GAME_CONFIG.ALLOWED_SUBSTITUTES, 3);
  });

  it('refuses to sell the same card twice and keeps an empty auction room until it is abandoned', () => {
    const rooms = new RoomManager();
    const code = rooms.createRoom();
    rooms.takeSeat(code, 's1', 'ada');
    rooms.takeSeat(code, 's2', 'bea');
    assert.equal(rooms.addCardToTeam(code, 's1', card('alpha')), true);
    assert.equal(rooms.addCardToTeam(code, 's1', card('alpha')), false);
    assert.equal(rooms.addCardToTeam(code, 's2', card('alpha')), false);
    assert.equal(rooms.addCardToTeam(code, 's2', card('beta')), true);
    assert.equal(rooms.getPlayer(code, 's1').team.length, 1);

    assert.equal(rooms.removePlayerFromRoom(code, 's1', { preserveEmpty: true }), true);
    assert.equal(rooms.removePlayerFromRoom(code, 's2', { preserveEmpty: true }), true);
    assert.ok(rooms.getRoom(code));
    assert.equal(rooms.sweep(Date.now()).includes(code), false);
    const emptiedAt = rooms.getRoom(code).emptiedAt;
    assert.ok(emptiedAt);
    const removed = rooms.sweep(emptiedAt + GAME_CONFIG.DISCONNECT_TIMEOUT_MS);
    assert.ok(removed.includes(code));
    assert.equal(rooms.getRoom(code), undefined);
  });

  it('keeps a quitter\'s cards, moves the host, and deletes the room when the last player leaves', () => {
    const rooms = new RoomManager();
    const code = rooms.createRoom();
    rooms.takeSeat(code, 's1', 'ada');
    rooms.takeSeat(code, 's2', 'bea');
    assert.equal(rooms.getRoom(code).hostUsername, 'ada');
    rooms.addCardToTeam(code, 's1', card('alpha'));
    rooms.getPlayer(code, 's1').balance = 850;

    assert.equal(rooms.removePlayerFromRoom(code, 's1'), true);
    const room = rooms.getRoom(code);
    assert.equal(room.hostUsername, 'bea');
    assert.equal(room.players.has('s1'), false);
    assert.equal(room.departedSeats.length, 1);
    assert.equal(room.departedSeats[0].username, 'ada');
    assert.equal(room.departedSeats[0].balance, 850);
    assert.equal(room.departedSeats[0].team[0].id, 'alpha');
    assert.equal(room.departedSeats[0].squadStatus, 'abandoned');
    assert.equal(rooms.getPlayer(code, 's2').balance, GAME_CONFIG.INITIAL_BALANCE);

    assert.equal(rooms.removePlayerFromRoom(code, 's1'), false);
    assert.equal(room.departedSeats.length, 1);
    rooms.removePlayerFromRoom(code, 's2');
    assert.equal(rooms.getRoom(code), undefined);
  });

  it('records one match result and returns that same result again', () => {
    const rooms = new RoomManager();
    const code = rooms.createRoom();
    const first = rooms.recordMatch(code, { winner: 'ada', matches: [{ score: '1-0' }] });
    const second = rooms.recordMatch(code, { winner: 'bea', matches: [{ score: '2-0' }] });
    assert.equal(first.alreadyRecorded, false);
    assert.equal(second.alreadyRecorded, true);
    assert.equal(second.results.winner, 'ada');
    assert.equal(rooms.getRoom(code).matchResults.matches[0].score, '1-0');
  });

  it('keeps several purchased cards and a confirmed lineup when that player leaves', () => {
    const rooms = new RoomManager();
    const code = rooms.createRoom({ auctionPool: 'local-test' });
    rooms.takeSeat(code, 's1', 'ada');
    rooms.takeSeat(code, 's2', 'bea');
    for (let index = 0; index < 3; index += 1) {
      assert.equal(rooms.addCardToTeam(code, 's1', card(`c${index}`)), true);
    }
    const ada = rooms.getPlayer(code, 's1');
    ada.balance = 700;
    ada.teamBuilt = true;
    ada.lineup = { confirmed: true, formation: '4-3-3', revision: 2 };
    const beaBalance = rooms.getPlayer(code, 's2').balance;

    assert.equal(rooms.removePlayerFromRoom(code, 's1'), true);
    const room = rooms.getRoom(code);
    assert.equal(room.hostUsername, 'bea');
    assert.equal(room.players.has('s1'), false);
    assert.equal(room.departedSeats.length, 1);
    assert.equal(room.departedSeats[0].squadStatus, 'preserved');
    assert.equal(room.departedSeats[0].lineup.confirmed, true);
    assert.deepEqual(room.departedSeats[0].team.map((owned) => owned.id), ['c0', 'c1', 'c2']);
    assert.equal(room.departedSeats[0].balance, 700);
    assert.equal(rooms.getPlayer(code, 's2').team.length, 0);
    assert.equal(rooms.getPlayer(code, 's2').balance, beaBalance);
    assert.equal([...room.players.values()].some((player) => player.username === 'ada'), false);

    assert.equal(rooms.removePlayerFromRoom(code, 's1'), false);
    assert.equal(room.departedSeats.length, 1);
  });

  it('deletes a waiting room when the last player leaves and sweeps idle rooms', () => {
    const rooms = new RoomManager();
    const code = rooms.createRoom();
    rooms.takeSeat(code, 's1', 'ada');
    rooms.removePlayerFromRoom(code, 's1');
    assert.equal(rooms.getRoom(code), undefined);

    const stale = rooms.createRoom();
    rooms.getRoom(stale).lastActivity = Date.now() - GAME_CONFIG.ROOM_TIMEOUT_MS - 1;
    assert.ok(rooms.sweep().includes(stale));
  });
});
