/**
 * LEAGUE SOCKETS
 * A client is subscribed only after the membership token checks out.
 * Knowing a league id does not join the room and does not receive events.
 * State is persisted before a successful change is broadcast.
 * league:state and league:subscribe return the current league, so a
 * reconnect does not depend on events that were missed.
 *
 * league:fixture:simulate asks the server to play an eligible fixture.
 * Scores, winners, and trusted flags in that payload are rejected.
 * league:fixture-complete no longer accepts a client score.
 */

import { createRateLimiter, LIMITS, socketAddress } from './security/rate-limit.js';

const leagueCreateLimit = createRateLimiter(LIMITS.leagueCreate);
const leagueJoinLimit = createRateLimiter(LIMITS.leagueJoin);
const squadWriteLimit = createRateLimiter(LIMITS.squadWrite);

function leagueRoom(leagueId) {
  return `league:${leagueId}`;
}

function tooMany(callback) {
  ack(callback, {
    success: false,
    error: 'RATE_LIMITED',
    message: 'Too many requests. Wait a moment and try again.'
  });
}

function ack(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

function clientPayload(result) {
  const payload = { league: result.view };
  if (result.memberId) payload.memberId = result.memberId;
  if (result.memberToken) payload.memberToken = result.memberToken;
  if (result.inviteCode) payload.inviteCode = result.inviteCode;
  if (result.lineup) payload.lineup = result.lineup;
  if (result.result) payload.result = result.result;
  if (result.alreadyComplete) payload.alreadyComplete = true;
  if (result.alreadyLinked) payload.alreadyLinked = true;
  return payload;
}

function credentials(payload) {
  return {
    leagueId: payload.leagueId,
    memberId: payload.memberId,
    memberToken: payload.memberToken
  };
}

export function bindLeagueSocket(socket, io, getService) {
  async function perform(data, callback, action, { join = false } = {}) {
    const service = getService();
    const result = await action(service, data || {});
    if (!result?.ok) {
      ack(callback, {
        success: false,
        error: result?.error || 'UNAUTHORIZED',
        message: result?.message || 'Not allowed.',
        lineup: result?.lineup || null
      });
      return;
    }
    if (join && result.view?.leagueId) socket.join(leagueRoom(result.view.leagueId));
    ack(callback, { success: true, ...clientPayload(result) });
    const leagueId = result.view?.leagueId;
    if (!leagueId || !result.events?.length) return;
    for (const event of result.events) {
      io.to(leagueRoom(leagueId)).emit(event.type, event.payload);
    }
  }

  socket.on('league:create', (data, callback) => {
    if (!leagueCreateLimit.allow(socketAddress(socket))) {
      tooMany(callback);
      return;
    }
    perform(data, callback, (service, payload) => service.create({
      name: payload.name,
      displayName: payload.displayName
    }));
  });

  socket.on('league:join', (data, callback) => {
    if (!leagueJoinLimit.allow(socketAddress(socket))) {
      tooMany(callback);
      return;
    }
    const inviteCode = typeof data?.inviteCode === 'string' ? data.inviteCode.trim() : '';
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(inviteCode)) {
      ack(callback, {
        success: false,
        error: 'INVITE_INVALID',
        message: 'That invitation is not valid.'
      });
      return;
    }
    perform(data, callback, (service, payload) => service.join({
      inviteCode: payload.inviteCode,
      displayName: payload.displayName,
      memberId: payload.memberId,
      memberToken: payload.memberToken
    }));
  });

  socket.on('league:state', (data, callback) => {
    perform(data, callback, (service, payload) => service.view(payload));
  });

  socket.on('league:subscribe', (data, callback) => {
    perform(data, callback, (service, payload) => service.view(payload), { join: true });
  });

  socket.on('league:leave', (data, callback) => {
    perform(data, callback, (service, payload) => service.leave(payload));
  });

  socket.on('league:remove', (data, callback) => {
    perform(data, callback, (service, payload) => service.remove(payload));
  });

  socket.on('league:schedule', (data, callback) => {
    perform(data, callback, (service, payload) => service.schedule(payload));
  });

  socket.on('league:fixture-link', (data, callback) => {
    perform(data, callback, (service, payload) => service.linkFixture({
      ...credentials(payload),
      fixtureId: payload.fixtureId,
      roomCode: payload.roomCode,
      savedGameId: payload.savedGameId
    }));
  });

  socket.on('league:squad:register', (data, callback) => {
    if (!squadWriteLimit.allow(socketAddress(socket))) {
      tooMany(callback);
      return;
    }
    perform(data, callback, (service, payload) => service.registerSquad({
      ...credentials(payload),
      cardIds: payload.cardIds
    }));
  });

  socket.on('league:squad:suggest', (data, callback) => {
    if (!squadWriteLimit.allow(socketAddress(socket))) {
      tooMany(callback);
      return;
    }
    perform(data, callback, (service, payload) => service.registerSuggestedSquad(credentials(payload)));
  });

  socket.on('league:squad:link-auction', (data, callback) => {
    perform(data, callback, (service, payload) => service.linkAuctionSquad({
      ...credentials(payload),
      seatToken: payload.seatToken
    }));
  });

  socket.on('league:lineup:update', (data, callback) => {
    perform(data, callback, (service, payload) => service.updateLineup({
      ...credentials(payload),
      formation: payload.formation,
      assignments: payload.assignments,
      expectedRevision: payload.expectedRevision,
      confirm: payload.confirm === true
    }));
  });

  socket.on('league:fixture:confirm-lineup', (data, callback) => {
    perform(data, callback, (service, payload) => service.confirmFixtureLineup({
      ...credentials(payload),
      fixtureId: payload.fixtureId,
      formation: payload.formation,
      assignments: payload.assignments,
      expectedRevision: payload.expectedRevision
    }));
  });

  socket.on('league:fixture:simulate', (data, callback) => {
    perform(data, callback, (service, payload) => service.simulateLeagueFixture({
      ...credentials(payload),
      fixtureId: payload.fixtureId,
      homeGoals: payload.homeGoals,
      awayGoals: payload.awayGoals,
      winner: payload.winner,
      trusted: payload.trusted,
      overall: payload.overall,
      simulation: payload.simulation,
      result: payload.result,
      goals: payload.goals,
      admin: payload.admin
    }));
  });

  socket.on('league:fixture-complete', (data, callback) => {
    ack(callback, {
      success: false,
      error: 'INVALID_RESULT',
      message: 'The server simulates the match. A score cannot be submitted.'
    });
  });
}
