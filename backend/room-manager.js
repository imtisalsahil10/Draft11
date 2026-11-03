/**
 * ROOM MANAGER
 * Manages game rooms and player sessions
 */

import { randomBytes } from 'node:crypto';
import { generateRoomCode, deepCopy, logWithTime } from './utils.js';
import { GAME_CONFIG, ROOM_SCHEMA_VERSION } from './constants.js';
import { evaluateSquad, selectionFromLineup } from '../shared/squad-evaluation.js';
import { credentialMatches, hashSeatToken, issueSeatToken } from './security/seat-token.js';

function issueSeatId() {
  return randomBytes(12).toString('hex');
}

/**
 * Read a finished seat by its token. Room codes, names, and socket ids are
 * not accepted. The returned card ids and lineup are copies.
 */
export function readCompletedSeat(roomManager, phaseOf, seatToken) {
  const located = roomManager?.findSeatByToken?.(seatToken);
  if (!located) return null;
  const phase = typeof phaseOf === 'function' ? phaseOf(located.roomCode) : null;
  if (phase !== 'finished') return { state: 'not-finished' };
  return {
    state: 'ready',
    roomId: located.roomId,
    seatId: located.seatId,
    cardIds: located.cardIds.slice(),
    lineup: located.lineup
  };
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.onChange = null;
    this.onRemove = null;
  }

  _changed(roomCode) {
    try {
      if (typeof this.onChange === 'function') this.onChange(roomCode);
    } catch (err) {
      logWithTime(`Room change hook failed: ${err.message}`, 'ERROR');
    }
  }

  _removed(roomCode) {
    try {
      if (typeof this.onRemove === 'function') this.onRemove(roomCode);
      else this._changed(roomCode);
    } catch (err) {
      logWithTime(`Room remove hook failed: ${err.message}`, 'ERROR');
    }
  }

  /**
   * Tell the store that server code mutated this room directly.
   */
  markChanged(roomCode) {
    if (!this.getRoom(roomCode)) {
      this._removed(roomCode);
      return false;
    }
    this._changed(roomCode);
    return true;
  }

  listCodes() {
    return [...this.rooms.keys()];
  }

  /**
   * Install a room rebuilt from a snapshot. Does not write it back.
   */
  restoreRoom(room) {
    if (!room?.code) return false;
    this.rooms.set(room.code, room);
    return true;
  }

  _assignHost(room) {
    const seated = [...room.players.values()];
    if (room.hostSeatId && seated.some((player) => player.seatId === room.hostSeatId)) return;
    const next = seated.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))[0];
    room.hostSeatId = next?.seatId || null;
    room.hostUsername = next?.username || null;
  }
  
  /**
   * Create a new room
   */
  createRoom(options = {}) {
    let roomCode = generateRoomCode();
    let guard = 0;
    while (this.rooms.has(roomCode) && guard < 25) {
      roomCode = generateRoomCode();
      guard += 1;
    }
    if (this.rooms.has(roomCode)) {
      throw new Error('Could not allocate a room code');
    }
    const now = Date.now();
    const room = {
      roomId: randomBytes(16).toString('hex'),
      code: roomCode,
      schemaVersion: ROOM_SCHEMA_VERSION,
      stateVersion: 0,
      createdAt: now,
      lastActivity: now,
      players: new Map(),
      status: 'waiting', // waiting, auction, match, finished
      currentAuction: null,
      hostSeatId: null,
      hostUsername: null,
      gameState: {
        players: [],
        currentCard: null,
        currentCardIndex: 0,
        auctionPhase: 'not-started'
      }
    };
    this.rooms.set(roomCode, room);
    logWithTime(`Room created: ${roomCode}`);
    this._changed(roomCode);
    return roomCode;
  }
  
  /**
   * Get room by code
   */
  getRoom(roomCode) {
    return this.rooms.get(roomCode);
  }
  
  /**
   * Add player to room
   */
  addPlayerToRoom(roomCode, playerId, playerData) {
    const room = this.getRoom(roomCode);
    if (!room) return null;
    
    if (room.players.size >= GAME_CONFIG.MAX_PLAYERS_PER_ROOM) {
      return null;
    }
    
    const now = Date.now();
    const issued = typeof playerData.seatToken === 'string' && playerData.seatToken.length >= 32
      ? playerData.seatToken
      : issueSeatToken();
    room.players.set(playerId, {
      id: playerId,
      seatId: playerData.seatId || issueSeatId(),
      username: playerData.username,
      socketId: playerData.socketId,
      seatTokenHash: typeof playerData.seatTokenHash === 'string'
        ? playerData.seatTokenHash
        : hashSeatToken(issued),
      balance: GAME_CONFIG.INITIAL_BALANCE,
      team: [],
      joinedAt: now,
      isOnline: true,
      lastActivity: now
    });
    
    logWithTime(`Player ${playerData.username} joined room ${roomCode}`);
    return room;
  }
  
  /**
   * Seat a player, or move an existing username onto a new socket id.
   * The first claim of a free name receives a seat token. Reclaiming that
   * name from another socket requires the same token. Username alone cannot
   * take over a seat.
   */
  takeSeat(roomCode, playerId, username, seatToken) {
    const room = this.getRoom(roomCode);
    if (!room) return { error: 'missing' };

    const existing = Array.from(room.players.values()).find((p) => p.username === username);
    if (existing) {
      const replaced = existing.id !== playerId;
      if (replaced && !credentialMatches(existing, seatToken)) return { error: 'seat-taken' };
      if (replaced) {
        room.players.delete(existing.id);
        existing.id = playerId;
        existing.socketId = playerId;
        room.players.set(playerId, existing);
      }
      if (!existing.seatId) existing.seatId = issueSeatId();
      let returned = null;
      if (credentialMatches(existing, seatToken)) returned = seatToken;
      else if (!existing.seatTokenHash && typeof existing.seatToken !== 'string') {
        returned = issueSeatToken();
        existing.seatTokenHash = hashSeatToken(returned);
      }
      existing.isOnline = true;
      existing.lastActivity = Date.now();
      delete existing.disconnectDeadline;
      room.lastActivity = existing.lastActivity;
      delete room.emptiedAt;
      this._assignHost(room);
      logWithTime(`Player ${username} rejoined room ${roomCode}`);
      this._changed(roomCode);
      return { player: existing, seatToken: returned, rejoined: true, replaced };
    }

    if (room.players.size >= GAME_CONFIG.MAX_PLAYERS_PER_ROOM) {
      return { error: 'full' };
    }

    const issued = issueSeatToken();
    this.addPlayerToRoom(roomCode, playerId, { username, socketId: playerId, seatToken: issued });
    const player = this.getPlayer(roomCode, playerId);
    room.lastActivity = Date.now();
    delete room.emptiedAt;
    this._assignHost(room);
    this._changed(roomCode);
    return { player, seatToken: issued, rejoined: false, replaced: false };
  }

  /**
   * Put a finished auction squad back onto the current socket for that name.
   */
  applySavedSquad(roomCode, playerId) {
    const room = this.getRoom(roomCode);
    const player = room?.players.get(playerId);
    if (!room?.finalSquads || !player) return false;
    const saved = room.finalSquads.find((squad) => squad.username === player.username);
    if (!saved) return false;
    player.balance = saved.balance;
    player.team = deepCopy(saved.cards || []);
    this._changed(roomCode);
    return true;
  }

  /**
   * Rematch votes are stored by username so a new socket id keeps the vote.
   */
  rematchStatus(roomCode) {
    const room = this.getRoom(roomCode);
    if (!room) return { voters: [], voted: 0, total: 0 };
    const players = this.getRoomPlayers(roomCode);
    const votes = room.rematchVotes || new Set();
    const voters = players
      .filter((player) => votes.has(player.username))
      .map((player) => ({ id: player.id, username: player.username }));
    return { voters, voted: voters.length, total: players.length };
  }

  /**
   * Keep a departing seat's purchases. Cards are not returned, transferred,
   * or deleted. An unconfirmed lineup is abandoned and cannot play a match.
   * A confirmed lineup stays on the record, but the seat is no longer active.
   */
  _archiveDeparture(room, player) {
    if (!room.departedSeats) room.departedSeats = [];
    if (room.departedSeats.some((seat) => seat.seatId === player.seatId)) return;
    const confirmed = Boolean(player.lineup?.confirmed && player.teamBuilt);
    room.departedSeats.push({
      seatId: player.seatId,
      username: player.username,
      balance: player.balance,
      team: deepCopy(player.team || []),
      lineup: player.lineup ? deepCopy(player.lineup) : null,
      leftAt: Date.now(),
      squadStatus: confirmed ? 'preserved' : 'abandoned'
    });
  }

  /**
   * Remove player from room
   */
  removePlayerFromRoom(roomCode, playerId, { preserveEmpty = false } = {}) {
    const room = this.getRoom(roomCode);
    if (!room) return false;
    
    const player = room.players.get(playerId);
    if (!player) return false;

    this._archiveDeparture(room, player);
    room.players.delete(playerId);
    room.lastActivity = Date.now();
    logWithTime(`Player ${player.username} left room ${roomCode}`);
    
    // Keep the room during an auction so a refresh can rejoin
    if (room.players.size === 0) {
      room.emptiedAt = Date.now();
      if (!preserveEmpty) {
        this.rooms.delete(roomCode);
        logWithTime(`Room ${roomCode} deleted (empty)`);
        this._removed(roomCode);
        return true;
      }
    }

    this._assignHost(room);
    this._changed(roomCode);
    return true;
  }
  
  /**
   * Get all players in room
   */
  getRoomPlayers(roomCode) {
    const room = this.getRoom(roomCode);
    if (!room) return [];
    return Array.from(room.players.values());
  }
  
  /**
   * Get player from room
   */
  getPlayer(roomCode, playerId) {
    const room = this.getRoom(roomCode);
    if (!room) return null;
    return room.players.get(playerId);
  }

  /**
   * Find the one seat that holds this token. Two matches fail closed.
   * This does not change the seat, its cards, or its balance.
   */
  findSeatByToken(seatToken) {
    if (typeof seatToken !== 'string' || seatToken.length < 32 || seatToken.length > 128) return null;
    let found = null;
    for (const room of this.rooms.values()) {
      for (const player of room.players.values()) {
        if (!credentialMatches(player, seatToken)) continue;
        if (found) return null;
        found = { room, player };
      }
    }
    if (!found) return null;
    const cardIds = [];
    for (const card of found.player.team || []) {
      if (card?.id == null || card.id === '') continue;
      cardIds.push(card.id);
    }
    return {
      roomId: found.room.roomId,
      roomCode: found.room.code,
      seatId: found.player.seatId,
      cardIds,
      lineup: found.player.lineup ? deepCopy(found.player.lineup) : null
    };
  }
  
  /**
   * Update player balance
   */
  updatePlayerBalance(roomCode, playerId, amount) {
    const player = this.getPlayer(roomCode, playerId);
    if (!player) return false;
    
    player.balance = Math.max(0, player.balance + amount);
    this._changed(roomCode);
    return true;
  }
  
  /**
   * Add card to player team
   */
  addCardToTeam(roomCode, playerId, card) {
    const room = this.getRoom(roomCode);
    const player = room?.players.get(playerId);
    if (!player || !card) return false;

    if (card.id != null) {
      for (const seated of room.players.values()) {
        if ((seated.team || []).some((owned) => owned.id === card.id)) return false;
      }
    }
    
    player.team.push(deepCopy(card));
    player.lastActivity = Date.now();
    room.lastActivity = player.lastActivity;
    this._changed(roomCode);
    return true;
  }

  noteActivity(roomCode) {
    const room = this.getRoom(roomCode);
    if (!room) return false;
    room.lastActivity = Date.now();
    this._changed(roomCode);
    return true;
  }

  /**
   * Online flag is recoverable. disconnectDeadline is the moment an offline
   * seat in a room that is not mid-auction should be removed.
   */
  setPresence(roomCode, playerId, online, { disconnectDeadline = null } = {}) {
    const room = this.getRoom(roomCode);
    const player = room?.players.get(playerId);
    if (!player) return false;
    player.isOnline = Boolean(online);
    if (online || !disconnectDeadline) delete player.disconnectDeadline;
    else player.disconnectDeadline = disconnectDeadline;
    player.lastActivity = Date.now();
    room.lastActivity = player.lastActivity;
    this._changed(roomCode);
    return true;
  }

  addRematchVote(roomCode, username) {
    const room = this.getRoom(roomCode);
    if (!room || !username) return null;
    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(username);
    room.lastActivity = Date.now();
    this._changed(roomCode);
    return this.rematchStatus(roomCode);
  }

  removeRematchVote(roomCode, username) {
    const room = this.getRoom(roomCode);
    if (!room?.rematchVotes || !username) return false;
    room.rematchVotes.delete(username);
    this._changed(roomCode);
    return true;
  }

  saveFinalSquads(roomCode, squads) {
    const room = this.getRoom(roomCode);
    if (!room) return false;
    room.finalSquads = deepCopy(squads);
    room.rematchVotes = new Set();
    this._changed(roomCode);
    return true;
  }

  /**
   * Clear the finished auction so a rematch can start. The host seat stays.
   */
  resetForRematch(roomCode) {
    const room = this.getRoom(roomCode);
    if (!room) return false;
    room.rematchStarting = true;
    room.rematchVotes = new Set();
    room.finalSquads = null;
    room.departedSeats = [];
    room.matchResults = null;
    room.gameFinished = false;
    for (const player of room.players.values()) {
      player.balance = GAME_CONFIG.INITIAL_BALANCE;
      player.team = [];
      player.teamBuilt = false;
      player.builtTeam = null;
      player.teamOverall = 0;
      player.formation = null;
      player.lineup = null;
    }
    this._changed(roomCode);
    return true;
  }

  finishRematchSetup(roomCode) {
    const room = this.getRoom(roomCode);
    if (!room) return false;
    room.rematchStarting = false;
    this._changed(roomCode);
    return true;
  }

  recordMatch(roomCode, results) {
    const room = this.getRoom(roomCode);
    if (!room) return null;
    if (room.matchResults) {
      return { results: room.matchResults, alreadyRecorded: true };
    }
    room.matchResults = deepCopy(results);
    room.gameFinished = true;
    room.status = 'match';
    this._changed(roomCode);
    return { results: room.matchResults, alreadyRecorded: false };
  }

  /**
   * Store a validated lineup. Acquired cards on player.team are left as they are.
   * A confirmed XI also fills the legacy built-team fields used by the match flow.
   */
  setLineup(roomCode, playerId, lineup) {
    const room = this.getRoom(roomCode);
    const player = room?.players.get(playerId);
    if (!player || !lineup) return false;

    player.lineup = {
      formation: lineup.formation,
      revision: lineup.revision,
      confirmed: Boolean(lineup.confirmed),
      slots: (lineup.slots || []).map((slot) => ({
        slotId: slot.slotId,
        cardId: slot.cardId ?? null
      }))
    };
    player.formation = lineup.formation;

    const selected = selectionFromLineup(player.team, player.lineup);
    if (player.lineup.confirmed && selected.length === GAME_CONFIG.REQUIRED_TEAM_SIZE) {
      player.teamBuilt = true;
      player.builtTeam = selected.map((card) => deepCopy(card));
      player.teamOverall = evaluateSquad(player.team, player.lineup).strength ?? 0;
    } else {
      player.lineup.confirmed = false;
      player.teamBuilt = false;
      player.builtTeam = null;
      player.teamOverall = 0;
    }

    room.lastActivity = Date.now();
    this._changed(roomCode);
    return true;
  }

  recordBuiltTeam(roomCode, playerId, team, overall, formation) {
    const room = this.getRoom(roomCode);
    const player = room?.players.get(playerId);
    if (!player) return false;
    player.builtTeam = team;
    player.teamOverall = overall;
    player.formation = formation;
    player.teamBuilt = true;
    room.lastActivity = Date.now();
    this._changed(roomCode);
    return true;
  }

  /**
   * Drop rooms that have been empty or idle past the configured limits.
   * Returns the room codes that were removed.
   */
  sweep(now = Date.now()) {
    const removed = [];
    for (const [code, room] of this.rooms) {
      const last = room.lastActivity || room.createdAt || now;
      const abandoned = room.players.size === 0
        && room.emptiedAt
        && (now - room.emptiedAt) >= GAME_CONFIG.DISCONNECT_TIMEOUT_MS;
      const stale = (now - last) >= GAME_CONFIG.ROOM_TIMEOUT_MS;
      if (abandoned || stale) {
        this.rooms.delete(code);
        removed.push(code);
        this._removed(code);
      }
    }
    return removed;
  }
  
  /**
   * Start auction
   */
  startAuction(roomCode) {
    const room = this.getRoom(roomCode);
    if (!room) return false;
    
    room.status = 'auction';
    room.gameState.auctionPhase = 'started';
    room.rematchStarting = false;
    logWithTime(`Auction started in room ${roomCode}`);
    this._changed(roomCode);
    return true;
  }
  
  /**
   * Finish auction
   */
  finishAuction(roomCode) {
    const room = this.getRoom(roomCode);
    if (!room) return false;
    
    room.status = 'match';
    room.gameState.auctionPhase = 'finished';
    logWithTime(`Auction finished in room ${roomCode}`);
    this._changed(roomCode);
    return true;
  }
  
  /**
   * Get room stats
   */
  getRoomStats() {
    return {
      totalRooms: this.rooms.size,
      totalPlayers: Array.from(this.rooms.values()).reduce(
        (sum, room) => sum + room.players.size,
        0
      )
    };
  }
}
