/**
 * LIVE ROOM SNAPSHOT
 * Plain JSON for a room that can be rebuilt after a process restart.
 * Socket ids and timer handles are process-local and are not stored.
 * The shuffled deck is card ids; card bodies are resolved from the catalog.
 */

import { GAME_CONFIG, ROOM_SCHEMA_VERSION } from './constants.js';
import { deepCopy } from './utils.js';
import { selectionFromLineup } from '../shared/squad-evaluation.js';

export function indexCards(cards) {
  const map = new Map();
  for (const card of cards || []) {
    if (card?.id == null) continue;
    map.set(String(card.id), card);
  }
  return map;
}

function stubCard(card) {
  if (!card || card.id == null) return null;
  const stub = {
    id: card.id,
    name: card.name,
    basePrice: card.basePrice,
    position: card.position,
    category: card.category
  };
  if (card.nationality) stub.nationality = card.nationality;
  if (card.club) stub.club = card.club;
  if (card.stats) stub.stats = deepCopy(card.stats);
  if (card.imageCatalogue === true || card.testAuction === true) {
    if (card.imageCatalogue === true) {
      stub.imageCatalogue = true;
      stub.auctionEligible = true;
      stub.basePriceSource = card.basePriceSource === 'overall-band' ? 'overall-band' : 'unrated-opening';
    }
    if (card.testAuction === true) {
      stub.testAuction = true;
      stub.localCatalogue = true;
      stub.auctionEligible = false;
      stub.basePriceSource = card.basePriceSource === 'overall-band' ? 'overall-band' : 'neutral-test';
    }
    if (typeof card.catalogueCardId === 'string') stub.catalogueCardId = card.catalogueCardId;
    if (typeof card.cardArtUrl === 'string') {
      stub.cardArtUrl = card.cardArtUrl;
      stub.cardArtApproved = card.cardArtApproved === true;
      stub.cardArtApprovalStatus = card.cardArtApprovalStatus;
      stub.cardArtRightsStatus = card.cardArtRightsStatus;
      stub.cardArtTesting = card.cardArtTesting === true;
      stub.cardArtValidated = card.cardArtValidated === true;
    }
    if (card.goalkeeping) stub.goalkeeping = deepCopy(card.goalkeeping);
    if (Array.isArray(card.alternatePositions)) stub.alternatePositions = card.alternatePositions.slice();
  }
  return stub;
}

function remember(cache, card) {
  const stub = stubCard(card);
  if (!stub) return;
  cache[String(stub.id)] = stub;
}

function cardIds(cards) {
  return (cards || []).map((card) => card?.id).filter((id) => id != null);
}

function captureLineup(player) {
  const lineup = player?.lineup;
  if (!lineup?.formation) return null;
  return {
    formation: lineup.formation,
    revision: Number.isInteger(lineup.revision) ? lineup.revision : 0,
    confirmed: Boolean(lineup.confirmed),
    slots: (lineup.slots || []).map((slot) => ({
      slotId: slot.slotId,
      cardId: slot.cardId ?? null
    }))
  };
}

function restoreLineup(lineup) {
  if (!lineup || typeof lineup !== 'object' || !lineup.formation) return null;
  return {
    formation: lineup.formation,
    revision: Number.isInteger(lineup.revision) ? lineup.revision : 0,
    confirmed: Boolean(lineup.confirmed),
    slots: Array.isArray(lineup.slots)
      ? lineup.slots
        .filter((slot) => slot?.slotId)
        .map((slot) => ({
          slotId: slot.slotId,
          cardId: slot.cardId ?? null
        }))
      : []
  };
}

function seatKey(room, liveId, username) {
  const direct = liveId != null ? room.players.get(liveId) : null;
  if (direct?.seatId) return direct.seatId;
  if (username) {
    const match = [...room.players.values()].find((player) => player.username === username);
    if (match?.seatId) return match.seatId;
  }
  return liveId ?? null;
}

