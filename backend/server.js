/**
 * FOOTBALL AUCTION GAME - BACKEND SERVER
 * Express + Socket.IO server for multiplayer game
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Import game engines and managers
import { RoomManager, readCompletedSeat } from './room-manager.js';
import { CardDeckManager } from './card-deck-manager.js';
import { AuctionEngine } from './auction-engine.js';
import { Validator } from './validators.js';
import { loadCards, logWithTime } from './utils.js';
import { chooseCatalog } from './catalog.js';
import { GAME_CONFIG, ERROR_CODES, auctionTimerMs, auctionGapMs } from './constants.js';
import { createRoomStore, restoreDurableRooms, captureFromManagers, MongoRoomWriter, FileRoomWriter } from './room-store.js';
import { indexCards } from './room-snapshot.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { cardArtFileExistsIn, cardArtRequested, photosRequested, presentClientPayload } from './public-card.js';
import { mountIdentityReview } from './security/identity-review.js';
import { createOriginGuard, socketCors } from './security/origins.js';
import {
  diagnosticsEnabled,
  healthBody,
  isProduction,
  mongoRequired,
  productionErrorHandler,
  testRoomFile
} from './security/production.js';
import { createRateLimiter, httpLimit, LIMITS, socketAddress } from './security/rate-limit.js';
import { artMapFromCatalogue, auditLocalCatalogue, readStoredCatalogue, toClientCard } from './players/local-catalogue.js';
import { buildLiveImagePool, servableCardArt } from './players/live-image-pool.js';
import { partitionSelectedCards } from './players/selected-card-partition.js';

// Database imports
import { connectDatabase, disconnectDatabase } from './db.js';
import { Card, Player, Game, Leaderboard, getOrCreatePlayer, updatePlayerStats, getLeaderboard } from './models.js';

// Team and match imports
import { simulateTournament } from './match-simulator.js';
import { lineupView, updateSeatLineup } from './lineup-service.js';
import { commitBuiltTeam } from './squad-service.js';
import { createLeagueService } from './league-service.js';
import { MemoryLeagueStore, MongoLeagueStore } from './league-store.js';
import { MemoryHandoffStore, MongoHandoffStore, hashSeatToken } from './handoff-store.js';
import { bindLeagueSocket } from './league-sockets.js';

// ============================================================================
// INITIALIZATION
// ============================================================================

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: socketCors()
});
const roomCreateLimit = createRateLimiter(LIMITS.roomCreate);
const roomJoinLimit = createRateLimiter(LIMITS.roomJoin);

if (isProduction()) app.set('trust proxy', 1);
app.use(createOriginGuard());
app.use(express.json({ limit: '1mb' }));
mountIdentityReview(app);

// Game managers
const roomManager = new RoomManager();
let deckManager = null;
let livePoolReport = null;
let recoveryCards = [];
const auctionEngine = new AuctionEngine();
const isolatedRoomFile = testRoomFile();
const fileRoomWriter = isolatedRoomFile ? new FileRoomWriter(path.resolve(isolatedRoomFile)) : null;
const mongoRoomWriter = new MongoRoomWriter();

// Database connection flag
let dbConnected = false;
let cleanupTimer = null;
let shuttingDown = false;

// Counts socket handlers that are inside join, start, or bid at the same time.
// Used only when DRAFT11_DIAGNOSTICS=1. Production handlers are not wrapped.
const concurrency = {
  inFlight: 0,
  maxInFlight: 0,
  entered: 0
};

function enterConcurrent() {
  concurrency.inFlight += 1;
  concurrency.entered += 1;
  if (concurrency.inFlight > concurrency.maxInFlight) {
    concurrency.maxInFlight = concurrency.inFlight;
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (concurrency.inFlight > 0) concurrency.inFlight -= 1;
  };
}

function observe(handler) {
  if (!diagnosticsEnabled()) return handler;
  return async function observedHandler(data, callback) {
    const leave = enterConcurrent();
    try {
      return await handler(data, callback);
    } finally {
      leave();
    }
  };
}

const durableWriter = {
  async save(doc, previousVersion) {
    if (dbConnected) return mongoRoomWriter.save(doc, previousVersion);
    if (fileRoomWriter) return fileRoomWriter.save(doc, previousVersion);
    return false;
  },
  async remove(code) {
    if (dbConnected) return mongoRoomWriter.remove(code);
    if (fileRoomWriter) return fileRoomWriter.remove(code);
  },
  async list() {
    if (dbConnected) return mongoRoomWriter.list();
    if (fileRoomWriter) return fileRoomWriter.list();
    return [];
  }
};
const roomStore = createRoomStore({
  roomExists: (code) => Boolean(roomManager.getRoom(code)),
  capture: (code) => captureFromManagers(roomManager, auctionEngine, code),
  applyVersion: (code, previous, next) => {
    const room = roomManager.getRoom(code);
    if (room && (room.stateVersion || 0) === previous) room.stateVersion = next;
  },
  enabled: () => dbConnected || Boolean(fileRoomWriter),
  writer: durableWriter
});
roomManager.onChange = (code) => roomStore.touch(code);
roomManager.onRemove = (code) => roomStore.forget(code);
auctionEngine.onChange = (code) => roomStore.touch(code);

function readLiveSeat(seatToken) {
  return readCompletedSeat(roomManager, (code) => {
    const auction = auctionEngine.getAuction(code);
    if (auction?.phase) return auction.phase;
    return roomManager.getRoom(code)?.gameState?.auctionPhase || null;
  }, seatToken);
}

let handoffStore = new MemoryHandoffStore();

function handoffPort() {
  return {
    find: (tokenHash) => handoffStore.find(tokenHash),
    claim: (tokenHash, claim) => handoffStore.claim(tokenHash, claim)
  };
}

function openLeague(store, catalog = []) {
  return createLeagueService({
    store,
    catalog,
    readSeat: readLiveSeat,
    handoffs: handoffPort(),
    catalogSquads: false
  });
}

let leagueService = openLeague(new MemoryLeagueStore());

async function publishFinishedHandoffs(roomCode) {
  const room = roomManager.getRoom(roomCode);
  if (!room) return;
  const now = Date.now();
  for (const player of room.players.values()) {
    const tokenHash = typeof player.seatTokenHash === 'string'
      ? player.seatTokenHash
      : (typeof player.seatToken === 'string' && player.seatToken.length >= 32
        ? hashSeatToken(player.seatToken)
        : null);
    if (!tokenHash) continue;
    const cardIds = [];
    for (const card of player.team || []) {
      if (card?.id == null || card.id === '') continue;
      cardIds.push(String(card.id));
    }
    await handoffStore.publish({
      tokenHash,
      roomId: room.roomId,
      seatId: player.seatId,
      cardIds,
      now
    });
  }
}

async function commit(roomCode) {
  if (!roomCode) return;
  await roomStore.flush(roomCode);
}

/**
 * Initialize database and load cards
 */
