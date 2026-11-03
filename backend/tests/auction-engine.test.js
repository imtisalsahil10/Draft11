import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuctionEngine } from '../auction-engine.js';
import { GAME_CONFIG } from '../constants.js';
import { Validator } from '../validators.js';

function card(id, name = id, basePrice = 10) {
  return { id, name, basePrice, position: 'ST', category: 'Basic' };
}

function seats(balances = { p1: 1000, p2: 1000 }) {
  return new Map(Object.entries(balances).map(([id, balance]) => [id, {
    id,
    username: id,
    balance,
    isOnline: true
  }]));
}

function start(engine, code = 'ROOM01', deck = [card('a', 'Alpha'), card('b', 'Bravo')], balances) {
  const auction = engine.startAuction(code, deck, seats(balances));
  assert.ok(auction);
  return auction;
}

describe('auction bids', () => {
  it('uses the shared step of £5 below £100 and £10 from £100', () => {
    const engine = new AuctionEngine();
    start(engine);
    const presented = engine.presentNextCard('ROOM01');
    assert.equal(presented.name, 'Alpha');
    assert.equal(engine.calculateMinimumBid(presented.basePrice), 15);
    assert.equal(engine.calculateMinimumBid(95), 100);
    assert.equal(engine.calculateMinimumBid(100), 110);
    assert.equal(engine.calculateMinimumBid(110), 120);
    assert.equal(Validator.nextMinimumBid(100), engine.calculateMinimumBid(100));
    assert.equal(Validator.validateBidIncrement(100, 105).valid, false);
    assert.equal(Validator.validateBidIncrement(100, 110).valid, true);
    assert.equal(Validator.bidStep(99), GAME_CONFIG.MIN_BID_INCREMENT);
    assert.equal(Validator.bidStep(100), GAME_CONFIG.BID_INCREMENT_HIGH);

    const low = engine.processBid('ROOM01', 'p1', 14);
    assert.equal(low.success, false);
    assert.equal(low.minimumBid, 15);

    const exact = engine.processBid('ROOM01', 'p1', 15);
    assert.equal(exact.success, true);
    assert.equal(engine.calculateMinimumBid(15), 20);

    const stale = engine.processBid('ROOM01', 'p2', 15);
    assert.equal(stale.success, false);
    const duplicate = engine.processBid('ROOM01', 'p1', 15);
    assert.equal(duplicate.success, false);

    const ownBid = engine.processBid('ROOM01', 'p1', 20);
    assert.equal(ownBid.success, false);
    assert.match(ownBid.message, /highest bid/);

    const raised = engine.processBid('ROOM01', 'p2', 20);
    assert.equal(raised.success, true);
    assert.equal(raised.minimumBid, 25);
    assert.equal(raised.bidIncrement, 5);
    assert.equal(engine.getAuction('ROOM01').highestBidder, 'p2');

    engine.getAuction('ROOM01').highestBid = 100;
    const shortOfThreshold = engine.processBid('ROOM01', 'p1', 105);
    assert.equal(shortOfThreshold.success, false);
    assert.equal(shortOfThreshold.minimumBid, 110);
    const overThreshold = engine.processBid('ROOM01', 'p1', 110);
    assert.equal(overThreshold.success, true);
    assert.equal(overThreshold.bidIncrement, 10);
  });

  it('rejects bids that are not a whole number of pounds', () => {
    const engine = new AuctionEngine();
    start(engine);
    engine.presentNextCard('ROOM01');
    for (const bad of [undefined, null, '15', 15.5, NaN, 0, -5]) {
      const result = engine.processBid('ROOM01', 'p1', bad);
      assert.equal(result.success, false, `accepted ${String(bad)}`);
    }
    assert.equal(engine.getAuction('ROOM01').highestBidder, null);
  });

  it('rejects a bid the player cannot pay and never spends it early', () => {
    const engine = new AuctionEngine();
    start(engine, 'ROOM01', [card('a')], { p1: 20, p2: 1000 });
    engine.presentNextCard('ROOM01');
    const poor = engine.processBid('ROOM01', 'p1', 25);
    assert.equal(poor.success, false);
    assert.equal(engine.getAuction('ROOM01').players.get('p1').balance, 20);

    assert.equal(engine.processBid('ROOM01', 'p1', 20).success, true);
    assert.equal(engine.getAuction('ROOM01').players.get('p1').balance, 20);
  });

  it('lets only one of two equal bids win when they are applied together', () => {
    const engine = new AuctionEngine();
    start(engine);
    engine.presentNextCard('ROOM01');
    const results = [
      engine.processBid('ROOM01', 'p1', 15),
      engine.processBid('ROOM01', 'p2', 15)
    ];
    assert.equal(results.filter((result) => result.success).length, 1);
    assert.equal(engine.getAuction('ROOM01').bids.size, 1);
  });

  it('does not let a player win a card they can no longer afford', () => {
    const engine = new AuctionEngine();
    start(engine);
    engine.presentNextCard('ROOM01');
    assert.equal(engine.processBid('ROOM01', 'p1', 15).success, true);
    assert.equal(engine.processBid('ROOM01', 'p2', 30).success, true);
    engine.getAuction('ROOM01').players.get('p2').balance = 10;

    const result = engine.resolveCard('ROOM01');
    assert.equal(result.status, 'awarded');
    assert.equal(result.winnerId, 'p1');
    assert.equal(result.finalPrice, 15);
    assert.equal(engine.getAuction('ROOM01').players.get('p1').balance, 985);
    assert.equal(engine.getAuction('ROOM01').players.get('p2').balance, 10);
  });

  it('discards the card instead of driving a balance negative', () => {
    const engine = new AuctionEngine();
    start(engine, 'ROOM01', [card('a')], { p1: 20 });
    engine.presentNextCard('ROOM01');
    engine.processBid('ROOM01', 'p1', 20);
    engine.getAuction('ROOM01').players.get('p1').balance = 5;
    const result = engine.resolveCard('ROOM01');
    assert.equal(result.status, 'discarded');
    assert.equal(result.winnerId, null);
    assert.equal(engine.getAuction('ROOM01').players.get('p1').balance, 5);
  });
});