function captureAuction(room, auction, cache) {
  if (auction.currentCard) remember(cache, auction.currentCard);

  const players = [...auction.players.values()].map((player) => ({
    seatId: seatKey(room, player.id, player.username),
    username: player.username,
    balance: player.balance,
    hasSkipped: Boolean(player.hasSkipped),
    cardsWon: player.cardsWon || 0,
    online: player.online !== false
  }));

  const bids = [...auction.bids.entries()].map(([playerId, amount]) => ({
    seatId: seatKey(room, playerId),
    amount
  }));

  const bidHistory = (auction.bidHistory || []).map((bid) => ({
    seatId: seatKey(room, bid.playerId, bid.playerUsername),
    playerUsername: bid.playerUsername,
    bidAmount: bid.bidAmount,
    timestamp: bid.timestamp
  }));

  const timerDuration = auction.timerDuration || 30000;
  const timerStarted = auction.timerStarted || null;
  const deadline = timerStarted != null ? timerStarted + timerDuration : null;

  const transitions = [...(auction.transitionDeadlines?.entries() || [])].map(([key, dueAt]) => ({
    key,
    dueAt
  }));

  return {
    phase: auction.phase,
    waitingForReady: Boolean(auction.waitingForReady),
    currentCardIndex: auction.currentCardIndex || 0,
    currentCardId: auction.currentCard?.id ?? null,
    deckCardIds: (auction.deck || []).map((card) => card?.id ?? null),
    highestBid: auction.highestBid || 0,
    highestBidderSeatId: auction.highestBidder
      ? seatKey(room, auction.highestBidder)
      : null,
    bids,
    bidHistory,
    skippedSeatIds: [...(auction.skippedPlayers || [])].map((id) => seatKey(room, id)),
    readySeatIds: [...(auction.readyPlayers || [])].map((id) => seatKey(room, id)),
    soldCardIds: [...(auction.soldCardIds || [])],
    players,
    timerStarted,
    timerDuration,
    deadline,
    transitions
  };
}

function captureSquads(room, cache) {
  if (!room.finalSquads) return null;
  return room.finalSquads.map((squad) => {
    const seat = [...room.players.values()].find((player) => player.username === squad.username);
    for (const card of squad.cards || []) remember(cache, card);
    return {
      seatId: seat?.seatId || null,
      username: squad.username,
      balance: squad.balance,
      cardIds: cardIds(squad.cards)
    };
  });
}

/**
 * @returns {object|null} Document ready for MongoDB. stateVersion is the last saved version.
 */
export function captureLiveRoom(room, auction) {
  if (!room?.code || !room.roomId) return null;

  const cache = {};
  const seats = [...room.players.values()].map((player) => {
    for (const card of player.team || []) remember(cache, card);
    for (const card of player.builtTeam || []) remember(cache, card);
    return {
      seatId: player.seatId,
      username: player.username,
      ...(typeof player.seatTokenHash === 'string' ? { seatTokenHash: player.seatTokenHash } : {}),
      ...(typeof player.seatToken === 'string' ? { seatToken: player.seatToken } : {}),
      balance: player.balance,
      cardIds: cardIds(player.team),
      joinedAt: player.joinedAt,
      isOnline: player.isOnline !== false,
      lastActivity: player.lastActivity || player.joinedAt,
      teamBuilt: Boolean(player.teamBuilt),
      builtCardIds: cardIds(player.builtTeam),
      teamOverall: player.teamOverall || 0,
      formation: player.formation || null,
      lineup: captureLineup(player),
      disconnectDeadline: player.disconnectDeadline || null
    };
  });

  const auctionState = auction ? captureAuction(room, auction, cache) : null;
  const phase = auctionState?.phase || room.gameState?.auctionPhase || 'not-started';
  const createdAt = room.createdAt || Date.now();
  const lastActivity = room.lastActivity || createdAt;
  let expiresAt = lastActivity + GAME_CONFIG.ROOM_TIMEOUT_MS;
  if (seats.length === 0 && room.emptiedAt) {
    expiresAt = Math.min(expiresAt, room.emptiedAt + GAME_CONFIG.DISCONNECT_TIMEOUT_MS);
  }

  return {
    roomId: room.roomId,
    code: room.code,
    schemaVersion: room.schemaVersion || ROOM_SCHEMA_VERSION,
    stateVersion: room.stateVersion || 0,
    status: room.status || 'waiting',
    phase,
    hostSeatId: room.hostSeatId || null,
    hostUsername: room.hostUsername || null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(),
    expiresAt: new Date(expiresAt),
    state: {
      createdAt,
      lastActivity,
      emptiedAt: room.emptiedAt || null,
      seats,
      auction: auctionState,
      finalSquads: captureSquads(room, cache),
      rematchVotes: [...(room.rematchVotes || [])],
      rematchStarting: Boolean(room.rematchStarting),
      matchResults: room.matchResults ? deepCopy(room.matchResults) : null,
      gameFinished: Boolean(room.gameFinished),
      gameState: {
        auctionPhase: phase,
        currentCardIndex: auction?.currentCardIndex || room.gameState?.currentCardIndex || 0,
        currentCardId: auction?.currentCard?.id ?? room.gameState?.currentCard?.id ?? null
      },
      departedSeats: captureDeparted(room, cache),
      cardCache: cache
    }
  };
}

