import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuctionEngine } from '../auction-engine.js';
import { RoomManager } from '../room-manager.js';
import { Validator } from '../validators.js';

function card(id, name = id, basePrice = 10) {
  return { id, name, basePrice, position: 'ST', category: 'Basic' };
}

describe('seat recovery', () => {
  it('restores the live card, bid, balance, and owned cards without a second timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rooms = new RoomManager();
    const engine = new AuctionEngine();
    const code = rooms.createRoom();
    const ada = rooms.takeSeat(code, 'ada-1', 'ada');
    rooms.takeSeat(code, 'bea-1', 'bea');
    rooms.addCardToTeam(code, 'ada-1', card('owned', 'Owned'));
    rooms.getPlayer(code, 'ada-1').balance = 985;

    assert.ok(engine.startAuction(code, [card('a', 'Alpha'), card('b', 'Bravo')], rooms.getRoom(code).players));
    engine.presentNextCard(code);
    assert.equal(engine.processBid(code, 'ada-1', 15).success, true);
    engine.getAuction(code).players.get('ada-1').balance = 985;

    let timeouts = 0;
    let transitions = 0;
    engine.setTimerCallback(code, () => { timeouts += 1; });
    engine.scheduleTransition(code, 'next', 1000, () => { transitions += 1; });
    const auction = engine.getAuction(code);
    const generation = auction.timerGeneration;
    const armedAt = auction.timerStarted;

    assert.equal(rooms.takeSeat(code, 'ada-2', 'ada').error, 'seat-taken');
    assert.equal(rooms.takeSeat(code, 'ada-2', 'ada', 'wrong').error, 'seat-taken');
    assert.equal(rooms.getPlayer(code, 'ada-1').balance, 985);

    const moved = rooms.takeSeat(code, 'ada-2', 'ada', ada.seatToken);
    assert.equal(moved.replaced, true);
    engine.attachPlayer(code, 'ada-2', 'ada', 1000);

    assert.equal(auction.timerGeneration, generation);
    assert.equal(auction.timerStarted, armedAt);
    assert.equal(auction.players.get('ada-2').balance, 985);
    assert.equal(auction.players.has('ada-1'), false);

    auction.timerStarted = Date.now() - 10000;
    const state = engine.getPublicState(code, 'ada-2', rooms.getPlayer(code, 'ada-2').team);
    assert.equal(state.phase, 'bidding');
    assert.equal(state.card.name, 'Alpha');
    assert.equal(state.highestBid, 15);
    assert.equal(state.highestBidder, 'ada-2');
    assert.equal(state.yourBalance, 985);
    assert.equal(state.yourCards[0].id, 'owned');
    assert.equal(state.minimumBid, Validator.nextMinimumBid(15));
    assert.equal(state.bidIncrement, Validator.bidStep(15));
    assert.ok(state.secondsRemaining <= 21 && state.secondsRemaining >= 19);

    t.mock.timers.tick(1000);
    assert.equal(transitions, 1);
    t.mock.timers.tick(29000);
    assert.equal(timeouts, 1);
    t.mock.timers.tick(60000);
    assert.equal(timeouts, 1);
    assert.equal(transitions, 1);
  });

  it('keeps a ready vote on the replacement socket', () => {
    const engine = new AuctionEngine();
    const seats = new Map([
      ['p1', { id: 'p1', username: 'ada', balance: 1000, isOnline: true }],
      ['p2', { id: 'p2', username: 'bea', balance: 1000, isOnline: true }]
    ]);
    engine.startAuction('ROOM01', [card('a', 'Alpha')], seats);
    engine.presentNextCard('ROOM01');
    engine.setWaitingForReady('ROOM01');
    assert.equal(engine.setPlayerReady('ROOM01', 'p1').success, true);
    engine.attachPlayer('ROOM01', 'p1-new', 'ada', 1000);

    const state = engine.getPublicState('ROOM01', 'p1-new');
    assert.equal(state.phase, 'waiting-for-ready');
    assert.equal(state.waitingForReady, true);
    assert.equal(state.readyPlayers.some((player) => player.playerId === 'p1-new'), true);
    assert.equal(state.readyPlayers.some((player) => player.playerId === 'p1'), false);
  });

  it('restores a finished squad and a rematch vote after the socket id changes', () => {
    const rooms = new RoomManager();
    const engine = new AuctionEngine();
    const code = rooms.createRoom();
    const ada = rooms.takeSeat(code, 'ada-1', 'ada');
    rooms.takeSeat(code, 'bea-1', 'bea');
    rooms.addCardToTeam(code, 'ada-1', card('kdb', 'Kevin'));
    rooms.getPlayer(code, 'ada-1').balance = 800;

    const room = rooms.getRoom(code);
    room.finalSquads = [{
      username: 'ada',
      balance: 800,
      cards: [{ id: 'kdb', name: 'Kevin' }]
    }, {
      username: 'bea',
      balance: 1000,
      cards: []
    }];
    room.rematchVotes = new Set(['ada']);

    assert.ok(engine.startAuction(code, [card('a', 'Alpha')], room.players));
    engine.getAuction(code).phase = 'finished';

    const moved = rooms.takeSeat(code, 'ada-2', 'ada', ada.seatToken);
    moved.player.balance = 0;
    moved.player.team = [];
    assert.equal(rooms.applySavedSquad(code, 'ada-2'), true);
    engine.attachPlayer(code, 'ada-2', 'ada', moved.player.balance);

    const state = engine.getPublicState(code, 'ada-2', moved.player.team);
    assert.equal(state.phase, 'finished');
    assert.equal(state.yourBalance, 800);
    assert.equal(state.yourCards[0].id, 'kdb');

    const rematch = rooms.rematchStatus(code);
    assert.equal(rematch.voted, 1);
    assert.equal(rematch.total, 2);
    assert.deepEqual(rematch.voters, [{ id: 'ada-2', username: 'ada' }]);
  });
});
