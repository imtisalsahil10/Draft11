/**
 * Restarts the real server against an isolated local-test room file.
 * The developer store in data/local-test-rooms is never the file under test.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
  ask,
  connectClient,
  loadIo,
  sleep,
  startLiveServer,
  stopLiveServer
} from './support/live-server.js';
import {
  assertNotDeveloperStore,
  createIsolatedRoomFile,
  developerRoomFile,
  roomCodes
} from './support/isolated-rooms.js';

function scoreOf(results) {
  const match = results?.matches?.[0];
  assert.ok(match, 'missing match');
  return `${match.team1.username} ${match.team1.goals}-${match.team2.goals} ${match.team2.username}`;
}

async function savedRoom(file, code, predicate, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 8000) {
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const doc = (Array.isArray(parsed) ? parsed : []).find((item) => item.code === code);
        last = doc || null;
        if (doc && predicate(doc)) return doc;
      } catch {
        // The writer replaces the file with a rename.
      }
    }
    await sleep(50);
  }
  throw new Error(`${label}. Last phase: ${last?.phase || 'missing'}`);
}

async function join(io, url, username, roomCode, seatToken) {
  const client = await connectClient(io, url);
  const response = await ask(client.socket, 'room:join', {
    username,
    roomCode,
    ...(seatToken ? { seatToken } : {})
  });
  assert.equal(response.success, true, response.message || JSON.stringify(response));
  client.username = username;
  client.seatToken = response.seatToken;
  return { client, response };
}

async function boot(options) {
  return startLiveServer(options);
}

describe('local test room recovery', () => {
  it('rejects the developer room file as a test store', () => {
    assert.throws(() => assertNotDeveloperStore(developerRoomFile()), /developer local-test storage/);
  });

  it('restores a waiting room, the same card, and the open bid after a restart', async () => {
    const store = createIsolatedRoomFile();
    const developer = developerRoomFile();
    const options = { port: 3108, cardLimit: 2, roomFile: store.file };
    let server;
    let io;
    const clients = [];
    try {
      io = await loadIo();
      server = await boot(options);
      assert.notEqual(server.roomFile, developer);

      const created = await fetch(`${server.url}/api/room/create`, { method: 'POST' });
      const room = await created.json();
      assert.equal(room.success, true, JSON.stringify(room));
      assert.equal(room.auctionPool, undefined);
      const code = room.roomCode;

      const ada = await join(io, server.url, 'ada', code);
      clients.push(ada.client);
      await savedRoom(store.file, code, (doc) => doc.phase === 'not-started' && doc.state.seats.length === 1, 'waiting room was not saved');

      ada.client.socket.disconnect();
      await stopLiveServer(server.child);
      server = await boot(options);
      const adaAgain = await join(io, server.url, 'ada', code, ada.client.seatToken);
      clients.push(adaAgain.client);
      assert.equal(adaAgain.response.balance, 1000);
      assert.equal(adaAgain.response.auctionPool, undefined);
      const waiting = await (await fetch(`${server.url}/api/room/${code}`)).json();
      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.players.length, 1);

      const bea = await join(io, server.url, 'bea', code);
      clients.push(bea.client);
      const started = await ask(adaAgain.client.socket, 'room:start-auction', {});
      assert.equal(started.success, true, started.message || started.error);
      const live = await ask(adaAgain.client.socket, 'auction:sync');
      assert.equal(live.state.phase, 'bidding');
      const cardId = live.state.card.id;
      await savedRoom(store.file, code, (doc) => doc.state.auction.currentCardId === cardId, 'open card was not saved');

      for (const client of clients) client.socket.disconnect();
      clients.length = 0;
      await stopLiveServer(server.child);
      server = await boot(options);
      const adaCard = await join(io, server.url, 'ada', code, ada.client.seatToken);
      const beaCard = await join(io, server.url, 'bea', code, bea.client.seatToken);
      clients.push(adaCard.client, beaCard.client);
      const sameCard = await ask(adaCard.client.socket, 'auction:sync');
      assert.equal(sameCard.state.phase, 'bidding');
      assert.equal(sameCard.state.card.id, cardId);
      const beaView = await ask(beaCard.client.socket, 'auction:sync');
      assert.equal(beaView.state.card.id, cardId);

      const bid = await ask(adaCard.client.socket, 'auction:bid', { bidAmount: sameCard.state.minimumBid });
      assert.equal(bid.success, true, bid.message || JSON.stringify(bid));
      await savedRoom(
        store.file,
        code,
        (doc) => doc.state.auction.highestBid === sameCard.state.minimumBid && doc.state.auction.currentCardId === cardId,
        'bid was not saved'
      );

      for (const client of clients) client.socket.disconnect();
      clients.length = 0;
      await stopLiveServer(server.child);
      server = await boot(options);
      const adaBid = await join(io, server.url, 'ada', code, ada.client.seatToken);
      clients.push(adaBid.client);
      const restoredBid = await ask(adaBid.client.socket, 'auction:sync');
      assert.equal(restoredBid.state.card.id, cardId);
      assert.equal(restoredBid.state.highestBid, sameCard.state.minimumBid);
      assert.equal(restoredBid.state.yourBalance, 1000);
      assert.equal(restoredBid.state.yourCards.length, 0);

      const liveCards = await (await fetch(`${server.url}/api/cards`)).json();
      assert.equal(liveCards.count, 1009);
      assert.equal(liveCards.source, 'image-catalogue');
      assert.equal(liveCards.cards.every((card) => String(card.id).startsWith('fut23_')), true);
      const removed = await fetch(`${server.url}/api/local-test-auction`);
      assert.equal(removed.status, 404);
      assert.equal(roomCodes(developer).includes(code), false);
    } finally {
      for (const client of clients) client.socket.disconnect();
      await stopLiveServer(server?.child);
      store.cleanup();
    }
  });

  it('restores a finished auction, both squads, and the same match once', { timeout: 180000 }, async () => {
    const store = createIsolatedRoomFile();
    const developer = developerRoomFile();
    const options = {
      port: 3109,
      cardLimit: 22,
      roomFile: store.file,
      env: { AUCTION_TIMER_MS: '500', AUCTION_GAP_MS: '50' }
    };
    let server;
    let io;
    const clients = [];
    try {
      io = await loadIo();
      server = await boot(options);
      const created = await fetch(`${server.url}/api/room/create`, { method: 'POST' });
      const room = await created.json();
      assert.equal(room.success, true, JSON.stringify(room));
      const code = room.roomCode;
      const ada = await join(io, server.url, 'ada', code);
      const bea = await join(io, server.url, 'bea', code);
      clients.push(ada.client, bea.client);
      const started = await ask(ada.client.socket, 'room:start-auction', {});
      assert.equal(started.success, true, started.message || started.error);

      const seats = [ada, bea];
      let turn = 0;
      for (let guard = 0; guard < 80; guard += 1) {
        const sync = await ask(ada.client.socket, 'auction:sync');
        if (sync.state?.phase === 'finished') break;
        if (sync.state?.phase === 'bidding') {
          const buyer = seats[turn % seats.length];
          turn += 1;
          const bid = await ask(buyer.client.socket, 'auction:bid', { bidAmount: sync.state.minimumBid });
          assert.equal(bid.success, true, bid.message || JSON.stringify(bid));
          await sleep(800);
          continue;
        }
        if (sync.state?.phase === 'waiting-for-ready') {
          for (const seat of seats) await ask(seat.client.socket, 'auction:player-ready', {});
          await sleep(200);
          continue;
        }
        await sleep(100);
        if (guard === 79) assert.equal(sync.state?.phase, 'finished');
      }

      const finished = await ask(ada.client.socket, 'auction:sync');
      assert.equal(finished.state.phase, 'finished');
      const adaCards = finished.state.yourCards.length;
      const beaFinished = await ask(bea.client.socket, 'auction:sync');
      assert.equal(adaCards + beaFinished.state.yourCards.length, 22);
      assert.equal(adaCards, 11);
      assert.equal(beaFinished.state.yourCards.length, 11);
      await savedRoom(store.file, code, (doc) => doc.phase === 'finished', 'finished auction was not saved');

      for (const client of clients) client.socket.disconnect();
      clients.length = 0;
      await stopLiveServer(server.child);
      server = await boot(options);
      const adaDone = await join(io, server.url, 'ada', code, ada.client.seatToken);
      const beaDone = await join(io, server.url, 'bea', code, bea.client.seatToken);
      clients.push(adaDone.client, beaDone.client);
      const restoredAda = await ask(adaDone.client.socket, 'auction:sync');
      const restoredBea = await ask(beaDone.client.socket, 'auction:sync');
      assert.equal(restoredAda.state.phase, 'finished');
      assert.equal(restoredAda.state.yourCards.length, 11);
      assert.equal(restoredBea.state.yourCards.length, 11);

      const adaSquad = await ask(adaDone.client.socket, 'team:auto-build', { formation: '4-3-3' });
      const beaSquad = await ask(beaDone.client.socket, 'team:auto-build', { formation: '4-3-3' });
      assert.equal(adaSquad.success, true, adaSquad.message || adaSquad.error);
      assert.equal(beaSquad.success, true, beaSquad.message || beaSquad.error);
      assert.equal(adaSquad.lineup.confirmed, true);
      assert.equal(beaSquad.lineup.confirmed, true);
      await savedRoom(
        store.file,
        code,
        (doc) => doc.state.seats.every((seat) => seat.teamBuilt && seat.lineup?.confirmed),
        'confirmed squads were not saved'
      );

      for (const client of clients) client.socket.disconnect();
      clients.length = 0;
      await stopLiveServer(server.child);
      server = await boot(options);
      const adaSquadRestart = await join(io, server.url, 'ada', code, ada.client.seatToken);
      const beaSquadRestart = await join(io, server.url, 'bea', code, bea.client.seatToken);
      clients.push(adaSquadRestart.client, beaSquadRestart.client);
      const adaLineup = await ask(adaSquadRestart.client.socket, 'auction:sync');
      const beaLineup = await ask(beaSquadRestart.client.socket, 'auction:sync');
      assert.equal(adaLineup.state.lineup.confirmed, true);
      assert.equal(beaLineup.state.lineup.confirmed, true);
      assert.equal(adaLineup.state.yourCards.length, 11);
      assert.equal(beaLineup.state.yourCards.length, 11);

      const first = await ask(adaSquadRestart.client.socket, 'match:start', {});
      assert.equal(first.success, true, first.error || first.message);
      assert.equal(first.alreadyRecorded, false);
      const repeat = await ask(beaSquadRestart.client.socket, 'match:start', {});
      assert.equal(repeat.alreadyRecorded, true);
      const score = scoreOf(first.results);
      assert.equal(scoreOf(repeat.results), score);
      await savedRoom(store.file, code, (doc) => scoreOf(doc.state.matchResults) === score, 'match was not saved');

      for (const client of clients) client.socket.disconnect();
      clients.length = 0;
      await stopLiveServer(server.child);
      server = await boot(options);
      const adaMatch = await join(io, server.url, 'ada', code, ada.client.seatToken);
      const beaMatch = await join(io, server.url, 'bea', code, bea.client.seatToken);
      clients.push(adaMatch.client, beaMatch.client);
      const restoredMatch = await ask(adaMatch.client.socket, 'auction:sync');
      assert.equal(scoreOf(restoredMatch.state.match), score);
      const again = await ask(beaMatch.client.socket, 'match:start', {});
      assert.equal(again.alreadyRecorded, true);
      assert.equal(scoreOf(again.results), score);

      const beaCards = (await ask(beaMatch.client.socket, 'auction:sync')).state.yourCards.length;
      const left = await ask(adaMatch.client.socket, 'room:leave', {});
      assert.equal(left.success, true);
      const afterLeave = await ask(beaMatch.client.socket, 'auction:sync');
      assert.equal(afterLeave.state.departed[0].username, 'ada');
      assert.equal(afterLeave.state.departed[0].squadStatus, 'preserved');
      assert.equal(afterLeave.state.departed[0].cardCount, 11);
      assert.equal(afterLeave.state.yourCards.length, beaCards);
      assert.equal(scoreOf(afterLeave.state.match), score);

      const liveCards = await (await fetch(`${server.url}/api/cards`)).json();
      assert.equal(liveCards.count, 1009);
      assert.equal(liveCards.cards.every((card) => /^fut23_/.test(String(card.id)) && card.imageCatalogue === true), true);
      assert.equal(roomCodes(developer).includes(code), false);
    } finally {
      for (const client of clients) client.socket.disconnect();
      await stopLiveServer(server?.child);
      store.cleanup();
    }
  });
});