function captureDeparted(room, cache) {
  const seats = room.departedSeats || [];
  if (!seats.length) return [];
  return seats.map((seat) => {
    for (const card of seat.team || []) remember(cache, card);
    return {
      seatId: seat.seatId,
      username: seat.username,
      balance: seat.balance,
      cardIds: cardIds(seat.team),
      lineup: seat.lineup ? deepCopy(seat.lineup) : null,
      leftAt: seat.leftAt || null,
      squadStatus: seat.squadStatus === 'preserved' ? 'preserved' : 'abandoned'
    };
  });
}

export function shouldRecover(doc, now = Date.now()) {
  if (!doc || doc.schemaVersion !== ROOM_SCHEMA_VERSION || !doc.code || !doc.roomId) return false;
  const expires = doc.expiresAt instanceof Date
    ? doc.expiresAt.getTime()
    : new Date(doc.expiresAt).getTime();
  if (!Number.isFinite(expires) || expires <= now) return false;

  const state = doc.state || {};
  const seats = state.seats || [];
  if (seats.length === 0 && state.emptiedAt && (now - state.emptiedAt) >= GAME_CONFIG.DISCONNECT_TIMEOUT_MS) {
    return false;
  }
  const last = state.lastActivity || state.createdAt || 0;
  if (last && (now - last) >= GAME_CONFIG.ROOM_TIMEOUT_MS) return false;
  return true;
}

function lookupCard(id, catalog, cache) {
  if (id == null) return null;
  const key = String(id);
  const fromCatalog = catalog?.get(key);
  if (fromCatalog) return deepCopy(fromCatalog);
  const stub = cache?.[key];
  if (stub) return deepCopy(stub);
  return {
    id,
    name: String(id),
    basePrice: GAME_CONFIG.CARD_CATEGORIES.BASIC.basePrice,
    position: 'ST',
    category: 'BASIC',
    missing: true
  };
}

function hydrateIds(ids, catalog, cache) {
  return (ids || []).map((id) => lookupCard(id, catalog, cache)).filter(Boolean);
}

/**
 * Rebuild the in-memory room and auction. socketsDead forces every seat offline
 * because a restarted process has no connections left.
 */
