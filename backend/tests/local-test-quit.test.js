/**
 * Quit Auction on a real server process, using an isolated room file.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ask,
  connectClient,
  loadIo,
  sleep,
  startLiveServer,
  stopLiveServer
} from './support/live-server.js';
import { developerRoomFile, roomCodes } from './support/isolated-rooms.js';

async function join(io, url, username, roomCode, seatToken) {
  const client = await connectClient(io, url);
  const response = await ask(client.socket, 'room:join', {
    username,
    roomCode,
    ...(seatToken ? { seatToken } : {})
  });
  client.username = username;
  client.seatToken = response.seatToken;
  return { client, response };
}

async function createRoom(url) {
  const response = await fetch(`${url}/api/room/create`, { method: 'POST' });
  const body = await response.json();
  assert.equal(body.success, true, JSON.stringify(body));
  assert.equal(body.auctionPool, undefined);
  return body.roomCode;
}

describe('auction quit', () => {
  it('keeps the room when the host leaves the lobby and lets that player open another room', async () => {
    const server = await startLiveServer({ port: 3110, cardLimit: 4 });
    const clients = [];
    try {
      const io = await loadIo();
      const code = await createRoom(server.url);
      const ada = await join(io, server.url, 'ada', code);
      const bea = await join(io, server.url, 'bea', code);
      clients.push(ada.client, bea.client);
      assert.equal(ada.response.success, true);
      assert.equal(bea.response.success, true);

      const left = await ask(ada.client.socket, 'room:leave', { roomCode: code, seatToken: ada.client.seatToken });
      const again = await ask(ada.client.socket, 'room:leave', { roomCode: code, seatToken: ada.client.seatToken });
      assert.equal(left.success, true);
      assert.equal(again.success, true);
      assert.equal(again.alreadyLeft, true);

      const room = await (await fetch(`${server.url}/api/room/${code}`)).json();
      assert.equal(room.players.length, 1);
      assert.equal(room.players[0].username, 'bea');
      assert.equal(room.players[0].isHost, true);
      assert.equal(room.players[0].balance, 1000);
      assert.equal(room.status, 'waiting');

      const other = await createRoom(server.url);
      assert.notEqual(other, code);
      const moved = await join(io, server.url, 'ada', other);
      clients.push(moved.client);
      assert.equal(moved.response.success, true);
      const first = await (await fetch(`${server.url}/api/room/${code}`)).json();
      const second = await (await fetch(`${server.url}/api/room/${other}`)).json();
      assert.equal(first.players.map((player) => player.username).join(), 'bea');
      assert.equal(second.players.map((player) => player.username).join(), 'ada');
      assert.equal(roomCodes(developerRoomFile()).includes(code), false);
      assert.equal(roomCodes(developerRoomFile()).includes(other), false);
    } finally {
      for (const client of clients) client.socket.disconnect();
      await stopLiveServer(server.child);
    }
  });

  it('continues the auction after the host and a winning player leave', { timeout: 120000 }, async () => {
    const server = await startLiveServer({
      port: 3111,
      cardLimit: 4,
      env: { AUCTION_TIMER_MS: '500', AUCTION_GAP_MS: '50' }
    });
    const clients = [];
    try {
      const io = await loadIo();
      const code = await createRoom(server.url);
      const ada = await join(io, server.url, 'ada', code);
      const bea = await join(io, server.url, 'bea', code);
      const cal = await join(io, server.url, 'cal', code);
      clients.push(ada.client, bea.client, cal.client);
      const started = await ask(ada.client.socket, 'room:start-auction', {});
      assert.equal(started.success, true, started.message || started.error);
      const opening = await ask(bea.client.socket, 'auction:sync');
      assert.equal(opening.state.phase, 'bidding');
      const bid = await ask(ada.client.socket, 'auction:bid', { bidAmount: opening.state.minimumBid });
      assert.equal(bid.success, true, bid.message || JSON.stringify(bid));

      const hostLeft = await ask(ada.client.socket, 'room:leave', {});
      assert.equal(hostLeft.success, true);
      const duplicate = await ask(ada.client.socket, 'room:leave', {});
      assert.equal(duplicate.alreadyLeft, true);

      const continuing = await ask(bea.client.socket, 'auction:sync');
      assert.notEqual(continuing.state.phase, 'finished');
      assert.equal(continuing.state.yourBalance, 1000);
      assert.equal(continuing.state.yourCards.length, 0);
      assert.equal(continuing.state.departed.find((seat) => seat.username === 'ada').cardCount, 0);
      assert.equal(continuing.state.departed.find((seat) => seat.username === 'ada').squadStatus, 'abandoned');
      assert.notEqual(continuing.state.highestBidder, ada.client.socket.id);
      const seated = await (await fetch(`${server.url}/api/room/${code}`)).json();
      assert.deepEqual(seated.players.map((player) => player.username).sort(), ['bea', 'cal']);
      assert.equal(seated.players.find((player) => player.username === 'bea').isHost, true);
      assert.equal(seated.players.every((player) => player.balance === 1000), true);

      const rejected = await join(io, server.url, 'ada', code, ada.client.seatToken);
      clients.push(rejected.client);
      assert.equal(rejected.response.success, false);
      assert.match(rejected.response.message, /closed/);

      let won = 0;
      for (let guard = 0; guard < 30 && won < 2; guard += 1) {
        const sync = await ask(bea.client.socket, 'auction:sync');
        if (sync.state?.phase === 'finished') break;
        if (sync.state?.phase === 'bidding') {
          const before = sync.state.yourCards.length;
          const purchase = await ask(bea.client.socket, 'auction:bid', { bidAmount: sync.state.minimumBid });
          assert.equal(purchase.success, true, purchase.message || JSON.stringify(purchase));
          await sleep(800);
          const after = await ask(bea.client.socket, 'auction:sync');
          if (after.state.yourCards.length > before) won += 1;
          continue;
        }
        if (sync.state?.phase === 'waiting-for-ready') {
          await ask(bea.client.socket, 'auction:player-ready', {});
          await ask(cal.client.socket, 'auction:player-ready', {});
          await sleep(200);
          continue;
        }
        await sleep(100);
      }
      assert.equal(won, 2);
      const calBefore = await ask(cal.client.socket, 'auction:sync');
      assert.equal(calBefore.state.yourBalance, 1000);
      assert.equal(calBefore.state.yourCards.length, 0);

      const winnerLeft = await ask(bea.client.socket, 'room:leave', {});
      assert.equal(winnerLeft.success, true);
      const calAfter = await ask(cal.client.socket, 'auction:sync');
      const departed = calAfter.state.departed.find((seat) => seat.username === 'bea');
      assert.equal(departed.cardCount, 2);
      assert.equal(departed.squadStatus, 'abandoned');
      assert.equal(calAfter.state.yourBalance, 1000);
      assert.equal(calAfter.state.yourCards.length, 0);
      assert.notEqual(calAfter.state.phase, undefined);
      const stillThere = await (await fetch(`${server.url}/api/room/${code}`)).json();
      assert.equal(stillThere.players.length, 1);
      assert.equal(stillThere.players[0].username, 'cal');
      assert.equal(stillThere.players[0].isHost, true);

      const other = await createRoom(server.url);
      const moved = await join(io, server.url, 'bea', other);
      clients.push(moved.client);
      assert.equal(moved.response.success, true);
      assert.notEqual(other, code);

      const last = await ask(cal.client.socket, 'room:leave', {});
      assert.equal(last.success, true);
      const gone = await fetch(`${server.url}/api/room/${code}`);
      assert.equal(gone.status, 404);
      const fresh = await connectClient(io, server.url);
      clients.push(fresh);
      const oldSession = await ask(fresh.socket, 'room:join', {
        username: 'ada',
        roomCode: code,
        seatToken: ada.client.seatToken
      });
      assert.equal(oldSession.success, false);
      const movedRoom = await (await fetch(`${server.url}/api/room/${other}`)).json();
      assert.equal(movedRoom.players[0].username, 'bea');

      const liveCards = await (await fetch(`${server.url}/api/cards`)).json();
      assert.equal(liveCards.count, 1009);
      assert.equal(liveCards.cards.every((card) => String(card.id).startsWith('fut23_')), true);
      assert.equal(roomCodes(developerRoomFile()).includes(code), false);
      assert.equal(roomCodes(developerRoomFile()).includes(other), false);
    } finally {
      for (const client of clients) client.socket.disconnect();
      await stopLiveServer(server.child);
    }
  });
});
