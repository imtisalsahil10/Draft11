/**
 * Concurrent rooms on one live server.
 * Joins, auction starts, bids, resolves, and membership changes are issued
 * together across rooms. The checks compare each room with the others.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GAME_CONFIG } from '../constants.js';
import {
  ask,
  connectClient,
  createRooms,
  healthLatency,
  inParallel,
  loadIo,
  percentile,
  runtimeDiagnostics,
  sleep,
  startLiveServer,
  stopLiveServer
} from './support/live-server.js';

const ROOM_COUNT = 12;
const SEATS = 3;
const BALANCE = GAME_CONFIG.INITIAL_BALANCE;
const BID_ROOMS = new Set([0, 1, 3, 8, 10]);
const RAISE_ROOMS = new Set([0, 8]);
const DISCARD_ROOM = 2;
const LEAVE_ROOM = 4;
const DISCONNECT_ROOM = 5;
const RECONNECT_ROOM = 6;
const READY_ROOM = 7;
const QUIET_ROOMS = [9, 11];

function lastEvent(client, name) {
  for (let index = client.events.length - 1; index >= 0; index -= 1) {
    if (client.events[index].name === name) return client.events[index].payload;
  }
  return null;
}

function countEvents(client, name) {
  return client.events.filter((event) => event.name === name).length;
}

function tally(client) {
  const counts = {};
  for (const event of client.events) counts[event.name] = (counts[event.name] || 0) + 1;
  return counts;
}

function seatedNames(room) {
  return room.clients.filter((client) => client.seated).map((client) => client.username).sort();
}

function stringsOf(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) stringsOf(item, found);
  }
  return found;
}

function roomTokens(room) {
  const tokens = new Set([room.code]);
  for (const client of [...room.clients, ...room.retired]) {
    if (client.username) tokens.add(client.username);
    if (client.playerId) tokens.add(client.playerId);
    if (client.seatToken) tokens.add(client.seatToken);
    for (const id of client.previousIds || []) tokens.add(id);
  }
  return tokens;
}

function assertIsolated(rooms) {
  const tokenSets = rooms.map(roomTokens);
  rooms.forEach((room, index) => {
    const forbidden = new Set();
    tokenSets.forEach((tokens, other) => {
      if (other === index) return;
      for (const token of tokens) forbidden.add(token);
    });
    const seen = [...room.clients, ...room.retired];
    for (const client of seen) {
      const hits = [];
      for (const event of client.events) {
        for (const text of stringsOf(event.payload)) {
          if (forbidden.has(text)) hits.push(`${event.name}:${text}`);
        }
      }
      for (const payload of client.payloads || []) {
        for (const text of stringsOf(payload)) {
          if (forbidden.has(text)) hits.push(`payload:${text}`);
        }
      }
      assert.equal(hits.length, 0, `${client.username} in ${room.code} saw ${hits.slice(0, 6).join(', ')}`);
    }
    for (const payload of room.extraPayloads || []) {
      const hits = stringsOf(payload).filter((text) => forbidden.has(text));
      assert.equal(hits.length, 0, `${room.code} room payload leaked ${hits.slice(0, 6).join(', ')}`);
    }
  });
}

function stampSpread(logs, marker) {
  const stamps = [];
  for (const line of logs) {
    if (!line.includes(marker)) continue;
    const match = line.match(/^\[([^\]]+)\]/);
    if (!match) continue;
    const parsed = Date.parse(match[1]);
    if (Number.isFinite(parsed)) stamps.push(parsed);
  }
  if (stamps.length < 2) return { count: stamps.length, spreadMs: 0 };
  return { count: stamps.length, spreadMs: Math.max(...stamps) - Math.min(...stamps) };
}

async function syncRoom(room) {
  const connected = room.clients.filter((client) => client.seated && client.socket.connected);
  assert.ok(connected.length > 0, `${room.code} has no connected client`);
  const snaps = await Promise.all(connected.map(async (client) => {
    const response = await ask(client.socket, 'auction:sync', {});
    assert.equal(response.success, true, `${client.username} ${JSON.stringify(response)}`);
    client.payloads.push(response);
    return { client, response };
  }));
  const first = snaps[0].response;
  for (const snap of snaps) {
    assert.equal(snap.response.state?.card?.id ?? null, first.state?.card?.id ?? null, room.code);
    assert.equal(snap.response.state?.phase, first.state?.phase, room.code);
    assert.deepEqual(
      (snap.response.state?.bids || []).map((bid) => [bid.playerUsername, bid.bidAmount]),
      (first.state?.bids || []).map((bid) => [bid.playerUsername, bid.bidAmount]),
      room.code
    );
    assert.deepEqual(
      snap.response.players.map((player) => player.username).sort(),
      seatedNames(room),
      room.code
    );
    const gap = Math.abs((snap.response.state?.secondsRemaining || 0) - (first.state?.secondsRemaining || 0));
    assert.ok(gap <= 2, `${room.code} clients disagree about the timer`);
  }
  return snaps;
}

function stableSignature(snaps) {
  const response = snaps[0].response;
  return {
    phase: response.state?.phase ?? null,
    cardId: response.state?.card?.id ?? null,
    bids: (response.state?.bids || []).map((bid) => [bid.playerUsername, bid.bidAmount]),
    players: response.players
      .map((player) => [player.username, player.id, player.balance, player.teamSize, player.isOnline])
      .sort()
  };
}

async function placeBid(room, client, amount, latencies) {
  const started = Date.now();
  const result = await ask(client.socket, 'auction:bid', { bidAmount: amount });
  latencies.push(Date.now() - started);
  assert.equal(result.success, true, `${room.code} ${client.username} ${result.message || result.error || JSON.stringify(result)}`);
  return result;
}

async function skipAll(room) {
  const resolved = room.clients[0].waitFor('auction:card-result', () => true, 10000, `${room.code} discard`);
  const acks = await Promise.all(room.clients.map((client) => ask(client.socket, 'auction:skip', {})));
  for (const ack of acks) {
    assert.equal(ack.success, true, `${room.code} skip ${ack.message || ack.error || JSON.stringify(ack)}`);
  }
  return resolved;
}

async function leaveOne(room) {
  const leaver = room.clients[2];
  const watcher = room.clients[0];
  const left = watcher.waitFor(
    'room:player-left',
    (payload) => payload?.playerId === leaver.playerId,
    10000,
    `${room.code} leave`
  );
  leaver.socket.emit('room:leave');
  leaver.seated = false;
  const payload = await left;
  assert.equal(payload.remainingPlayers, SEATS - 1);
  assert.equal(payload.players.some((player) => player.username === leaver.username), false);
}

async function disconnectOne(room) {
  const leaver = room.clients[2];
  const watcher = room.clients[0];
  const updated = watcher.waitFor('room:players-updated', (payload) => {
    const seat = payload?.players?.find((player) => player.username === leaver.username);
    return Boolean(seat && seat.isOnline === false);
  }, 10000, `${room.code} disconnect`);
  leaver.socket.disconnect();
  await updated;
}

async function reconnectSeat(room, seat, io, url) {
  const previousIds = [...(seat.previousIds || [])];
  if (seat.playerId) previousIds.push(seat.playerId);
  if (seat.socket.connected) seat.socket.disconnect();
  const next = await connectClient(io, url);
  const joined = await ask(next.socket, 'room:join', {
    username: seat.username,
    roomCode: room.code,
    seatToken: seat.seatToken
  });
  assert.equal(joined.success, true, `${seat.username} reconnect ${joined.message || JSON.stringify(joined)}`);
  assert.equal(joined.roomCode, room.code);
  assert.equal(joined.balance, BALANCE);
  assert.notEqual(joined.playerId, seat.playerId);
  next.username = seat.username;
  next.playerId = joined.playerId;
  next.seatToken = joined.seatToken;
  next.previousIds = previousIds;
  next.seated = true;
  next.payloads.push(joined);
  room.retired.push(seat);
  return next;
}

async function readyAll(room) {
  const beforeIndex = lastEvent(room.clients[0], 'auction:card-presented').currentIndex;
  await skipAll(room);
  const nextCard = room.clients[0].waitFor(
    'auction:card-presented',
    (payload) => payload.currentIndex > beforeIndex,
    10000,
    `${room.code} next card`
  );
  const acks = await Promise.all(room.clients.map((client) => ask(client.socket, 'auction:player-ready', {})));
  for (const ack of acks) {
    assert.equal(ack.success, true, `${room.code} ready ${ack.message || ack.error || JSON.stringify(ack)}`);
  }
  return nextCard;
}

async function waitForQuiet(url) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 8000) {
    last = await runtimeDiagnostics(url);
    if (last.auctions === 0 && last.biddingTimers === 0 && last.transitionTimers === 0) return last;
    await sleep(100);
  }
  return last;
}

describe('multi-room concurrency', () => {
  let server;

  before(async () => {
    server = await startLiveServer({ port: 3101, cardLimit: 4 });
  });

  after(async () => {
    await stopLiveServer(server?.child);
  });

  it('isolates auctions, seats, and timers across rooms that act together', { timeout: 120000 }, async () => {
    const summary = {
      rooms: ROOM_COUNT,
      clientsPerRoom: SEATS,
      clients: ROOM_COUNT * SEATS
    };
    const rooms = [];
    const bidLatencies = [];
    let io;
    try {
      io = await loadIo();
      const created = await createRooms(server.url, ROOM_COUNT);
      assert.equal(created.maxInFlight, ROOM_COUNT);
      assert.equal(created.codes.length, ROOM_COUNT);
      summary.createInFlight = created.maxInFlight;
      summary.createSpreadMs = Math.max(...created.spans.map((span) => span.end)) - Math.min(...created.spans.map((span) => span.start));

      for (let index = 0; index < created.codes.length; index += 1) {
        rooms.push({
          index,
          code: created.codes[index],
          clients: [],
          retired: [],
          extraPayloads: [],
          openingBid: null,
          price: null,
          cardId: null
        });
      }

      await runtimeDiagnostics(server.url, { reset: true });
      const joined = await inParallel(rooms.flatMap((room) => (
        Array.from({ length: SEATS }, (_, seat) => ({ room, seat }))
      )), async ({ room, seat }) => {
        const client = await connectClient(io, server.url);
        const username = `u${String(room.index).padStart(2, '0')}s${seat}`;
        const response = await ask(client.socket, 'room:join', { username, roomCode: room.code });
        assert.equal(response.success, true, `${username} ${response.message || JSON.stringify(response)}`);
        assert.equal(response.roomCode, room.code);
        assert.equal(response.balance, BALANCE);
        client.username = username;
        client.playerId = response.playerId;
        client.seatToken = response.seatToken;
        client.seated = true;
        client.payloads.push(response);
        return { room, seat, client };
      });
      assert.equal(joined.maxInFlight, ROOM_COUNT * SEATS);
      summary.joinInFlight = joined.maxInFlight;
      for (const span of joined.spans) {
        span.value.room.clients[span.value.seat] = span.value.client;
      }
      const joinPeak = await runtimeDiagnostics(server.url, { reset: true });
      summary.joinServerMaxInFlight = joinPeak.concurrency.maxInFlight;
      summary.joinHandlersEntered = joinPeak.concurrency.entered;
      assert.equal(joinPeak.concurrency.entered, ROOM_COUNT * SEATS);

      for (const room of rooms) {
        assert.equal(room.clients.length, SEATS);
        assert.equal(new Set(room.clients.map((client) => client.playerId)).size, SEATS);
      }

      const started = await inParallel(rooms, async (room) => {
        const response = await ask(room.clients[0].socket, 'room:start-auction', {});
        assert.equal(response.success, true, `${room.code} ${response.error || response.message || ''}`);
        return response;
      });
      assert.equal(started.maxInFlight, ROOM_COUNT);
      summary.startInFlight = started.maxInFlight;
      summary.startSpreadMs = Math.max(...started.spans.map((span) => span.end)) - Math.min(...started.spans.map((span) => span.start));
      summary.startServerMaxInFlight = (await runtimeDiagnostics(server.url, { reset: true })).concurrency.maxInFlight;
      const serverStarts = stampSpread(server.logs, 'Auction started for room');
      summary.serverStartCount = serverStarts.count;
      summary.serverStartSpreadMs = serverStarts.spreadMs;
      assert.equal(serverStarts.count, ROOM_COUNT);
      assert.ok(summary.serverStartSpreadMs < 5000, `auction starts spread over ${summary.serverStartSpreadMs}ms`);
      assert.ok(summary.startSpreadMs < 5000, `client start spread ${summary.startSpreadMs}ms`);

      await Promise.all(rooms.flatMap((room) => room.clients.map((client) => (
        client.waitFor('auction:card-presented', () => true, 15000, `${client.username} card`)
      ))));

      const bidRooms = rooms.filter((room) => BID_ROOMS.has(room.index));
      const idleRooms = rooms.filter((room) => !BID_ROOMS.has(room.index));
      const firstBids = await inParallel(bidRooms, async (room) => {
        const presented = lastEvent(room.clients[0], 'auction:card-presented');
        assert.ok(presented?.card?.id, `${room.code} has no card`);
        room.cardId = presented.card.id;
        room.openingBid = presented.minimumBid;
        const result = await placeBid(room, room.clients[0], presented.minimumBid, bidLatencies);
        room.price = result.bidAmount;
        room.nextMinimum = result.minimumBid;
        return result;
      });
      assert.equal(firstBids.maxInFlight, bidRooms.length);
      summary.bidInFlight = firstBids.maxInFlight;

      const raiseRooms = rooms.filter((room) => RAISE_ROOMS.has(room.index));
      const raised = await inParallel(raiseRooms, async (room) => {
        const result = await placeBid(room, room.clients[1], room.nextMinimum, bidLatencies);
        room.price = result.bidAmount;
        assert.ok(room.price > room.openingBid, `${room.code} raise did not increase the price`);
        return result;
      });
      assert.equal(raised.maxInFlight, raiseRooms.length);
      summary.raiseInFlight = raised.maxInFlight;
      const bidPeak = await runtimeDiagnostics(server.url);
      summary.bidServerMaxInFlight = bidPeak.concurrency.maxInFlight;
      summary.bidHandlersEntered = bidPeak.concurrency.entered;
      assert.equal(bidPeak.concurrency.entered, bidRooms.length + raiseRooms.length);
      summary.bidP50Ms = percentile(bidLatencies, 50);
      summary.bidP95Ms = percentile(bidLatencies, 95);
      summary.bidMaxMs = percentile(bidLatencies, 100);

      for (const room of rooms) {
        const presented = lastEvent(room.clients[0], 'auction:card-presented');
        if (!BID_ROOMS.has(room.index)) room.cardId = presented.card.id;
        const expectedBids = RAISE_ROOMS.has(room.index) ? 2 : BID_ROOMS.has(room.index) ? 1 : 0;
        for (const client of room.clients) {
          assert.equal(countEvents(client, 'auction:bid-received'), expectedBids, client.username);
        }
      }

      const duringBids = await Promise.all(rooms.map(async (room) => ({ room, snaps: await syncRoom(room) })));
      const bidSeconds = [];
      const idleSeconds = [];
      for (const entry of duringBids) {
        const state = entry.snaps[0].response.state;
        assert.equal(state.phase, 'bidding', entry.room.code);
        assert.equal(state.card.id, entry.room.cardId, entry.room.code);
        const names = new Set(entry.room.clients.map((client) => client.username));
        for (const bid of state.bids || []) assert.ok(names.has(bid.playerUsername), bid.playerUsername);
        for (const player of entry.snaps[0].response.players) {
          assert.equal(player.balance, BALANCE, player.username);
          assert.equal(player.teamSize, 0, player.username);
        }
        if (RAISE_ROOMS.has(entry.room.index)) {
          assert.deepEqual(
            state.bids.map((bid) => [bid.playerUsername, bid.bidAmount]),
            [
              [entry.room.clients[1].username, entry.room.price],
              [entry.room.clients[0].username, entry.room.openingBid]
            ]
          );
        } else if (BID_ROOMS.has(entry.room.index)) {
          assert.deepEqual(state.bids.map((bid) => [bid.playerUsername, bid.bidAmount]), [
            [entry.room.clients[0].username, entry.room.price]
          ]);
        } else {
          assert.equal(state.bids.length, 0, entry.room.code);
          assert.equal(state.highestBid, 0, entry.room.code);
        }
        if (BID_ROOMS.has(entry.room.index)) {
          assert.equal(state.highestBid, entry.room.price, entry.room.code);
          bidSeconds.push(state.secondsRemaining);
        } else {
          idleSeconds.push(state.secondsRemaining);
        }
      }
      summary.bidTimerSeconds = bidSeconds;
      summary.idleTimerSeconds = idleSeconds;
      assert.ok(Math.max(...bidSeconds) <= 16, `bid timers ${bidSeconds.join(',')}`);
      assert.ok(Math.min(...idleSeconds) >= 20, `idle timers ${idleSeconds.join(',')}`);
      assert.ok(Math.min(...idleSeconds) > Math.max(...bidSeconds));
      assertIsolated(rooms);

      const saleWaits = bidRooms.map((room) => room.clients[0].waitFor(
        'auction:card-result',
        () => true,
        25000,
        `${room.code} sale`
      ));
      const discarded = await skipAll(rooms[DISCARD_ROOM]);
      assert.equal(discarded.status, 'discarded');
      assert.equal(discarded.winnerId, null);
      assert.equal(discarded.cardId, rooms[DISCARD_ROOM].cardId);
      for (const room of bidRooms) {
        assert.equal(countEvents(room.clients[0], 'auction:card-result'), 0, `${room.code} resolved with the discard room`);
      }
      for (const room of idleRooms) {
        if (room.index === DISCARD_ROOM) continue;
        assert.equal(countEvents(room.clients[0], 'auction:card-result'), 0, `${room.code} saw a card result`);
      }

      const discardSnaps = await syncRoom(rooms[DISCARD_ROOM]);
      assert.equal(discardSnaps[0].response.state.phase, 'waiting-for-ready');
      for (const snap of discardSnaps) {
        assert.equal(snap.response.state.yourBalance, BALANCE);
        assert.equal(snap.response.state.yourCards.length, 0);
      }
      for (const player of discardSnaps[0].response.players) {
        assert.equal(player.balance, BALANCE);
        assert.equal(player.teamSize, 0);
      }

      const sales = await Promise.all(saleWaits);
      sales.forEach((result, index) => {
        const room = bidRooms[index];
        const bidderName = RAISE_ROOMS.has(room.index) ? room.clients[1].username : room.clients[0].username;
        assert.equal(result.status, 'awarded', room.code);
        assert.equal(result.winnerUsername, bidderName, room.code);
        assert.equal(result.finalPrice, room.price, room.code);
        assert.equal(result.cardId, room.cardId, room.code);
        room.winnerUsername = bidderName;
      });

      for (const room of bidRooms) {
        const snaps = await syncRoom(room);
        for (const snap of snaps) {
          const ownsCard = snap.client.username === room.winnerUsername;
          assert.equal(snap.response.state.yourBalance, ownsCard ? BALANCE - room.price : BALANCE, snap.client.username);
          assert.equal(snap.response.state.yourCards.length, ownsCard ? 1 : 0, snap.client.username);
          if (ownsCard) assert.equal(snap.response.state.yourCards[0].id, room.cardId);
        }
        const listed = snaps[0].response.players.find((player) => player.username === room.winnerUsername);
        assert.equal(listed.balance, BALANCE - room.price);
        assert.equal(listed.teamSize, 1);
        const others = snaps[0].response.players.filter((player) => player.username !== room.winnerUsername);
        for (const player of others) {
          assert.equal(player.balance, BALANCE, player.username);
          assert.equal(player.teamSize, 0, player.username);
        }
      }

      for (const room of idleRooms) {
        const snaps = await syncRoom(room);
        const state = snaps[0].response.state;
        if (room.index === DISCARD_ROOM) {
          assert.equal(state.phase, 'waiting-for-ready');
        } else {
          assert.equal(state.phase, 'bidding', room.code);
          assert.equal(state.card.id, room.cardId, room.code);
          assert.equal(countEvents(room.clients[0], 'auction:card-result'), 0, room.code);
        }
        for (const player of snaps[0].response.players) {
          assert.equal(player.balance, BALANCE, `${room.code} ${player.username}`);
          assert.equal(player.teamSize, 0, `${room.code} ${player.username}`);
        }
        for (const snap of snaps) {
          assert.equal(snap.response.state.yourCards.length, 0, snap.client.username);
          assert.equal(snap.response.state.yourBalance, BALANCE, snap.client.username);
        }
      }
      assertIsolated(rooms);
      summary.sales = bidRooms.map((room) => ({
        room: room.code,
        winner: room.winnerUsername,
        price: room.price,
        cardId: room.cardId
      }));
      summary.discardedRoom = rooms[DISCARD_ROOM].code;

      const untouched = [0, 1, 2, 3, 8, 9, 10, 11].map((index) => rooms[index]);
      const beforeActions = new Map();
      for (const room of untouched) beforeActions.set(room.index, stableSignature(await syncRoom(room)));
      const cardBefore = new Map(rooms.map((room) => [room.index, lastEvent(room.clients[0], 'auction:card-presented').card.id]));
      const countsBefore = rooms.map((room) => room.clients.map((client) => tally(client)));
      const quietBefore = await syncRoom(rooms[QUIET_ROOMS[0]]);
      assert.ok(
        quietBefore[0].response.state.secondsRemaining > 8,
        `idle timer too low before membership actions (${quietBefore[0].response.state.secondsRemaining}s)`
      );

      const actions = await inParallel([
        () => leaveOne(rooms[LEAVE_ROOM]),
        () => disconnectOne(rooms[DISCONNECT_ROOM]),
        async () => {
          const room = rooms[RECONNECT_ROOM];
          room.clients[1] = await reconnectSeat(room, room.clients[1], io, server.url);
        },
        () => readyAll(rooms[READY_ROOM])
      ], (action) => action());
      assert.equal(actions.maxInFlight, 4);
      summary.actionInFlight = actions.maxInFlight;

      for (const room of untouched) {
        assert.deepEqual(stableSignature(await syncRoom(room)), beforeActions.get(room.index), room.code);
      }

      const left = await syncRoom(rooms[LEAVE_ROOM]);
      assert.equal(left[0].response.players.length, SEATS - 1);
      assert.equal(left[0].response.state.card.id, cardBefore.get(LEAVE_ROOM));
      assert.equal(left[0].response.state.phase, 'bidding');
      assert.equal(left[0].response.players.some((player) => player.username === 'u04s2'), false);

      const dropped = await syncRoom(rooms[DISCONNECT_ROOM]);
      const offline = dropped[0].response.players.find((player) => player.username === 'u05s2');
      assert.equal(offline.isOnline, false);
      assert.equal(dropped[0].response.players.length, SEATS);
      assert.equal(dropped[0].response.state.card.id, cardBefore.get(DISCONNECT_ROOM));
      for (const player of dropped[0].response.players) {
        if (player.username !== 'u05s2') assert.equal(player.isOnline, true, player.username);
        assert.equal(player.balance, BALANCE);
      }

      const returned = await syncRoom(rooms[RECONNECT_ROOM]);
      assert.equal(returned[0].response.players.length, SEATS);
      assert.equal(returned[0].response.state.card.id, cardBefore.get(RECONNECT_ROOM));
      const returnedSeat = returned.find((snap) => snap.client.username === 'u06s1');
      assert.equal(returnedSeat.response.state.yourBalance, BALANCE);
      assert.equal(returnedSeat.response.state.yourCards.length, 0);
      assert.equal(returned[0].response.players.every((player) => player.isOnline === true), true);

      const advanced = await syncRoom(rooms[READY_ROOM]);
      assert.notEqual(advanced[0].response.state.card.id, cardBefore.get(READY_ROOM));
      assert.equal(advanced[0].response.state.phase, 'bidding');
      for (const player of advanced[0].response.players) {
        assert.equal(player.balance, BALANCE, player.username);
        assert.equal(player.teamSize, 0, player.username);
      }

      function grew(roomIndex, clientIndex, name) {
        const before = countsBefore[roomIndex][clientIndex][name] || 0;
        return countEvents(rooms[roomIndex].clients[clientIndex], name) - before;
      }
      assert.ok(grew(LEAVE_ROOM, 0, 'room:player-left') >= 1);
      assert.ok(grew(READY_ROOM, 0, 'auction:card-result') >= 1);
      assert.ok(grew(READY_ROOM, 0, 'auction:card-presented') >= 1);
      assert.ok(grew(READY_ROOM, 0, 'auction:player-ready-update') >= 1);
      for (const index of [0, 1, 3, 8, 9, 10, 11, DISCARD_ROOM]) {
        assert.equal(grew(index, 0, 'room:player-left'), 0, rooms[index].code);
        assert.equal(grew(index, 0, 'auction:card-result'), 0, rooms[index].code);
        assert.equal(grew(index, 0, 'auction:card-presented'), 0, rooms[index].code);
        assert.equal(grew(index, 0, 'auction:player-ready-update'), 0, rooms[index].code);
      }

      const intruder = await connectClient(io, server.url);
      const denied = await ask(intruder.socket, 'room:join', {
        username: rooms[RECONNECT_ROOM].clients[1].username,
        roomCode: rooms[RECONNECT_ROOM].code,
        seatToken: rooms[QUIET_ROOMS[0]].clients[0].seatToken
      });
      assert.equal(denied.success, false, JSON.stringify(denied));
      intruder.socket.disconnect();
      const stillSeated = await syncRoom(rooms[RECONNECT_ROOM]);
      assert.deepEqual(stillSeated[0].response.players.map((player) => player.username).sort(), seatedNames(rooms[RECONNECT_ROOM]));
      assert.deepEqual(stableSignature(await syncRoom(rooms[QUIET_ROOMS[0]])), beforeActions.get(QUIET_ROOMS[0]));

      const listed = await Promise.all(rooms.map(async (room) => {
        const response = await fetch(`${server.url}/api/room/${room.code}`);
        const body = await response.json();
        assert.equal(response.status, 200, room.code);
        assert.equal(body.code, room.code);
        room.extraPayloads.push(body);
        assert.deepEqual(body.players.map((player) => player.username).sort(), seatedNames(room), room.code);
        return body;
      }));
      const allNames = listed.flatMap((body) => body.players.map((player) => player.username));
      assert.equal(new Set(allNames).size, allNames.length);
      assertIsolated(rooms);

      const beforeCleanup = await runtimeDiagnostics(server.url);
      summary.timersBeforeCleanup = {
        auctions: beforeCleanup.auctions,
        biddingTimers: beforeCleanup.biddingTimers,
        transitionTimers: beforeCleanup.transitionTimers,
        rssMB: Number((beforeCleanup.memory.rss / 1048576).toFixed(1))
      };
      assert.ok(beforeCleanup.auctions >= 1);
      assert.ok(beforeCleanup.biddingTimers >= 1);

      const offlineSeat = rooms[DISCONNECT_ROOM].clients[2];
      rooms[DISCONNECT_ROOM].clients[2] = await reconnectSeat(rooms[DISCONNECT_ROOM], offlineSeat, io, server.url);
      const seatedClients = rooms.flatMap((room) => room.clients).filter((client) => client.seated && client.socket.connected);
      await Promise.all(seatedClients.map(async (client) => {
        client.socket.emit('room:leave');
        client.seated = false;
      }));
      const quiet = await waitForQuiet(server.url);
      summary.timersAfterCleanup = {
        auctions: quiet?.auctions,
        biddingTimers: quiet?.biddingTimers,
        transitionTimers: quiet?.transitionTimers
      };
      assert.equal(quiet.auctions, 0);
      assert.equal(quiet.biddingTimers, 0);
      assert.equal(quiet.transitionTimers, 0);

      await sleep(500);
      const watched = rooms.flatMap((room) => [...room.clients, ...room.retired]);
      const marks = watched.map((client) => ({ client, events: client.events.length }));
      await sleep(2500);
      const stillQuiet = await runtimeDiagnostics(server.url);
      assert.equal(stillQuiet.auctions, 0);
      assert.equal(stillQuiet.biddingTimers, 0);
      assert.equal(stillQuiet.transitionTimers, 0);
      for (const mark of marks) {
        assert.equal(mark.client.events.length, mark.events, `${mark.client.username} received an event after timers were cleared`);
      }

      const health = [];
      for (let sample = 0; sample < 8; sample += 1) health.push(await healthLatency(server.url));
      summary.healthMs = health;
      summary.healthMaxMs = Math.max(...health);
      assert.ok(summary.healthMaxMs < 1000, `health took ${summary.healthMaxMs}ms`);
      summary.failures = [];
    } catch (error) {
      summary.failures = [error.message];
      console.error(server.logs.slice(-50).join('\n'));
      throw error;
    } finally {
      for (const room of rooms) {
        for (const client of [...room.clients, ...room.retired]) client.socket?.disconnect();
      }
      console.log(`DRAFT11_CONCURRENCY ${JSON.stringify(summary)}`);
    }
  });
});