export function materializeLiveRoom(doc, { catalog = new Map(), socketsDead = true } = {}) {
  const state = doc.state || {};
  const cache = state.cardCache || {};
  const players = new Map();

  for (const seat of state.seats || []) {
    const player = {
      id: seat.seatId,
      seatId: seat.seatId,
      username: seat.username,
      socketId: null,
      balance: seat.balance,
      team: hydrateIds(seat.cardIds, catalog, cache),
      joinedAt: seat.joinedAt,
      isOnline: socketsDead ? false : seat.isOnline !== false,
      lastActivity: seat.lastActivity,
      teamBuilt: Boolean(seat.teamBuilt),
      builtTeam: hydrateIds(seat.builtCardIds, catalog, cache),
      teamOverall: seat.teamOverall || 0,
      formation: seat.formation || null,
      lineup: restoreLineup(seat.lineup)
    };
    if (typeof seat.seatTokenHash === 'string') player.seatTokenHash = seat.seatTokenHash;
    if (typeof seat.seatToken === 'string') player.seatToken = seat.seatToken;
    if (player.lineup?.confirmed) {
      const selected = selectionFromLineup(player.team, player.lineup);
      if (selected.length === GAME_CONFIG.REQUIRED_TEAM_SIZE) {
        player.builtTeam = selected.map((card) => deepCopy(card));
        player.teamBuilt = true;
        player.formation = player.lineup.formation;
      }
    }
    if (seat.disconnectDeadline) player.disconnectDeadline = seat.disconnectDeadline;
    players.set(player.id, player);
  }

  const currentCardId = state.gameState?.currentCardId ?? state.auction?.currentCardId ?? null;
  const room = {
    roomId: doc.roomId,
    code: doc.code,
    schemaVersion: doc.schemaVersion,
    stateVersion: doc.stateVersion || 0,
    createdAt: state.createdAt,
    lastActivity: state.lastActivity,
    players,
    status: doc.status || 'waiting',
    currentAuction: null,
    hostSeatId: doc.hostSeatId || null,
    hostUsername: doc.hostUsername || null,
    gameState: {
      players: [],
      currentCard: currentCardId != null ? lookupCard(currentCardId, catalog, cache) : null,
      currentCardIndex: state.gameState?.currentCardIndex || 0,
      auctionPhase: state.gameState?.auctionPhase || doc.phase || 'not-started'
    },
    rematchVotes: new Set(state.rematchVotes || []),
    rematchStarting: Boolean(state.rematchStarting),
    gameFinished: Boolean(state.gameFinished)
  };
  if (state.emptiedAt) room.emptiedAt = state.emptiedAt;
  if (state.matchResults) room.matchResults = deepCopy(state.matchResults);
  room.departedSeats = (state.departedSeats || []).map((seat) => ({
    seatId: seat.seatId,
    username: seat.username,
    balance: seat.balance,
    team: hydrateIds(seat.cardIds, catalog, cache),
    lineup: restoreLineup(seat.lineup),
    leftAt: seat.leftAt || null,
    squadStatus: seat.squadStatus === 'preserved' ? 'preserved' : 'abandoned'
  }));
  if (state.finalSquads) {
    room.finalSquads = state.finalSquads.map((squad) => ({
      id: squad.seatId,
      username: squad.username,
      balance: squad.balance,
      cards: hydrateIds(squad.cardIds, catalog, cache)
    }));
  }

  const auction = materializeAuction(doc.code, state.auction, catalog, cache, socketsDead);
  if (auction?.currentCard) room.gameState.currentCard = auction.currentCard;

  return {
    room,
    auction,
    deck: auction?.deck || []
  };
}

function materializeAuction(roomCode, snap, catalog, cache, socketsDead) {
  if (!snap) return null;

  const deck = (snap.deckCardIds || []).map((id) => lookupCard(id, catalog, cache));
  const players = new Map();
  for (const player of snap.players || []) {
    players.set(player.seatId, {
      id: player.seatId,
      username: player.username,
      balance: player.balance,
      hasSkipped: Boolean(player.hasSkipped),
      cardsWon: player.cardsWon || 0,
      online: socketsDead ? false : player.online !== false
    });
  }

  const timerDuration = snap.timerDuration || 30000;
  const deadline = snap.deadline ?? (snap.timerStarted != null ? snap.timerStarted + timerDuration : null);
  const timerStarted = deadline != null ? deadline - timerDuration : snap.timerStarted;

  let phase = snap.phase;
  let waitingForReady = Boolean(snap.waitingForReady);
  const sold = new Set(snap.soldCardIds || []);
  if (phase === 'resolving') {
    const currentId = snap.currentCardId;
    if (currentId != null && sold.has(currentId)) {
      phase = 'waiting-for-ready';
      waitingForReady = true;
    } else {
      phase = 'bidding';
    }
  }

  const transitionDeadlines = new Map();
  for (const transition of snap.transitions || []) {
    if (transition?.key) transitionDeadlines.set(transition.key, transition.dueAt);
  }

  return {
    roomCode,
    currentCard: snap.currentCardId != null ? lookupCard(snap.currentCardId, catalog, cache) : null,
    currentCardIndex: snap.currentCardIndex || 0,
    deck,
    players,
    bids: new Map((snap.bids || []).map((bid) => [bid.seatId, bid.amount])),
    highestBid: snap.highestBid || 0,
    highestBidder: snap.highestBidderSeatId || null,
    bidHistory: (snap.bidHistory || []).map((bid) => ({
      playerId: bid.seatId,
      playerUsername: bid.playerUsername,
      bidAmount: bid.bidAmount,
      timestamp: bid.timestamp
    })),
    skippedPlayers: new Set(snap.skippedSeatIds || []),
    readyPlayers: new Set(snap.readySeatIds || []),
    soldCardIds: sold,
    timerStarted,
    timerDuration,
    timerTimeout: null,
    timerGeneration: 0,
    transitions: new Map(),
    transitionDeadlines,
    transitionGeneration: 0,
    phase,
    waitingForReady,
    onTimeout: null
  };
}