async function initializeDatabase() {
  const fileCards = loadCards('../cards.json');
  let mongoCards = null;
  try {
    await connectDatabase();
    dbConnected = true;
    logWithTime('✅ Database initialized', 'INFO');
    mongoCards = await Card.find().lean();
  } catch {
    dbConnected = false;
    if (mongoRequired()) {
      logWithTime('MongoDB is required and could not be reached', 'ERROR');
      throw new Error('MongoDB is required and could not be reached');
    }
    logWithTime('Database connection failed. Development will continue without MongoDB.', 'WARN');
  }

  const historical = [
    ...(Array.isArray(mongoCards) ? mongoCards : []),
    ...(fileCards || [])
  ];
  const selected = partitionSelectedCards(storedLocalCatalogue());
  const pool = buildLiveImagePool(selected.live, {
    fileExists: servableCardArt(cardArtRoot),
    historicalCards: historical
  });
  const archivedPool = buildLiveImagePool(selected.archived, {
    fileExists: servableCardArt(cardArtRoot)
  });
  livePoolReport = pool.report;
  const chosen = chooseCatalog({ mongoCards, fileCards, imageCards: pool.cards });
  const recoveryIds = new Set(chosen.recovery.map((card) => String(card.id)));
  recoveryCards = chosen.recovery.concat(
    archivedPool.cards.filter((card) => !recoveryIds.has(String(card.id)))
  );
  deckManager = new CardDeckManager(chosen.auction);
  const historicalCount = recoveryCards.length - chosen.auction.length;
  logWithTime(
    `Auction catalog: ${chosen.auction.length} image cards`,
    chosen.auction.length ? 'INFO' : 'WARN'
  );
  if (selected.heldBack.length) {
    logWithTime(`Live catalogue left ${selected.heldBack.length} alternative versions out of the auction pool`, 'INFO');
  }
  if (pool.report.excluded.length) {
    logWithTime(`Image catalogue excluded ${pool.report.excluded.length} cards without usable artwork`, 'WARN');
  }
  if (historicalCount > 0) {
    logWithTime(`Recovery catalog keeps ${historicalCount} older cards for saved rooms`, 'INFO');
  }
  if (!chosen.auction.length) {
    logWithTime('No image cards found in the local catalogue', 'WARN');
  }
}

// ============================================================================
// REST API ENDPOINTS
// ============================================================================

/**
 * Health check
 */
app.get('/health', (req, res) => {
  const report = healthBody({
    connected: dbConnected,
    stats: dbConnected ? roomManager.getRoomStats() : {}
  });
  res.status(report.statusCode).json(report.body);
});

/**
 * Process counters for the multi-room load and concurrency tests.
 * Absent unless DRAFT11_DIAGNOSTICS=1, so a normal server does not expose it.
 */
app.get('/api/diagnostics/runtime', (req, res) => {
  if (!diagnosticsEnabled()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  const timers = auctionEngine.runtimeTimers();
  const memory = process.memoryUsage();
  const peak = {
    inFlight: concurrency.inFlight,
    maxInFlight: concurrency.maxInFlight,
    entered: concurrency.entered
  };
  if (req.query.reset === '1') {
    concurrency.maxInFlight = concurrency.inFlight;
    concurrency.entered = 0;
  }

  res.json({
    success: true,
    totalRooms: roomManager.getRoomStats().totalRooms,
    totalPlayers: roomManager.getRoomStats().totalPlayers,
    auctions: timers.auctions,
    biddingTimers: timers.biddingTimers,
    transitionTimers: timers.transitionTimers,
    concurrency: peak,
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external
    },
    cpu: process.cpuUsage(),
    uptime: process.uptime()
  });
});

/**
 * Create room
 */
app.post('/api/room/create', httpLimit(roomCreateLimit, 'Too many rooms created. Wait a moment and try again.'), async (req, res) => {
  try {
    const roomCode = roomManager.createRoom();
    await commit(roomCode);
    res.json({ success: true, roomCode });
  } catch (err) {
    logWithTime(`Error creating room: ${err.message}`, 'ERROR');
    res.status(500).json({ success: false, error: 'Failed to create room' });
  }
});

/**
 * Get room info
 */
app.get('/api/room/:code', (req, res) => {
  const room = roomManager.getRoom(req.params.code);
  
  if (!room) {
    return res.status(404).json({ success: false, error: 'Room not found' });
  }
  
  const body = {
    success: true,
    code: room.code,
    status: room.status,
    players: presentPlayers(req.params.code),
    poolCardCount: deckManager?.allCards?.length || 0
  };
  res.json(body);
});

/**
 * Load cards
 */
const cardArtRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/public/player-cards');
const testingArtFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/testing-card-art.json');
let testingArtCache = { mtime: 0, map: new Map() };

function testingArtMap() {
  try {
    const stat = fs.statSync(testingArtFile);
    if (stat.mtimeMs === testingArtCache.mtime) return testingArtCache.map;
    const parsed = JSON.parse(fs.readFileSync(testingArtFile, 'utf8'));
    const entries = Object.entries(parsed?.byName || {}).filter(([, url]) => typeof url === 'string');
    testingArtCache = { mtime: stat.mtimeMs, map: new Map(entries) };
  } catch {
    testingArtCache = { mtime: 0, map: new Map() };
  }
  return testingArtCache.map;
}

const localCatalogueFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/local-catalogue/catalogue.json');
let localCatalogueCache = { mtime: 0, data: null };

function storedLocalCatalogue() {
  try {
    const stat = fs.statSync(localCatalogueFile);
    if (stat.mtimeMs === localCatalogueCache.mtime && localCatalogueCache.data) return localCatalogueCache.data;
    const data = readStoredCatalogue(localCatalogueFile);
    localCatalogueCache = { mtime: stat.mtimeMs, data };
    return data;
  } catch {
    localCatalogueCache = { mtime: 0, data: null };
    return null;
  }
}

function combinedArtMap() {
  const map = new Map(testingArtMap());
  const stored = storedLocalCatalogue();
  if (!stored) return map;
  for (const [key, url] of artMapFromCatalogue(partitionSelectedCards(stored).live)) {
    if (!map.has(key)) map.set(key, url);
  }
  return map;
}

function outgoing(value) {
  const cardArtEnabled = cardArtRequested();
  return presentClientPayload(value, {
    photosEnabled: photosRequested(),
    cardArtEnabled,
    cardArtFileExists: cardArtEnabled ? cardArtFileExistsIn(cardArtRoot) : null,
    testingArt: cardArtEnabled ? combinedArtMap() : null
  });
}

app.get('/api/cards', (req, res) => {
  const cards = deckManager?.allCards || [];
  res.json({
    success: true,
    source: 'image-catalogue',
    count: cards.length,
    excluded: livePoolReport?.excluded?.length || 0,
    duplicateImageAssignments: livePoolReport?.duplicateImageAssignments?.length || 0,
    cards: outgoing(cards.slice(0, 10))
  });
});

/**
 * Image catalogue browser. The auction deck is the same selected-card pool.
 */
app.get('/api/local-catalogue', (req, res) => {
  const stored = partitionSelectedCards(storedLocalCatalogue()).live;
  if (!stored?.players?.length) {
    return res.status(404).json({
      success: false,
      liveAuctionActivated: false,
      error: 'Local catalogue has not been imported.'
    });
  }
  const cardsByPlayer = new Map(
    (stored.cards || []).filter((card) => card.isPrimary !== false).map((card) => [card.playerId, card])
  );
  const client = [];
  for (const player of stored.players) {
    const card = cardsByPlayer.get(player.playerId);
    if (!card) continue;
    client.push(toClientCard(player, card));
  }
  client.sort((left, right) => left.name.localeCompare(right.name) || String(left.id).localeCompare(String(right.id)));
  const audit = auditLocalCatalogue(stored, cardArtRoot, []);
  res.json({
    success: true,
    liveAuctionActivated: false,
    auctionEligible: false,
    count: client.length,
    audit: {
      totalPlayerIdentities: audit.totalPlayerIdentities,
      totalSelectedCards: audit.totalSelectedCards,
      imagesServed: audit.imagesServed,
      missingImageFiles: audit.missingImageFiles.length,
      brokenPaths: audit.brokenPaths.length,
      duplicateImageAssignments: audit.duplicateImageAssignments.length,
      playersWithFallback: audit.playersWithFallback
    },
    players: outgoing(client)
  });
});