describe('auction ownership and completion', () => {
  it('sells a card once and skips a later copy of the same id', () => {
    const engine = new AuctionEngine();
    const deck = [card('same', 'First'), card('same', 'Copy'), card('other', 'Other')];
    start(engine, 'ROOM01', deck, { p1: 1000 });
    engine.presentNextCard('ROOM01');
    engine.processBid('ROOM01', 'p1', 15);
    const first = engine.resolveCard('ROOM01');
    assert.equal(first.status, 'awarded');
    assert.equal(engine.resolveCard('ROOM01'), null);
    assert.equal(engine.getAuction('ROOM01').players.get('p1').balance, 985);
    assert.equal(engine.getAuction('ROOM01').players.get('p1').cardsWon, 1);

    const next = engine.presentNextCard('ROOM01');
    assert.equal(next.id, 'other');
    assert.equal(engine.presentNextCard('ROOM01').blocked, true);
    assert.equal(engine.getAuction('ROOM01').currentCard.id, 'other');
  });

  it('withdraws a pass and ends the card when everyone connected has passed', () => {
    const engine = new AuctionEngine();
    start(engine);
    engine.presentNextCard('ROOM01');
    engine.processBid('ROOM01', 'p1', 40);
    engine.processBid('ROOM01', 'p2', 50);
    const firstPass = engine.processSkip('ROOM01', 'p2');
    assert.equal(firstPass.success, true);
    assert.equal(firstPass.highestBid, 40);
    assert.equal(engine.processBid('ROOM01', 'p2', 45).success, false);

    const again = engine.processSkip('ROOM01', 'p2');
    assert.equal(again.alreadySkipped, true);

    const secondPass = engine.processSkip('ROOM01', 'p1');
    assert.equal(secondPass.allSkipped, true);
    const resolved = engine.resolveCard('ROOM01');
    assert.equal(resolved.status, 'discarded');
    assert.equal(engine.getAuction('ROOM01').players.get('p1').balance, 1000);
  });

  it('counts a ready room once and ignores spectators and offline seats', () => {
    const engine = new AuctionEngine();
    start(engine, 'ROOM01', [card('a')], { p1: 1000, p2: 1000, p3: 10 });
    engine.presentNextCard('ROOM01');
    engine.processBid('ROOM01', 'p1', 15);
    engine.resolveCard('ROOM01');
    engine.setWaitingForReady('ROOM01');

    const watching = engine.setPlayerReady('ROOM01', 'p3');
    assert.equal(watching.spectating, true);
    assert.equal(watching.allReady, false);

    engine.setOnline('ROOM01', 'p2', false);
    const ready = engine.setPlayerReady('ROOM01', 'p1');
    assert.equal(ready.allReady, true);
    assert.equal(ready.totalPlayers, 1);

    const extra = engine.setPlayerReady('ROOM01', 'p1');
    assert.equal(extra.allReady, false);
    assert.equal(extra.alreadyAdvancing, true);
    assert.equal(engine.claimAdvance('ROOM01'), false);
  });

  it('moves a reconnected player without giving them a second copy of the auction', () => {
    const engine = new AuctionEngine();
    start(engine);
    engine.presentNextCard('ROOM01');
    engine.processBid('ROOM01', 'p1', 15);
    engine.attachPlayer('ROOM01', 'p1-new', 'p1', 1000);
    const auction = engine.getAuction('ROOM01');
    assert.equal(auction.players.has('p1'), false);
    assert.equal(auction.highestBidder, 'p1-new');
    assert.equal(auction.players.get('p1-new').balance, 1000);
    assert.equal(engine.processBid('ROOM01', 'p1', 20).success, false);
  });

  it('refuses to start a second auction over an active one', () => {
    const engine = new AuctionEngine();
    start(engine);
    assert.equal(engine.startAuction('ROOM01', [card('z')], seats()), null);
    assert.equal(engine.getAuction('ROOM01').deck[0].id, 'a');
  });

  it('drops a leaver from the high bid and can be cleared without a leftover timer', () => {
    const engine = new AuctionEngine();
    start(engine);
    engine.presentNextCard('ROOM01');
    engine.processBid('ROOM01', 'p1', 30);
    engine.processBid('ROOM01', 'p2', 40);
    const detached = engine.detachPlayer('ROOM01', 'p2');
    assert.equal(detached.removed, true);
    assert.equal(engine.getAuction('ROOM01').highestBidder, 'p1');
    assert.equal(engine.getAuction('ROOM01').players.has('p2'), false);
    engine.clearAuction('ROOM01');
    assert.equal(engine.getAuction('ROOM01'), undefined);
  });
});

