/**
 * Links a finished live-room seat to a league member.
 * The seat token and the member token are the credentials. Names, socket
 * ids, room codes, and client card stats are not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RoomManager, readCompletedSeat } from '../room-manager.js';
import { MemoryLeagueStore } from '../league-store.js';
import { bindLeagueSocket } from '../league-sockets.js';
import { LEAGUE_ERRORS, createLeagueService } from '../league-service.js';
import { suggestEleven } from '../league-match.js';

const ROLES = ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'LW', 'ST', 'RW'];
const TOKEN_A = 'a'.repeat(48);
const TOKEN_B = 'b'.repeat(48);

function catalogFor(managers) {
  const cards = [];
  for (let manager = 0; manager < managers; manager += 1) {
    ROLES.forEach((role, index) => {
      const overall = 60 + manager * 3 + (index % 5);
      cards.push({
        id: `c-${manager}-${index}`,
        name: `${role} ${manager}-${index}`,
        position: role,
        stats: {
          pace: overall,
          shooting: overall,
          passing: overall,
          defense: overall,
          physical: overall,
          overall
        }
      });
    });
  }
  return cards;
}

function authOf(result) {
  return {
    leagueId: result.view.leagueId,
    memberId: result.memberId,
    memberToken: result.memberToken
  };
}

function squadIds(view, memberId) {
  const member = view.members.find((item) => item.memberId === memberId);
  return (member?.squad?.cards || []).map((card) => String(card.id)).sort();
}

async function leagueWith(readSeat, managers = 2) {
  const catalog = catalogFor(managers);
  const store = new MemoryLeagueStore();
  const leagues = createLeagueService({ store, catalog, readSeat });
  const created = await leagues.create({ name: 'Auction Cup', displayName: 'Ada' });
  assert.equal(created.ok, true, created.message);
  const people = [{ auth: authOf(created) }];
  const labels = ['Bea', 'Cal'];
  for (let index = 0; index < managers - 1; index += 1) {
    const joined = await leagues.join({ inviteCode: created.inviteCode, displayName: labels[index] });
    assert.equal(joined.ok, true, joined.message);
    people.push({ auth: authOf(joined) });
  }
  return { store, leagues, catalog, people };
}

function seatMap(catalog) {
  const source = {
    balance: 640,
    team: catalog.slice(0, 11).map((card) => ({
      ...card,
      name: 'Forged name',
      stats: { ...card.stats, overall: 99 }
    }))
  };
  const suggestion = suggestEleven(catalog.slice(0, 11));
  const seats = new Map();
  seats.set(TOKEN_A, {
    state: 'ready',
    roomId: 'room-a',
    seatId: 'seat-a',
    cardIds: source.team.map((card) => card.id),
    lineup: {
      formation: suggestion.formation,
      confirmed: true,
      revision: 4,
      slots: suggestion.assignments.map((slot) => ({ slotId: slot.slotId, cardId: slot.cardId }))
    }
  });
  seats.set(TOKEN_B, {
    state: 'ready',
    roomId: 'room-b',
    seatId: 'seat-b',
    cardIds: catalog.slice(10, 21).map((card) => card.id),
    lineup: null
  });
  const readSeat = (token) => {
    const seat = seats.get(token);
    if (!seat) return null;
    return {
      state: seat.state,
      roomId: seat.roomId,
      seatId: seat.seatId,
      cardIds: seat.cardIds.slice(),
      lineup: seat.lineup ? JSON.parse(JSON.stringify(seat.lineup)) : null
    };
  };
  return { source, seats, readSeat };
}

describe('auction seat link', () => {
  it('registers catalog cards for a finished seat and ignores client stats', async () => {
    const catalog = catalogFor(2);
    const { source, readSeat } = seatMap(catalog);
    const { leagues, people } = await leagueWith(readSeat);
    const [ada] = people;
    const linked = await leagues.linkAuctionSquad({
      ...ada.auth,
      seatToken: TOKEN_A,
      username: 'Bea',
      socketId: 'socket-1',
      roomCode: 'OTHER1',
      cardIds: catalog.slice(11).map((card) => card.id),
      cards: [{ id: 'c-0-0', name: 'Client', stats: { overall: 99 } }],
      overall: 99,
      balance: 1
    });
    assert.equal(linked.ok, true, linked.message);
    assert.equal(linked.alreadyLinked, false);
    const cards = linked.view.you.squad.cards;
    assert.deepEqual(cards.map((card) => card.id), source.team.map((card) => card.id));
    assert.equal(cards[0].stats.overall, catalog[0].stats.overall);
    assert.notEqual(cards[0].stats.overall, 99);
    assert.equal(cards[0].name, catalog[0].name);
    assert.equal(linked.view.you.squad.lineup.confirmed, true);
    assert.equal(source.balance, 640);
    assert.equal(source.team[0].stats.overall, 99);
    assert.equal(source.team[0].name, 'Forged name');

    const again = await leagues.linkAuctionSquad({
      ...ada.auth,
      seatToken: TOKEN_A,
      cardIds: ['c-1-0']
    });
    assert.equal(again.ok, true, again.message);
    assert.equal(again.alreadyLinked, true);
    assert.equal(again.events.length, 0);
    assert.equal(again.view.you.squad.revision, linked.view.you.squad.revision);
    assert.deepEqual(squadIds(again.view, ada.auth.memberId), squadIds(linked.view, ada.auth.memberId));
  });

  it('returns the stored association after a reload and does not duplicate cards', async () => {
    const catalog = catalogFor(2);
    const { readSeat } = seatMap(catalog);
    const { store, leagues, people } = await leagueWith(readSeat);
    const [ada, bea] = people;
    const linked = await leagues.linkAuctionSquad({ ...ada.auth, seatToken: TOKEN_A });
    assert.equal(linked.ok, true, linked.message);

    const second = createLeagueService({ store, catalog, readSeat });
    await second.load();
    const [left, right] = await Promise.all([
      second.linkAuctionSquad({ ...ada.auth, seatToken: TOKEN_A }),
      second.linkAuctionSquad({ ...ada.auth, seatToken: TOKEN_A })
    ]);
    assert.equal(left.ok && right.ok, true, `${left.message} ${right.message}`);
    assert.equal([left, right].filter((result) => result.alreadyLinked).length, 2);
    const view = (await second.view(ada.auth)).view;
    assert.equal(view.you.squad.revision, linked.view.you.squad.revision);
    const owners = new Map();
    for (const member of view.members) {
      for (const card of member.squad?.cards || []) {
        assert.equal(owners.has(String(card.id)), false, card.id);
        owners.set(String(card.id), member.memberId);
      }
    }
    const stolen = await second.linkAuctionSquad({ ...bea.auth, seatToken: TOKEN_A });
    assert.equal(stolen.ok, false);
    assert.equal(stolen.error, LEAGUE_ERRORS.CONFLICT);
    assert.equal((await second.view(bea.auth)).view.you.squad, null);
  });

  it('keeps one copy when two seats overlap or the same seat is claimed together', async () => {
    const catalog = catalogFor(2);
    const { seats, readSeat } = seatMap(catalog);
    const { leagues, people } = await leagueWith(readSeat);
    const [ada, bea] = people;
    const [sameLeft, sameRight] = await Promise.all([
      leagues.linkAuctionSquad({ ...ada.auth, seatToken: TOKEN_A }),
      leagues.linkAuctionSquad({ ...bea.auth, seatToken: TOKEN_A })
    ]);
    const results = [sameLeft, sameRight];
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, 1);
    const view = (await leagues.view(ada.auth)).view;
    const seen = new Set();
    for (const member of view.members) {
      for (const card of member.squad?.cards || []) {
        assert.equal(seen.has(String(card.id)), false);
        seen.add(String(card.id));
      }
    }

    seats.set(TOKEN_B, {
      state: 'ready',
      roomId: 'room-b',
      seatId: 'seat-b',
      cardIds: [catalog[0].id, ...catalog.slice(11, 21).map((card) => card.id)],
      lineup: null
    });
    const openMember = (await leagues.view(ada.auth)).view.members.find((member) => !member.squad);
    const claimer = [ada, bea].find((person) => person.auth.memberId === openMember.memberId);
    const overlap = await leagues.linkAuctionSquad({ ...claimer.auth, seatToken: TOKEN_B });
    assert.equal(overlap.ok, false);
    assert.equal(overlap.error, LEAGUE_ERRORS.SQUAD_INVALID);
    const after = (await leagues.view(ada.auth)).view;
    assert.equal(after.members.filter((member) => member.squad).length, 1);
  });

  it('rejects a bad token, an unfinished auction, a short squad, and a squad that is already registered', async () => {
    const catalog = catalogFor(2);
    const { seats, readSeat } = seatMap(catalog);
    const { leagues, people } = await leagueWith(readSeat);
    const [ada, bea] = people;

    const missing = await leagues.linkAuctionSquad({ ...ada.auth, seatToken: 'f'.repeat(48) });
    assert.equal(missing.error, LEAGUE_ERRORS.UNAUTHORIZED);
    const named = await leagues.linkAuctionSquad({
      ...ada.auth,
      seatToken: 'Ada',
      username: 'Ada',
      roomCode: 'ROOM01'
    });
    assert.equal(named.error, LEAGUE_ERRORS.INVALID_PARAMETERS);

    seats.get(TOKEN_A).state = 'not-finished';
    const early = await leagues.linkAuctionSquad({ ...ada.auth, seatToken: TOKEN_A });
    assert.equal(early.error, LEAGUE_ERRORS.INVALID_PARAMETERS);
    assert.equal((await leagues.view(ada.auth)).view.you.squad, null);
    seats.get(TOKEN_A).state = 'ready';

    const original = seats.get(TOKEN_A).cardIds.slice();
    seats.get(TOKEN_A).cardIds = original.slice(0, 10);
    const short = await leagues.linkAuctionSquad({ ...ada.auth, seatToken: TOKEN_A });
    assert.equal(short.error, LEAGUE_ERRORS.SQUAD_INVALID);
    seats.get(TOKEN_A).cardIds = original;

    seats.get(TOKEN_A).cardIds = [...original, original[0]];
    const duplicate = await leagues.linkAuctionSquad({ ...ada.auth, seatToken: TOKEN_A });
    assert.equal(duplicate.error, LEAGUE_ERRORS.SQUAD_INVALID);
    seats.get(TOKEN_A).cardIds = original;

    assert.equal((await leagues.registerSuggestedSquad(bea.auth)).ok, true);
    const replaced = await leagues.linkAuctionSquad({ ...bea.auth, seatToken: TOKEN_B });
    assert.equal(replaced.error, LEAGUE_ERRORS.SQUAD_INVALID);
    assert.equal((await leagues.view(bea.auth)).view.you.squad.cards.length, 11);

    const unknown = seats.get(TOKEN_A).cardIds.slice();
    seats.get(TOKEN_A).cardIds = unknown.map((id, index) => (index === 0 ? 'missing-card' : id));
    const unverified = await leagues.linkAuctionSquad({ ...ada.auth, seatToken: TOKEN_A });
    assert.equal(unverified.error, LEAGUE_ERRORS.SQUAD_INVALID);
    seats.get(TOKEN_A).cardIds = unknown;
    assert.equal((await leagues.view(ada.auth)).view.you.squad, null);
  });

  it('does not treat the room code or display name as the seat', () => {
    const manager = new RoomManager();
    const home = manager.createRoom();
    const away = manager.createRoom();
    manager.addPlayerToRoom(home, 'socket-ada', {
      username: 'Ada',
      socketId: 'socket-ada',
      seatToken: TOKEN_A
    });
    manager.addPlayerToRoom(away, 'socket-bea', {
      username: 'Ada',
      socketId: 'socket-bea',
      seatToken: TOKEN_B
    });
    const ada = manager.getPlayer(home, 'socket-ada');
    ada.balance = 640;
    ada.team = [{ id: 'c-0-0', name: 'Kept', stats: { overall: 70 } }];
    const before = JSON.parse(JSON.stringify(ada.team));

    assert.equal(manager.findSeatByToken('Ada'), null);
    assert.equal(manager.findSeatByToken(home), null);
    assert.equal(manager.findSeatByToken('socket-ada'), null);
    const found = manager.findSeatByToken(TOKEN_A);
    assert.equal(found.roomCode, home);
    assert.deepEqual(found.cardIds, ['c-0-0']);
    found.cardIds.push('extra');
    found.lineup = { formation: '4-3-3' };
    assert.equal(ada.balance, 640);
    assert.deepEqual(ada.team, before);

    const phase = (code) => (code === home ? 'bidding' : 'finished');
    assert.equal(readCompletedSeat(manager, phase, TOKEN_A).state, 'not-finished');
    assert.equal(readCompletedSeat(manager, phase, TOKEN_B).state, 'ready');
    assert.equal(ada.balance, 640);
    assert.deepEqual(ada.team, before);
  });

  it('accepts only the seat token from the socket payload', async () => {
    const seen = [];
    const socket = {
      handlers: new Map(),
      rooms: new Set(),
      on(event, handler) { this.handlers.set(event, handler); },
      join(room) { this.rooms.add(room); },
      invoke(event, data) {
        return new Promise((resolve, reject) => {
          const handler = this.handlers.get(event);
          Promise.resolve(handler(data, resolve)).catch(reject);
        });
      }
    };
    bindLeagueSocket(socket, { to() { return { emit() {} }; } }, () => ({
      async linkAuctionSquad(credentials) {
        seen.push(credentials);
        return {
          ok: true,
          alreadyLinked: false,
          view: {
            leagueId: credentials.leagueId,
            name: 'Cup',
            status: 'forming',
            currentRound: 0,
            members: [],
            fixtures: [],
            standings: [],
            you: { memberId: credentials.memberId, squad: null }
          },
          events: []
        };
      }
    }));
    const response = await socket.invoke('league:squad:link-auction', {
      leagueId: 'league-1',
      memberId: 'member-1',
      memberToken: 'member-token',
      seatToken: TOKEN_A,
      cardIds: ['forged'],
      cards: [{ id: 'forged', stats: { overall: 99 } }],
      overall: 99,
      roomCode: 'ROOM01',
      username: 'Ada',
      socketId: 'socket-1'
    });
    assert.equal(response.success, true);
    assert.deepEqual(seen, [{
      leagueId: 'league-1',
      memberId: 'member-1',
      memberToken: 'member-token',
      seatToken: TOKEN_A
    }]);
  });
});