/**
 * Get leaderboard
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const leaderboard = await getLeaderboard(limit);
    
    res.json({
      success: true,
      count: leaderboard.length,
      leaderboard
    });
  } catch (err) {
    logWithTime(`Error fetching leaderboard: ${err.message}`, 'ERROR');
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

/**
 * Get player stats
 */
app.get('/api/player/:username', async (req, res) => {
  try {
    const player = await Player.findOne({ username: req.params.username }).lean();
    
    if (!player) {
      return res.status(404).json({ success: false, error: 'Player not found' });
    }

    const leaderboard = await Leaderboard.findOne({ playerId: player._id }).lean();
    
    res.json({
      success: true,
      player,
      leaderboard
    });
  } catch (err) {
    logWithTime(`Error fetching player: ${err.message}`, 'ERROR');
    res.status(500).json({ success: false, error: 'Failed to fetch player' });
  }
});

/**
 * Get game history
 */
app.get('/api/games/:username', async (req, res) => {
  try {
    const player = await Player.findOne({ username: req.params.username }).lean();
    
    if (!player) {
      return res.status(404).json({ success: false, error: 'Player not found' });
    }

    const games = await Game.find(
      { 'players.playerId': player._id },
      null,
      { sort: { createdAt: -1 }, limit: 20 }
    ).lean();
    
    res.json({
      success: true,
      count: games.length,
      games
    });
  } catch (err) {
    logWithTime(`Error fetching games: ${err.message}`, 'ERROR');
    res.status(500).json({ success: false, error: 'Failed to fetch games' });
  }
});

app.use((err, req, res, next) => {
  logWithTime(`Request failed: ${err?.message || 'unknown error'}`, 'ERROR');
  productionErrorHandler(err, req, res, next);
});

// ============================================================================
// SOCKET.IO EVENT HANDLERS
// ============================================================================

const CHEAPEST_BID = GAME_CONFIG.CARD_CATEGORIES.BASIC.basePrice + GAME_CONFIG.MIN_BID_INCREMENT;

function overlayLineup(roomCode, squad) {
  const players = roomManager.getRoomPlayers(roomCode);
  const live = players.find((player) => player.username === squad.username)
    || players.find((player) => player.id === squad.id);
  if (!live) return squad;
  const lineup = lineupView(live);
  return {
    ...squad,
    id: live.id,
    formation: lineup.formation,
    confirmed: lineup.confirmed,
    strength: typeof lineup.evaluation?.strength === 'number' ? lineup.evaluation.strength : null
  };
}

function buildSquads(roomCode) {
  return roomManager.getRoomPlayers(roomCode).map((player) => overlayLineup(roomCode, {
    id: player.id,
    username: player.username,
    balance: player.balance,
    cards: player.team || []
  }));
}

function squadsFor(roomCode, playerId) {
  const room = roomManager.getRoom(roomCode);
  const saved = room?.finalSquads;
  if (!saved?.length) return buildSquads(roomCode);

  const live = buildSquads(roomCode);
  return saved.map((squad) => {
    const current = live.find((player) => player.id === playerId && player.username === squad.username)
      || live.find((player) => player.username === squad.username);
    return overlayLineup(roomCode, {
      ...squad,
      id: current?.id || squad.id,
      cards: squad.cards || []
    });
  });
}

function restoreFinishedSeat(room, player) {
  if (!room || !player) return;
  roomManager.applySavedSquad(room.code, player.id);
}

function clearRoomDecks(roomCode) {
  deckManager?.clearRoomDeck(roomCode);
}

function auctionSnapshot(roomCode, playerId) {
  const roomPlayer = roomManager.getPlayer(roomCode, playerId);
  const state = auctionEngine.getPublicState(roomCode, playerId, roomPlayer?.team);
  if (!state) return null;
  if (state.phase === 'finished') {
    state.squads = squadsFor(roomCode, playerId);
    state.lineup = lineupView(roomPlayer);
    const room = roomManager.getRoom(roomCode);
    if (room) state.rematch = rematchPayload(room);
  } else if (state.youSpectating) {
    state.squads = buildSquads(roomCode);
  }
  const room = roomManager.getRoom(roomCode);
  if (room?.matchResults) state.match = room.matchResults;
  if (room?.departedSeats?.length) {
    state.departed = room.departedSeats.map((seat) => ({
      username: seat.username,
      balance: seat.balance,
      cardCount: seat.team?.length || 0,
      squadStatus: seat.squadStatus
    }));
  }
  return outgoing(state);
}

function emitSquadsToSpectators(io, roomCode) {
  const spectatorIds = auctionEngine.readySnapshot(roomCode).spectatorIds;
  if (!spectatorIds.length) return;
  const squads = buildSquads(roomCode);
  for (const id of spectatorIds) {
    io.to(id).emit('auction:spectator-squads', { squads });
  }
}

function anyoneCanAffordACard(roomCode) {
  const auction = auctionEngine.getAuction(roomCode);
  if (!auction) return false;
  return Array.from(auction.players.values()).some((player) => player.balance >= CHEAPEST_BID);
}

function rematchPayload(room) {
  if (!room) return { voters: [], voted: 0, total: 0 };
  return roomManager.rematchStatus(room.code);
}

function broadcastRematch(io, roomCode) {
  const room = roomManager.getRoom(roomCode);
  if (!room) return;
  io.to(roomCode).emit('auction:rematch-update', rematchPayload(room));
}

async function beginRematch(io, roomCode) {
  const room = roomManager.getRoom(roomCode);
  if (!room || room.rematchStarting) return false;

  const auction = auctionEngine.getAuction(roomCode);
  if (!auction || auction.phase !== 'finished') return false;

  const players = roomManager.getRoomPlayers(roomCode);
  const votes = room.rematchVotes || new Set();
  if (players.length === 0 || !players.every((player) => votes.has(player.username))) {
    return false;
  }

  roomManager.resetForRematch(roomCode);
  auctionEngine.clearTimer(roomCode);
  auctionEngine.clearTransitions(roomCode);

  const deck = deckManager.initializeRoomDeck(roomCode);
  const started = auctionEngine.startAuction(roomCode, deck, room.players);
  if (!started) {
    roomManager.finishRematchSetup(roomCode);
    await commit(roomCode);
    logWithTime(`Rematch failed in ${roomCode}: no cards`, 'ERROR');
    return false;
  }

  roomManager.startAuction(roomCode);
  await commit(roomCode);

  io.to(roomCode).emit('auction:rematch-started', {
    totalPlayers: room.players.size,
    totalCards: deck.length
  });
  io.to(roomCode).emit('room:players-updated', {
    players: presentPlayers(roomCode)
  });
  await openNextCard(io, roomCode);
  logWithTime(`Rematch started in ${roomCode}`);
  return true;
}

function markAuctionFinished(roomCode) {
  auctionEngine.clearTimer(roomCode);
  auctionEngine.clearTransitions(roomCode);
  const auction = auctionEngine.getAuction(roomCode);
  if (auction) {
    auction.phase = 'finished';
    auction.waitingForReady = false;
  }
  const squads = buildSquads(roomCode);
  if (roomManager.getRoom(roomCode)) roomManager.saveFinalSquads(roomCode, squads);
  return squads;
}