describe('auction timers', () => {
  it('fires one timeout and ignores a stale timer after it is reset or cleared', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const engine = new AuctionEngine();
      start(engine);
      let calls = 0;
      engine.setTimerCallback('ROOM01', () => { calls += 1; });
      t.mock.timers.tick(30000);
      assert.equal(calls, 0);

      engine.presentNextCard('ROOM01');
      engine.setTimerCallback('ROOM01', () => { calls += 1; });
      t.mock.timers.tick(29999);
      assert.equal(calls, 0);
      engine.getAuction('ROOM01').timerDuration = 15000;
      engine.setTimerCallback('ROOM01');
      t.mock.timers.tick(14999);
      assert.equal(calls, 0);
      t.mock.timers.tick(1);
      assert.equal(calls, 1);
      t.mock.timers.tick(60000);
      assert.equal(calls, 1);

      engine.presentNextCard('ROOM01');
      engine.setTimerCallback('ROOM01', () => { calls += 1; });
      engine.resolveCard('ROOM01');
      t.mock.timers.tick(60000);
      assert.equal(calls, 1);
    } finally {
      t.mock.timers.reset();
    }
  });

  it('runs one scheduled transition when the same step is queued twice', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const engine = new AuctionEngine();
      start(engine);
      let calls = 0;
      engine.scheduleTransition('ROOM01', 'next-card', 1000, () => { calls += 1; });
      engine.scheduleTransition('ROOM01', 'next-card', 1000, () => { calls += 1; });
      t.mock.timers.tick(1000);
      assert.equal(calls, 1);

      engine.scheduleTransition('ROOM01', 'ready-prompt', 2000, () => { calls += 1; });
      engine.clearTransitions('ROOM01');
      t.mock.timers.tick(5000);
      assert.equal(calls, 1);
    } finally {
      t.mock.timers.reset();
    }
  });

  it('reports armed clocks and forgets them when the auction is cleared', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const engine = new AuctionEngine();
      start(engine);
      engine.presentNextCard('ROOM01');
      engine.setTimerCallback('ROOM01', () => {});
      engine.scheduleTransition('ROOM01', 'next', 1000, () => {});
      assert.deepEqual(engine.runtimeTimers(), {
        auctions: 1,
        biddingTimers: 1,
        transitionTimers: 1
      });
      engine.clearTimer('ROOM01');
      assert.equal(engine.runtimeTimers().biddingTimers, 0);
      assert.equal(engine.runtimeTimers().transitionTimers, 1);
      engine.clearAuction('ROOM01');
      assert.deepEqual(engine.runtimeTimers(), {
        auctions: 0,
        biddingTimers: 0,
        transitionTimers: 0
      });
    } finally {
      t.mock.timers.reset();
    }
  });

  it('allows a forced resolve only after the timer or an all-pass', () => {
    const engine = new AuctionEngine();
    start(engine, 'ROOM01', [card('a')], { p1: 1000 });
    engine.presentNextCard('ROOM01');
    assert.equal(engine.canForceResolve('ROOM01'), false);
    engine.getAuction('ROOM01').timerStarted = Date.now() - 30000;
    assert.equal(engine.canForceResolve('ROOM01'), true);
  });
});