function broadcastAuctionFinished(io, roomCode, reason, squads) {
  const fresh = roomManager.getRoom(roomCode);
  io.to(roomCode).emit('auction:finished', {
    reason,
    squads,
    rematch: fresh ? rematchPayload(fresh) : { voters: [], voted: 0, total: 0 }
  });
  if (fresh) {
    for (const player of fresh.players.values()) {
      if (!player.id) continue;
      const state = auctionSnapshot(roomCode, player.id);
      if (state) io.to(player.id).emit('auction:state', state);
    }
  }
  logWithTime(`Auction finished in ${roomCode} (${reason})`);
}

async function emitAuctionFinished(io, roomCode, reason) {
  const squads = markAuctionFinished(roomCode);
  await publishFinishedHandoffs(roomCode);
  await commit(roomCode);
  broadcastAuctionFinished(io, roomCode, reason, squads);
}

function ack(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

function publicPlayer(player, room = null) {
  return {
    id: player.id,
    username: player.username,
    balance: player.balance,
    teamSize: player.team?.length || 0,
    isOnline: player.isOnline !== false,
    isHost: Boolean(room?.hostSeatId && player.seatId === room.hostSeatId)
  };
}

function presentPlayers(roomCode) {
  const room = roomManager.getRoom(roomCode);
  return roomManager.getRoomPlayers(roomCode).map((player) => publicPlayer(player, room));
}

function biddingTable(roomCode) {
  const live = auctionEngine.getAuction(roomCode);
  if (!live || live.phase !== 'bidding') return null;
  const state = auctionEngine.getPublicState(roomCode, null, []);
  if (!state) return null;
  return {
    bids: state.bids,
    minimumBid: state.minimumBid,
    bidIncrement: state.bidIncrement,
    highestBid: state.highestBid
  };
}

function applyCardAward(roomCode, result) {
  if (!result?.winnerId) return result;
  const card = result.card || { id: result.cardId, name: result.cardName };
  const added = roomManager.addCardToTeam(roomCode, result.winnerId, card);
  const auctionPlayer = auctionEngine.getAuction(roomCode)?.players.get(result.winnerId);
  const roomPlayer = roomManager.getPlayer(roomCode, result.winnerId);
  if (!added) {
    auctionEngine.refundSale(roomCode, result.winnerId, result.finalPrice, result.cardId);
    return {
      ...result,
      status: 'discarded',
      winnerId: null,
      winnerUsername: null,
      finalPrice: 0
    };
  }
  if (auctionPlayer && roomPlayer) roomPlayer.balance = auctionPlayer.balance;
  return result;
}

function emitPlayers(io, roomCode) {
  const room = roomManager.getRoom(roomCode);
  if (!room) return;
  io.to(roomCode).emit('room:players-updated', {
    players: presentPlayers(roomCode)
  });
}

function scheduleNextCard(io, roomCode) {
  auctionEngine.scheduleTransition(roomCode, 'next-card', auctionGapMs('next-card'), () => {
    openNextCard(io, roomCode).catch((err) => {
      logWithTime(`Next card failed in ${roomCode}: ${err.message}`, 'ERROR');
    });
  });
}

async function afterMembershipChange(io, roomCode, change) {
  if (!change?.removed && !change?.updated) return;
  if (change.allSkipped) {
    auctionEngine.clearTimer(roomCode);
    await autoResolveCard(io, roomCode);
    return;
  }
  if (change.allReady && auctionEngine.claimAdvance(roomCode)) {
    scheduleNextCard(io, roomCode);
    await commit(roomCode);
  }
}

async function openNextCard(io, roomCode) {
  const auction = auctionEngine.getAuction(roomCode);
  if (!auction || auction.phase === 'finished') return;

  auctionEngine.clearTransitions(roomCode);
  auctionEngine.resetReadyPlayers(roomCode);

  const deckLength = auction.deck?.length || 0;
  for (let attempt = 0; attempt <= deckLength; attempt += 1) {
    if (!anyoneCanAffordACard(roomCode)) {
      await emitAuctionFinished(io, roomCode, 'no-budget');
      return;
    }

    const nextCard = auctionEngine.presentNextCard(roomCode);
    if (nextCard?.blocked) {
      await commit(roomCode);
      return;
    }
    if (!nextCard) {
      await emitAuctionFinished(io, roomCode, 'deck-empty');
      return;
    }

    const live = auctionEngine.getAuction(roomCode);
    const minimumBid = auctionEngine.calculateMinimumBid(nextCard.basePrice);
    const passedPlayerIds = [];
    const online = [...live.players.values()].filter((player) => player.online !== false);

    // A restart marks every seat offline. Skipping in that case would discard
    // the rest of the deck before anyone can reconnect. With nobody here, leave
    // the card up and let the bidding clock run.
    if (online.length > 0) {
      for (const player of online) {
        if (player.balance < minimumBid) {
          auctionEngine.processSkip(roomCode, player.id);
          passedPlayerIds.push(player.id);
        }
      }

      const stillBidding = online.filter((player) => !player.hasSkipped);
      if (stillBidding.length === 0) {
        auctionEngine.resolveCard(roomCode);
        continue;
      }
    }

    const table = auctionEngine.readySnapshot(roomCode);
    auctionEngine.setTimerCallback(roomCode, () => {
      autoResolveCard(io, roomCode).catch((err) => {
        logWithTime(`Auction timer failed in ${roomCode}: ${err.message}`, 'ERROR');
      });
    });
    await commit(roomCode);
    io.to(roomCode).emit('auction:card-presented', outgoing({
      card: nextCard,
      currentIndex: live.currentCardIndex,
      totalCards: live.deck.length,
      minimumBid,
      bidIncrement: Validator.bidStep(nextCard.basePrice),
      passedPlayerIds,
      spectatorIds: table.spectatorIds,
      cheapestBid: table.cheapestBid
    }));
    emitSquadsToSpectators(io, roomCode);
    return;
  }

  await emitAuctionFinished(io, roomCode, 'no-budget');
}

/**
 * AUTO-RESOLVE CARD WHEN TIMER EXPIRES
 */
function emitReadyPrompt(io, roomCode) {
  const auction = auctionEngine.getAuction(roomCode);
  if (!auction || auction.phase !== 'waiting-for-ready') return;
  const table = auctionEngine.readySnapshot(roomCode);
  io.to(roomCode).emit('auction:waiting-for-ready', {
    message: 'Get ready for the next card!',
    readyPlayers: table.readyPlayers,
    readyCount: table.readyCount,
    totalPlayers: table.totalPlayers,
    spectatorIds: table.spectatorIds,
    cheapestBid: table.cheapestBid
  });
}

async function autoResolveCard(io, roomCode) {
  auctionEngine.clearTimer(roomCode);
  const resolved = auctionEngine.resolveCard(roomCode);
  
  if (!resolved) {
    await commit(roomCode);
    return;
  }
  const result = applyCardAward(roomCode, resolved);
  const finished = !anyoneCanAffordACard(roomCode);
  let squads = null;
  if (finished) {
    squads = markAuctionFinished(roomCode);
    await publishFinishedHandoffs(roomCode);
  } else {
    auctionEngine.setWaitingForReady(roomCode);
    auctionEngine.scheduleTransition(roomCode, 'ready-prompt', auctionGapMs('ready-prompt'), () => {
      emitReadyPrompt(io, roomCode);
    });
  }
  await commit(roomCode);

  io.to(roomCode).emit('auction:card-result', outgoing(result));
  emitPlayers(io, roomCode);
  emitSquadsToSpectators(io, roomCode);
  if (finished) broadcastAuctionFinished(io, roomCode, 'no-budget', squads);
}

function dropOfflineSeat(roomCode, seatId) {
  const room = roomManager.getRoom(roomCode);
  if (!room) return;
  const player = [...room.players.values()].find((seat) => seat.seatId === seatId);
  if (!player || player.isOnline) return;
  if (player.disconnectDeadline && player.disconnectDeadline > Date.now()) return;

  roomManager.removeRematchVote(roomCode, player.username);
  roomManager.removePlayerFromRoom(roomCode, player.id);
  auctionEngine.detachPlayer(roomCode, player.id);
  if (!roomManager.getRoom(roomCode) || (auctionEngine.getAuction(roomCode)?.players.size || 0) === 0) {
    auctionEngine.clearAuction(roomCode);
    clearRoomDecks(roomCode);
  }
  commit(roomCode).then(() => {
    const players = roomManager.getRoomPlayers(roomCode);
    io.to(roomCode).emit('room:player-left', {
      playerId: player.id,
      remainingPlayers: players.length,
      players: presentPlayers(roomCode)
    });
    broadcastRematch(io, roomCode);
    beginRematch(io, roomCode);
  }).catch((err) => {
    logWithTime(`Failed to drop offline seat in ${roomCode}: ${err.message}`, 'ERROR');
  });
}

function rearmSeatRemoval(roomCode) {
  const room = roomManager.getRoom(roomCode);
  if (!room) return;
  const auction = auctionEngine.getAuction(roomCode);
  if (auction && auction.phase !== 'finished') return;
  for (const player of [...room.players.values()]) {
    if (player.isOnline || !player.disconnectDeadline) continue;
    const delay = Math.max(0, player.disconnectDeadline - Date.now());
    const seatId = player.seatId;
    setTimeout(() => dropOfflineSeat(roomCode, seatId), delay);
  }
}

/**
 * Put timers back on a room loaded from MongoDB.
 * An elapsed bidding deadline is resolved before the server accepts clients.
 * A future deadline keeps its original end time.
 */
async function settleRecoveredRoom(roomCode) {
  const auction = auctionEngine.getAuction(roomCode);
  const now = Date.now();

  if (auction?.phase === 'bidding') {
    const deadline = (auction.timerStarted || now) + (auction.timerDuration || 30000);
    if (deadline <= now) {
      await autoResolveCard(io, roomCode);
    } else {
      auctionEngine.resumeTimer(roomCode, () => {
        autoResolveCard(io, roomCode).catch((err) => {
          logWithTime(`Recovered timer failed in ${roomCode}: ${err.message}`, 'ERROR');
        });
      });
    }
  } else if (auction?.phase === 'advancing') {
    await openNextCard(io, roomCode);
  } else if (auction) {
    const pending = [...(auction.transitionDeadlines?.entries() || [])];
    for (const [key, dueAt] of pending) {
      if (key === 'next-card' && dueAt <= now) {
        await openNextCard(io, roomCode);
        continue;
      }
      if (dueAt <= now) {
        auction.transitionDeadlines.delete(key);
        continue;
      }
      auctionEngine.scheduleTransition(roomCode, key, dueAt - now, () => {
        if (key === 'next-card') {
          openNextCard(io, roomCode).catch((err) => {
            logWithTime(`Recovered transition failed in ${roomCode}: ${err.message}`, 'ERROR');
          });
        } else if (key === 'ready-prompt') {
          emitReadyPrompt(io, roomCode);
        }
      });
    }
  }

  rearmSeatRemoval(roomCode);
  roomStore.touch(roomCode);
  if (auctionEngine.getAuction(roomCode)?.phase === 'finished') {
    await publishFinishedHandoffs(roomCode);
  }
}

io.on('connection', (socket) => {
  logWithTime(`Socket connected: ${socket.id}`);
  bindLeagueSocket(socket, io, () => leagueService);
  
  /**
   * PLAYER JOINS ROOM
   */
  socket.on('room:join', observe(async (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const { username, roomCode } = data || {};
    
    // Validate input
    const validation = Validator.validatePlayerJoin(username, roomCode);
    if (!validation.valid) {
      return reply({ success: false, error: validation.error, message: validation.message });
    }
    if (!roomJoinLimit.allow(socketAddress(socket))) {
      return reply({
        success: false,
        error: 'RATE_LIMITED',
        message: 'Too many join attempts. Wait a moment and try again.'
      });
    }
    
    try {
      const room = roomManager.getRoom(roomCode);

      if (!room) {
        return reply({
          success: false,
          error: ERROR_CODES.ROOM_NOT_FOUND,
          message: 'Room not found. Check the code or create a new room.'
        });
      }

      const existingSeat = [...room.players.values()].find((player) => player.username === username);
      if (!existingSeat && room.status && room.status !== 'waiting') {
        return reply({
          success: false,
          error: ERROR_CODES.ROOM_ALREADY_STARTED,
          message: 'This room is closed to new players.'
        });
      }

      const playerId = socket.id;
      const previousId = Array.from(room.players.values()).find((player) => player.username === username)?.id;
      const seat = roomManager.takeSeat(roomCode, playerId, username, data?.seatToken);
      if (seat.error === 'full') {
        return reply({
          success: false,
          error: ERROR_CODES.ROOM_FULL,
          message: `Room is full (max ${GAME_CONFIG.MAX_PLAYERS_PER_ROOM} players)`
        });
      }
      if (seat.error === 'seat-taken') {
        return reply({
          success: false,
          error: ERROR_CODES.UNAUTHORIZED,
          message: 'That name is already in this room. Reopen the browser that joined, or choose another name.'
        });
      }
      if (!seat.player) {
        return reply({
          success: false,
          error: 'Failed to join room',
          message: 'Could not add you to the room.'
        });
      }

      restoreFinishedSeat(room, seat.player);

      if (previousId && previousId !== playerId) {
        const previousSocket = io.sockets.sockets.get(previousId);
        if (previousSocket) {
          previousSocket.leave(roomCode);
          previousSocket.data.roomCode = null;
          previousSocket.data.playerId = null;
          previousSocket.data.username = null;
          previousSocket.emit('room:session-replaced', {
            roomCode,
            message: 'This seat was opened in another session.'
          });
        }
      }

      // Stats persistence is optional. A dead Mongo connection must not block the lobby.
      let dbPlayerId = null;
      if (dbConnected) {
        const player = await getOrCreatePlayer(username);
        dbPlayerId = player._id;
      }

      auctionEngine.attachPlayer(roomCode, playerId, username, seat.player.balance);
      await commit(roomCode);

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.playerId = playerId;
      socket.data.username = username;
      socket.data.dbPlayerId = dbPlayerId;
      
      // Broadcast update
      const players = presentPlayers(roomCode);
      io.to(roomCode).emit('room:player-joined', {
        players
      });
      
      const auctionState = auctionSnapshot(roomCode, playerId);
      if (auctionState?.phase === 'waiting-for-ready' || auctionState?.waitingForReady) {
        io.to(roomCode).emit('auction:player-ready-update', {
          readyPlayers: auctionState.readyPlayers,
          readyCount: auctionState.readyCount,
          totalPlayers: auctionState.totalPlayers
        });
      }
      if (auctionState && (auctionState.card || auctionState.phase === 'finished' || auctionState.waitingForReady)) {
        socket.emit('auction:state', auctionState);
      }
      
      const joinedRoom = roomManager.getRoom(roomCode);
      reply({
        success: true,
        playerId,
        roomCode,
        ...(typeof seat.seatToken === 'string' ? { seatToken: seat.seatToken } : {}),
        balance: auctionState?.yourBalance ?? seat.player.balance,
        auction: auctionState,
        players,
      });
    } catch (err) {
      logWithTime(`Error joining room: ${err.message}`, 'ERROR');
      reply({ success: false, error: 'Failed to join room', message: 'Failed to join room' });
    }
  }));
  
  /**
   * PLAYER LEAVES ROOM
   */
  socket.on('room:leave', async (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    if (socket.data?.leaveInFlight) {
      return reply({ success: true, alreadyLeft: true });
    }
    socket.data.leaveInFlight = true;

    let roomCode = socket.data?.roomCode;
    let playerId = socket.data?.playerId;
    let username = socket.data?.username;
    if (!roomCode || !playerId) {
      const located = roomManager.findSeatByToken(data?.seatToken);
      if (located && (!data?.roomCode || located.roomCode === data.roomCode)) {
        const seated = roomManager.getRoom(located.roomCode);
        const player = [...(seated?.players.values() || [])].find((seat) => seat.seatId === located.seatId);
        if (player) {
          roomCode = located.roomCode;
          playerId = player.id;
          username = player.username;
        }
      }
    }

    if (!roomCode || !playerId || !roomManager.getPlayer(roomCode, playerId)) {
      socket.data.roomCode = null;
      socket.data.playerId = null;
      socket.data.username = null;
      return reply({ success: true, alreadyLeft: true });
    }

    try {
      roomManager.removeRematchVote(roomCode, username);
      const removed = roomManager.removePlayerFromRoom(roomCode, playerId);
      const detached = auctionEngine.detachPlayer(roomCode, playerId);
      socket.leave(roomCode);
      socket.data.roomCode = null;
      socket.data.playerId = null;
      socket.data.username = null;

      const stillThere = roomManager.getRoom(roomCode);
      const auctionPlayers = auctionEngine.getAuction(roomCode)?.players.size || 0;
      if (!stillThere || auctionPlayers === 0) {
        auctionEngine.clearAuction(roomCode);
        clearRoomDecks(roomCode);
      }

      await commit(roomCode);
      const roomNow = roomManager.getRoom(roomCode);
      const playersNow = auctionEngine.getAuction(roomCode)?.players.size || 0;
      if (!roomNow || playersNow === 0) {
        auctionEngine.clearAuction(roomCode);
        clearRoomDecks(roomCode);
      }
      const departed = (roomNow?.departedSeats || []).find((seat) => seat.username === username) || null;
      const table = biddingTable(roomCode);
      io.to(roomCode).emit('room:player-left', {
        playerId,
        remainingPlayers: presentPlayers(roomCode).length,
        players: presentPlayers(roomCode),
        hostUsername: roomNow?.hostUsername || null,
        departed: departed ? {
          username: departed.username,
          cardCount: departed.team?.length || 0,
          balance: departed.balance,
          squadStatus: departed.squadStatus
        } : null,
        ...(table || {})
      });
      if (roomNow && auctionEngine.getAuction(roomCode)?.players.size > 0) {
        await afterMembershipChange(io, roomCode, detached);
      }
      broadcastRematch(io, roomCode);
      await beginRematch(io, roomCode);
      reply({ success: true, removed });
    } catch (err) {
      socket.data.leaveInFlight = false;
      logWithTime(`Error leaving room: ${err.message}`, 'ERROR');
      reply({ success: false, error: 'Failed to leave room', message: 'Could not leave the auction.' });
    }
  });
  
  /**
   * START AUCTION
   */
  socket.on('room:start-auction', observe(async (data, callback) => {
    const { roomCode } = socket.data || {};
    
    if (!roomCode) {
      return ack(callback, { success: false, error: 'Not in a room' });
    }
    
    const room = roomManager.getRoom(roomCode);
    if (!room) {
      return ack(callback, { success: false, error: 'Room not found' });
    }
    
    if (room.players.size < 1) {
      return ack(callback, { success: false, error: 'Need at least 1 player' });
    }

    const existingAuction = auctionEngine.getAuction(roomCode);
    if (existingAuction && existingAuction.phase !== 'finished') {
      return ack(callback, {
        success: false,
        error: ERROR_CODES.ROOM_ALREADY_STARTED,
        message: 'Auction already started'
      });
    }
    
    const deck = deckManager.initializeRoomDeck(roomCode);
    
    // Start auction engine
    const started = auctionEngine.startAuction(roomCode, deck, room.players);
    if (!started) {
      return ack(callback, { success: false, error: 'NO_CARDS', message: 'No cards are available to auction' });
    }
    roomManager.startAuction(roomCode);
    roomManager.noteActivity(roomCode);
    await commit(roomCode);
    
    io.to(roomCode).emit('auction:started', {
      totalPlayers: room.players.size,
      totalCards: deck.length,
    });

    await openNextCard(io, roomCode);
    
    ack(callback, { success: true });
  }));

  /**
   * REMATCH
   * Starts a new auction only after every player still in the room agrees.
   */
  socket.on('auction:rematch', async (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const { roomCode, username } = socket.data || {};

    if (!roomCode || !username) {
      return reply({ success: false, error: 'Not in a room', message: 'Not in a room' });
    }

    const room = roomManager.getRoom(roomCode);
    const auction = auctionEngine.getAuction(roomCode);
    if (!room || !auction || auction.phase !== 'finished') {
      return reply({
        success: false,
        error: 'AUCTION_NOT_FINISHED',
        message: 'Rematch is available when the auction is over.'
      });
    }

    const status = roomManager.addRematchVote(roomCode, username);
    await commit(roomCode);
    io.to(roomCode).emit('auction:rematch-update', status);
    reply({ success: true, ...status });
    await beginRematch(io, roomCode);
  });
  
  /**
   * PLACE BID
   */
  socket.on('auction:bid', observe(async (data, callback) => {
    const { roomCode, playerId } = socket.data || {};
    const { bidAmount } = data || {};
    
    if (!roomCode || !playerId) {
      return ack(callback, { success: false, error: 'Not in a room' });
    }
    
    const result = auctionEngine.processBid(roomCode, playerId, bidAmount);
    
    if (!result.success) {
      return ack(callback, { success: false, error: result.error, message: result.message, details: result });
    }
    roomManager.noteActivity(roomCode);
    
    const player = roomManager.getPlayer(roomCode, playerId);
    const liveAuction = auctionEngine.getAuction(roomCode);
    if (liveAuction) {
      liveAuction.timerDuration = Math.min(15000, auctionTimerMs());
      auctionEngine.setTimerCallback(roomCode);
    }
    await commit(roomCode);

    io.to(roomCode).emit('auction:bid-received', {
      playerId,
      playerUsername: player?.username || result.username,
      bidAmount: result.bidAmount,
      highestBid: result.newHighestBid,
      minimumBid: result.minimumBid,
      bidIncrement: result.bidIncrement
    });
    
    ack(callback, {
      success: true,
      bidAmount: result.bidAmount,
      playerUsername: player?.username || result.username,
      highestBid: result.newHighestBid,
      minimumBid: result.minimumBid,
      bidIncrement: result.bidIncrement
    });
  }));
  
  /**
   * PLAYER READY FOR NEXT CARD
   */
  socket.on('auction:player-ready', async (data, callback) => {
    const { roomCode, playerId } = socket.data || {};
    
    if (!roomCode || !playerId) {
      return ack(callback, { success: false, error: 'Not in a room' });
    }
    
    const result = auctionEngine.setPlayerReady(roomCode, playerId);
    
    if (!result.success) {
      return ack(callback, result);
    }

    if (result.spectating) {
      return ack(callback, { success: true, spectating: true });
    }

    if (result.alreadyAdvancing) {
      return ack(callback, { success: true, alreadyAdvancing: true });
    }
    roomManager.noteActivity(roomCode);
    if (result.allReady) scheduleNextCard(io, roomCode);
    await commit(roomCode);
    
    const player = roomManager.getPlayer(roomCode, playerId);
    io.to(roomCode).emit('auction:player-ready-update', {
      playerId,
      playerUsername: player?.username || 'Player',
      readyCount: result.readyCount,
      totalPlayers: result.totalPlayers
    });
    
    ack(callback, { success: true });
  });
  
  /**
   * SKIP CARD
   */
  socket.on('auction:skip', async (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const { roomCode, playerId } = socket.data || {};
    
    if (!roomCode || !playerId) {
      return reply({ success: false, error: 'Not in a room' });
    }
    
    const result = auctionEngine.processSkip(roomCode, playerId);
    
    if (!result.success) {
      return reply({ success: false, error: result.error, message: result.message });
    }
    
    await commit(roomCode);

    io.to(roomCode).emit('auction:player-skipped', {
      playerId,
      playerUsername: result.username,
      skippedCount: result.skippedCount,
      allSkipped: result.allSkipped,
      highestBid: result.highestBid,
      minimumBid: result.minimumBid,
      bidIncrement: result.bidIncrement,
      bids: result.bids
    });
    
    reply({ success: true, ...result });

    if (result.allSkipped && !result.alreadySkipped) {
      auctionEngine.clearTimer(roomCode);
      await autoResolveCard(io, roomCode);
    }
  });
  
  /**
   * RESOLVE CARD
   */
  socket.on('auction:resolve-card', async (data, callback) => {
    const { roomCode } = socket.data || {};
    
    if (!roomCode) {
      return ack(callback, { success: false, error: 'Not in a room' });
    }

    // Clients cannot close a card early. The timer and an all-pass do that.
    if (!auctionEngine.canForceResolve(roomCode)) {
      return ack(callback, {
        success: false,
        error: ERROR_CODES.AUCTION_NOT_ACTIVE,
        message: 'This card is still open for bids.'
      });
    }

    await autoResolveCard(io, roomCode);
    ack(callback, { success: true });
  });
  
  /**
   * SQUAD LINEUP
   * The client names places and card ids. Ownership, duplicates, formation,
   * and the revision check are decided here. Ratings in the payload are ignored.
   */
  socket.on('squad:update', async (data, callback) => {
    const { roomCode, playerId } = socket.data || {};
    const payload = data || {};

    if (!roomCode || !playerId) {
      return ack(callback, { success: false, error: 'Not in a room', message: 'Not in a room' });
    }

    const auction = auctionEngine.getAuction(roomCode);
    const result = updateSeatLineup(
      roomManager,
      roomCode,
      playerId,
      payload,
      auction?.phase
    );

    if (!result.ok) {
      return ack(callback, {
        success: false,
        error: result.error,
        message: result.message,
        lineup: result.lineup || null
      });
    }

    if (!result.unchanged) await commit(roomCode);
    ack(callback, { success: true, lineup: result.lineup });
    if (!result.unchanged && result.lineup) {
      io.to(roomCode).emit('squad:updated', {
        playerId,
        formation: result.lineup.formation,
        confirmed: result.lineup.confirmed,
        strength: typeof result.lineup.evaluation?.strength === 'number'
          ? result.lineup.evaluation.strength
          : null
      });
    }
  });

  /**
   * BUILD TEAM
   */
  socket.on('team:build', async (data, callback) => {
    const { roomCode, playerId } = socket.data || {};
    const { selectedCards, formation } = data || {};

    try {
      const result = commitBuiltTeam(roomManager, roomCode, playerId, {
        source: 'build',
        selectedCards,
        formation
      });
      if (!result.ok) {
        return callback({ success: false, error: result.error, message: result.message });
      }
      await commit(roomCode);
      const player = roomManager.getPlayer(roomCode, playerId);
      io.to(roomCode).emit('team:built', {
        playerId,
        username: player?.username,
        teamOverall: result.overall,
        formation: result.formation
      });
      callback({
        success: true,
        team: outgoing(result.team),
        overall: result.overall,
        formation: result.formation,
        lineup: result.lineup
      });
    } catch (err) {
      logWithTime(`Error building team: ${err.message}`, 'ERROR');
      callback({ success: false, error: err.message });
    }
  });
  
  /**
   * AUTO-BUILD TEAM
   */
  socket.on('team:auto-build', async (data, callback) => {
    const { roomCode, playerId } = socket.data;
    const { formation } = data || {};

    try {
      const result = commitBuiltTeam(roomManager, roomCode, playerId, {
        source: 'auto',
        formation
      });
      if (!result.ok) {
        return callback({ success: false, error: result.error, message: result.message });
      }
      await commit(roomCode);
      const player = roomManager.getPlayer(roomCode, playerId);
      io.to(roomCode).emit('team:built', {
        playerId,
        username: player?.username,
        teamOverall: result.overall,
        formation: result.formation
      });
      callback({
        success: true,
        team: outgoing(result.team),
        overall: result.overall,
        formation: result.formation,
        lineup: result.lineup
      });
    } catch (err) {
      logWithTime(`Error auto-building team: ${err.message}`, 'ERROR');
      callback({ success: false, error: err.message });
    }
  });
  
  /**
   * START MATCH/TOURNAMENT
   * This simulates the live room only. It does not record a league fixture.
   * League scores are written later by recordFixtureResult, which stores the
   * room code and saved game id when the caller has them. This screen is not
   * that result.
   */
  socket.on('match:start', async (data, callback) => {
    const { roomCode } = socket.data;
    
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      if (room.matchResults) {
        const results = outgoing(room.matchResults);
        io.to(roomCode).emit('match:results', results);
        return callback({ success: true, results, alreadyRecorded: true });
      }
      
      // Get all players with built teams
      const players = Array.from(room.players.values());
      const teamsReady = players.filter(p => p.teamBuilt && p.builtTeam);
      
      if (teamsReady.length < 2) {
        return callback({ success: false, error: 'Need at least 2 teams ready' });
      }

      const shortSquad = teamsReady.find((player) => player.builtTeam?.length !== GAME_CONFIG.REQUIRED_TEAM_SIZE);
      if (shortSquad) {
        return callback({
          success: false,
          error: `Match squad must have exactly ${GAME_CONFIG.REQUIRED_TEAM_SIZE} players`
        });
      }
      
      // Prepare teams for simulation
      const teams = teamsReady.map(p => ({
        playerId: p.id,
        username: p.username,
        team: p.builtTeam,
        overall: p.teamOverall,
        formation: p.formation
      }));
      
      // Simulate tournament
      const tournament = simulateTournament(teams, 'round-robin');
      
      const recorded = roomManager.recordMatch(roomCode, tournament);
      if (!recorded) {
        return callback({ success: false, error: 'Room not found' });
      }
      if (!recorded.alreadyRecorded) {
        await commit(roomCode);
        if (dbConnected) {
          for (const standing of recorded.results.standings || []) {
            const player = players.find(p => p.id === standing.playerId);
            if (player && socket.data.dbPlayerId) {
              await updatePlayerStats(player.username, {
                gamesPlayed: 1,
                wins: standing.won,
                moneySpent: GAME_CONFIG.INITIAL_BALANCE - player.balance,
                cardsWon: player.team.length
              });
            }
          }
        }
      }
      
      const results = outgoing(recorded.results);
      io.to(roomCode).emit('match:results', results);
      
      callback({ success: true, results, alreadyRecorded: recorded.alreadyRecorded });
    } catch (err) {
      logWithTime(`Error starting match: ${err.message}`, 'ERROR');
      callback({ success: false, error: err.message });
    }
  });
  
  /**
   * CURRENT AUCTION SNAPSHOT
   * The auction page mounts after card-presented has already been sent.
   */
  socket.on('auction:sync', (data, callback) => {
    const { roomCode, playerId } = socket.data || {};

    if (!roomCode) {
      return callback({ success: false, error: 'Not in a room' });
    }

    const state = auctionSnapshot(roomCode, playerId);
    const players = presentPlayers(roomCode);

    callback({
      success: true,
      state,
      players
    });
  });

  /**
   * GET ROOM STATUS
   */
  socket.on('room:get-status', (data, callback) => {
    const { roomCode } = socket.data;
    
    if (!roomCode) {
      return callback({ success: false, error: 'Not in a room' });
    }
    
    const room = roomManager.getRoom(roomCode);
    if (!room) {
      return callback({ success: false, error: 'Room not found' });
    }
    
    const players = Array.from(room.players.values()).map(p => ({
      id: p.id,
      username: p.username,
      balance: p.balance,
      teamSize: p.team.length,
      teamBuilt: p.teamBuilt || false,
      teamOverall: p.teamOverall || 0
    }));
    
    callback({
      success: true,
      room: {
        code: roomCode,
        players,
        auctionActive: auctionEngine.isAuctionActive(roomCode),
        gameFinished: room.gameFinished || false
      }
    });
  });
  
  /**
   * DISCONNECT
   */
  socket.on('disconnect', async () => {
    const { roomCode, playerId, username } = socket.data || {};
    
    if (roomCode && playerId) {
      const player = roomManager.getPlayer(roomCode, playerId);
      // A replaced session must not mark the new seat offline or delete it.
      if (!player || player.socketId !== socket.id) {
        logWithTime(`Socket disconnected: ${socket.id}`);
        return;
      }
      const auction = auctionEngine.getAuction(roomCode);
      const auctionLive = Boolean(auction && auction.phase !== 'finished');
      const disconnectDeadline = auctionLive
        ? null
        : Date.now() + GAME_CONFIG.DISCONNECT_TIMEOUT_MS;
      roomManager.setPresence(roomCode, playerId, false, { disconnectDeadline });
      const presence = auctionEngine.setOnline(roomCode, playerId, false);
      await commit(roomCode);
      logWithTime(`Player ${username} disconnected from ${roomCode}`);
      emitPlayers(io, roomCode);

      if (auctionLive) {
        await afterMembershipChange(io, roomCode, presence);
        return;
      }

      setTimeout(() => {
        const current = roomManager.getPlayer(roomCode, playerId);
        if (!current || current.isOnline || current.socketId !== socket.id) return;

        roomManager.removeRematchVote(roomCode, username);
        roomManager.removePlayerFromRoom(roomCode, playerId);
        auctionEngine.detachPlayer(roomCode, playerId);
        if (!roomManager.getRoom(roomCode) || (auctionEngine.getAuction(roomCode)?.players.size || 0) === 0) {
          auctionEngine.clearAuction(roomCode);
          clearRoomDecks(roomCode);
        }
        commit(roomCode).then(() => {
          const players = roomManager.getRoomPlayers(roomCode);
          io.to(roomCode).emit('room:player-left', {
            playerId,
            remainingPlayers: players.length,
            players: presentPlayers(roomCode)
          });
          broadcastRematch(io, roomCode);
          beginRematch(io, roomCode);
        }).catch((err) => {
          logWithTime(`Failed to remove disconnected player: ${err.message}`, 'ERROR');
        });
      }, GAME_CONFIG.DISCONNECT_TIMEOUT_MS);
    }
    
    logWithTime(`Socket disconnected: ${socket.id}`);
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = process.env.PORT || 3000;

/**
 * Start server
 */
async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();

    if (mongoRequired() && !dbConnected) {
      logWithTime('MongoDB is required for this process', 'ERROR');
      process.exit(1);
    }

    if (dbConnected) {
      handoffStore = new MongoHandoffStore();
      leagueService = openLeague(new MongoLeagueStore(), recoveryCards);
      await leagueService.load();
      const catalog = indexCards(recoveryCards);
      const restored = await restoreDurableRooms({
        writer: mongoRoomWriter,
        roomManager,
        auctionEngine,
        deckManager,
        catalog
      });
      if (restored) {
        logWithTime(`Restored ${restored} live room(s)`, 'INFO');
      }
    } else if (deckManager?.allCards?.length) {
      leagueService.setCatalog(recoveryCards);
    }

    if (!dbConnected && fileRoomWriter) {
      const restoredFileRooms = await restoreDurableRooms({
        writer: fileRoomWriter,
        roomManager,
        auctionEngine,
        deckManager,
        catalog: indexCards(recoveryCards)
      });
      if (restoredFileRooms) {
        logWithTime(`Restored ${restoredFileRooms} isolated room(s)`, 'INFO');
      }
    }
    for (const code of roomManager.listCodes()) {
      await settleRecoveredRoom(code);
    }
    await roomStore.flushAll();

    cleanupTimer = setInterval(() => {
      const removed = roomManager.sweep();
      for (const code of removed) {
        auctionEngine.clearAuction(code);
        clearRoomDecks(code);
      }
      if (removed.length) {
        logWithTime(`Cleaned up ${removed.length} abandoned room(s)`);
      }
      handoffStore.deleteExpired(Date.now()).catch((err) => {
        logWithTime(`Handoff cleanup failed: ${err.message}`, 'ERROR');
      });
    }, 60000);
    cleanupTimer.unref?.();

    // Start listening
    httpServer.listen(PORT, () => {
      logWithTime(`🎮 Football Auction Game Server running on port ${PORT}`, 'INFO');
      logWithTime(`📡 Socket.IO ready at http://localhost:${PORT}`, 'INFO');
      
      if (dbConnected) {
        logWithTime(`✅ Connected to MongoDB`, 'INFO');
      } else {
        logWithTime(`⚠️  Using cards.json (MongoDB not available)`, 'WARN');
      }
    });
  } catch (err) {
    logWithTime(`Failed to start server: ${err.message}`, 'ERROR');
    process.exit(1);
  }
}

startServer();

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logWithTime('Shutting down gracefully...', 'INFO');
  if (cleanupTimer) clearInterval(cleanupTimer);
  try {
    await roomStore.flushAll();
  } catch (err) {
    logWithTime(`Final room flush failed: ${err.message}`, 'ERROR');
  }
  httpServer.close(() => {
    logWithTime('Server closed', 'INFO');
    disconnectDatabase().then(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, io, roomManager, auctionEngine, deckManager };
