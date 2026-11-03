/**
 * AUCTION ENGINE
 * Core game logic for card auctions and bidding
 */

import { GAME_CONFIG, ERROR_CODES, auctionTimerMs } from './constants.js';
import { Validator } from './validators.js';
import { deepCopy, logWithTime } from './utils.js';

export class AuctionEngine {
  constructor() {
    this.auctions = new Map();
    this.onChange = null;
  }

  _touch(roomCode) {
    try {
      if (typeof this.onChange === 'function') this.onChange(roomCode);
    } catch (err) {
      logWithTime(`Auction change hook failed: ${err.message}`, 'ERROR');
    }
  }

  /**
   * Install an auction rebuilt from a snapshot. Timers are not armed here.
   */
  restoreAuction(auction) {
    if (!auction?.roomCode) return false;
    this.auctions.set(auction.roomCode, auction);
    return true;
  }
  
  /**
   * Start auction for a room
   */
  startAuction(roomCode, deck, players) {
    if (!deck || deck.length === 0) {
      logWithTime(`Cannot start auction: no cards available`, 'ERROR');
      return null;
    }

    const existing = this.auctions.get(roomCode);
    if (existing && existing.phase !== 'finished') {
      logWithTime(`Auction already active for room ${roomCode}`, 'WARN');
      return null;
    }
    if (existing) {
      this.clearTimer(roomCode);
      this.clearTransitions(roomCode);
    }
    
    const auction = {
      roomCode,
      currentCard: null,
      currentCardIndex: 0,
      deck,
      players: new Map(),
      bids: new Map(),
      highestBid: 0,
      highestBidder: null,
      bidHistory: [],
      skippedPlayers: new Set(),
      readyPlayers: new Set(),
      soldCardIds: new Set(),
      timerStarted: Date.now(),
      timerDuration: auctionTimerMs(),
      timerTimeout: null,
      timerGeneration: 0,
      transitions: new Map(),
      transitionGeneration: 0,
      phase: 'waiting-for-card',
      waitingForReady: false
    };
    
    // Initialize players
    for (const [playerId, playerData] of players) {
      auction.players.set(playerId, {
        id: playerId,
        username: playerData.username,
        balance: playerData.balance,
        hasSkipped: false,
        cardsWon: 0,
        online: playerData.isOnline !== false
      });
    }
    
    this.auctions.set(roomCode, auction);
    logWithTime(`Auction started for room ${roomCode} with ${players.size} players`);
    this._touch(roomCode);
    return auction;
  }
  
  /**
   * Get current auction
   */
  getAuction(roomCode) {
    return this.auctions.get(roomCode);
  }
  
  /**
   * Present next card
   */
  presentNextCard(roomCode) {
    const auction = this.getAuction(roomCode);
    if (!auction) return null;
    // A second caller must not skip the card that is already on the table.
    if (auction.phase === 'bidding' || auction.phase === 'finished') {
      return { blocked: true };
    }
    
    // Get next card, skipping any id that was already sold.
    let card = null;
    while (auction.currentCardIndex < auction.deck.length) {
      const candidate = deepCopy(auction.deck[auction.currentCardIndex]);
      auction.currentCardIndex++;
      if (candidate?.id != null && auction.soldCardIds?.has(candidate.id)) continue;
      card = candidate;
      break;
    }

    if (!card) {
      logWithTime(`No more cards in auction for room ${roomCode}`);
      this._touch(roomCode);
      return null;
    }
    
    auction.currentCard = card;
    
    // Reset auction state
    auction.bids.clear();
    auction.bidHistory = [];
    auction.highestBid = auction.currentCard.basePrice;
    auction.highestBidder = null;
    auction.timerDuration = 30000;
    auction.skippedPlayers.clear();
    
    // Reset player states
    for (const player of auction.players.values()) {
      player.hasSkipped = false;
    }
    
    auction.phase = 'bidding';
    auction.timerStarted = Date.now();
    
    logWithTime(`Card presented: ${auction.currentCard.name} (£${auction.currentCard.basePrice})`);
    this._touch(roomCode);
    return auction.currentCard;
  }
  
  /**
   * Process player bid - 4-layer validation
   */
  processBid(roomCode, playerId, bidAmount) {
    const auction = this.getAuction(roomCode);
    if (!auction) {
      return { success: false, error: ERROR_CODES.AUCTION_NOT_ACTIVE };
    }
    
    // LAYER 1: Validate auction is active
    if (auction.phase !== 'bidding') {
      return { success: false, error: ERROR_CODES.AUCTION_NOT_ACTIVE };
    }
    
    const player = auction.players.get(playerId);
    if (!player) {
      return { success: false, error: ERROR_CODES.INVALID_PARAMETERS, message: 'You are not in this auction' };
    }

    if (player.online === false) {
      return { success: false, error: ERROR_CODES.UNAUTHORIZED, message: 'Reconnect before bidding' };
    }

    // LAYER 2: Validate player state - Allow multiple bids per player
    if (player.hasSkipped) {
      return { success: false, error: ERROR_CODES.INVALID_BID, message: 'You already passed this card' };
    }

    if (auction.highestBidder === playerId) {
      return {
        success: false,
        error: ERROR_CODES.INVALID_BID,
        message: 'You already hold the highest bid.',
        minimumBid: this.calculateMinimumBid(auction.highestBid)
      };
    }

    // Whole pounds and the shared increment rule. Balance is spent only when the card is won.
    const bidCheck = Validator.validateBidIncrement(auction.highestBid, bidAmount);
    if (!bidCheck.valid) {
      return {
        success: false,
        error: bidCheck.error,
        message: bidCheck.message,
        minimumBid: bidCheck.minimumBid
      };
    }
    
    // LAYER 4: Validate player balance. Balance is only spent when the card is won.
    if (player.balance < bidAmount) {
      return {
        success: false,
        error: ERROR_CODES.INSUFFICIENT_BALANCE,
        message: `Insufficient balance. Have £${player.balance}, need £${bidAmount}`,
        availableBalance: player.balance
      };
    }
    
    // ✅ BID ACCEPTED - Update auction state
    // Don't set hasBid to true - allow multiple bids per player
    auction.bids.set(playerId, bidAmount);
    auction.highestBid = bidAmount;
    auction.highestBidder = playerId;
    auction.bidHistory.push({
      playerId,
      playerUsername: player.username,
      bidAmount,
      timestamp: Date.now()
    });
    
    logWithTime(`${player.username} bid £${bidAmount} in room ${roomCode}`);
    this._touch(roomCode);
    
    const minimumBid = this.calculateMinimumBid(bidAmount);
    return {
      success: true,
      bidAmount,
      newHighestBid: bidAmount,
      highestBidder: playerId,
      username: player.username,
      minimumBid,
      bidIncrement: Validator.bidStep(bidAmount)
    };
  }

  /**
   * Move an auction player onto a new socket id after a reconnect.
   */
  attachPlayer(roomCode, playerId, username, balance) {
    const auction = this.getAuction(roomCode);
    if (!auction) return;
    auction.bidHistory = auction.bidHistory || [];

    if (auction.players.has(playerId)) return;

    for (const [oldId, player] of auction.players) {
      if (player.username !== username) continue;

      auction.players.delete(oldId);
      player.id = playerId;
      player.online = true;
      auction.players.set(playerId, player);

      if (auction.bids.has(oldId)) {
        auction.bids.set(playerId, auction.bids.get(oldId));
        auction.bids.delete(oldId);
      }
      if (auction.highestBidder === oldId) auction.highestBidder = playerId;
      for (const bid of auction.bidHistory) {
        if (bid.playerId === oldId) bid.playerId = playerId;
      }
      for (const group of [auction.skippedPlayers, auction.readyPlayers]) {
        if (group.has(oldId)) {
          group.delete(oldId);
          group.add(playerId);
        }
      }
      this._touch(roomCode);
      return;
    }

    auction.players.set(playerId, {
      id: playerId,
      username,
      balance: balance ?? GAME_CONFIG.INITIAL_BALANCE,
      hasSkipped: false,
      cardsWon: 0,
      online: true
    });
    this._touch(roomCode);
  }

  /**
   * Players who are still connected. Offline seats keep their squad and bids,
   * but they must not stall ready checks or skip resolution.
   */
  _participants(auction) {
    return [...auction.players.values()].filter((player) => player.online !== false);
  }

  _onlinePlayersAllSkipped(auction) {
    if (!auction || auction.phase !== 'bidding') return false;
    const participants = this._participants(auction);
    return participants.length > 0 && participants.every((player) => player.hasSkipped);
  }

  setOnline(roomCode, playerId, online) {
    const auction = this.getAuction(roomCode);
    if (!auction) return { updated: false };
    const player = auction.players.get(playerId);
    if (!player) return { updated: false };
    player.online = Boolean(online);
    this._touch(roomCode);
    const ready = this.readySnapshot(roomCode);
    return {
      updated: true,
      allSkipped: this._onlinePlayersAllSkipped(auction),
      allReady: auction.phase === 'waiting-for-ready'
        && ready.totalPlayers > 0
        && ready.readyCount === ready.totalPlayers
    };
  }

  /**
   * Drop a player who explicitly left. Withdraws their bids so the card
   * can still be sold to someone who is here.
   */
  detachPlayer(roomCode, playerId) {
    const auction = this.getAuction(roomCode);
    if (!auction) return { removed: false };
    const player = auction.players.get(playerId);
    if (!player) return { removed: false };

    auction.bidHistory = (auction.bidHistory || []).filter((bid) => bid.playerId !== playerId);
    auction.bids.delete(playerId);
    if (auction.highestBidder === playerId) {
      if (auction.bidHistory.length === 0) {
        auction.highestBid = auction.currentCard?.basePrice || 0;
        auction.highestBidder = null;
      } else {
        const top = auction.bidHistory[auction.bidHistory.length - 1];
        auction.highestBid = top.bidAmount;
        auction.highestBidder = top.playerId;
      }
    }

    auction.players.delete(playerId);
    auction.skippedPlayers.delete(playerId);
    auction.readyPlayers.delete(playerId);

    if (auction.players.size === 0) this.clearTimer(roomCode);
    this._touch(roomCode);

    const ready = this.readySnapshot(roomCode);
    return {
      removed: true,
      username: player.username,
      allSkipped: this._onlinePlayersAllSkipped(auction),
      allReady: auction.phase === 'waiting-for-ready'
        && ready.totalPlayers > 0
        && ready.readyCount === ready.totalPlayers
    };
  }

  /**
   * Move from the ready gate to the next card at most once.
   */
  claimAdvance(roomCode) {
    const auction = this.getAuction(roomCode);
    if (!auction || auction.phase !== 'waiting-for-ready') return false;
    const ready = this.readySnapshot(roomCode);
    if (!(ready.totalPlayers > 0 && ready.readyCount === ready.totalPlayers)) return false;
    auction.phase = 'advancing';
    auction.waitingForReady = false;
    this._touch(roomCode);
    return true;
  }

  scheduleTransition(roomCode, key, delayMs, fn) {
    const auction = this.getAuction(roomCode);
    if (!auction || typeof fn !== 'function') return false;
    if (!auction.transitions) auction.transitions = new Map();
    if (!auction.transitionDeadlines) auction.transitionDeadlines = new Map();
    const existing = auction.transitions.get(key);
    if (existing) clearTimeout(existing);

    const generation = auction.transitionGeneration || 0;
    const dueAt = Date.now() + delayMs;
    auction.transitionDeadlines.set(key, dueAt);
    const timer = setTimeout(() => {
      const current = this.getAuction(roomCode);
      current?.transitions?.delete(key);
      if (!current || current.transitionGeneration !== generation) return;
      try {
        fn();
      } finally {
        const after = this.getAuction(roomCode);
        if (after?.transitionDeadlines?.delete(key)) this._touch(roomCode);
      }
    }, delayMs);
    auction.transitions.set(key, timer);
    this._touch(roomCode);
    return true;
  }

  clearTransitions(roomCode) {
    const auction = this.getAuction(roomCode);
    if (!auction) return;
    auction.transitionGeneration = (auction.transitionGeneration || 0) + 1;
    if (auction.transitionDeadlines) auction.transitionDeadlines.clear();
    if (auction.transitions) {
      for (const timer of auction.transitions.values()) clearTimeout(timer);
      auction.transitions.clear();
    }
    this._touch(roomCode);
  }

  canForceResolve(roomCode) {
    const auction = this.getAuction(roomCode);
    if (!auction || auction.phase !== 'bidding' || !auction.currentCard) return false;
    const elapsed = Date.now() - (auction.timerStarted || 0);
    const duration = auction.timerDuration || 30000;
    return elapsed >= duration || this._onlinePlayersAllSkipped(auction);
  }

  refundSale(roomCode, playerId, amount, cardId) {
    const auction = this.getAuction(roomCode);
    if (!auction) return false;
    const player = auction.players.get(playerId);
    if (player && Number.isFinite(amount)) {
      player.balance += amount;
      player.cardsWon = Math.max(0, (player.cardsWon || 0) - 1);
    }
    if (cardId != null) auction.soldCardIds?.delete(cardId);
    this._touch(roomCode);
    return true;
  }

  /**
   * Snapshot the live auction for a client that missed the broadcast.
   */
  cheapestBid() {
    return GAME_CONFIG.CARD_CATEGORIES.BASIC.basePrice + GAME_CONFIG.MIN_BID_INCREMENT;
  }

  /**
   * Players who can still buy a card, and players who are only watching.
   * Ready votes ignore spectators so an empty balance cannot stall the room.
   */
  readySnapshot(roomCode) {
    const auction = this.getAuction(roomCode);
    const cheapestBid = this.cheapestBid();
    if (!auction) {
      return {
        readyPlayers: [],
        readyCount: 0,
        totalPlayers: 0,
        spectatorIds: [],
        cheapestBid
      };
    }

    const players = this._participants(auction);
    const eligible = players.filter((player) => player.balance >= cheapestBid);
    const readyPlayers = eligible
      .filter((player) => auction.readyPlayers.has(player.id))
      .map((player) => ({
        playerId: player.id,
        playerUsername: player.username || ''
      }));

    return {
      readyPlayers,
      readyCount: readyPlayers.length,
      totalPlayers: eligible.length,
      spectatorIds: players.filter((player) => player.balance < cheapestBid).map((player) => player.id),
      cheapestBid
    };
  }

  getPublicState(roomCode, playerId, ownedCards = []) {
    const auction = this.getAuction(roomCode);
    if (!auction) return null;

    const elapsed = Date.now() - (auction.timerStarted || Date.now());
    const secondsRemaining = Math.max(
      0,
      Math.ceil(((auction.timerDuration || 30000) - elapsed) / 1000)
    );
    const you = playerId ? auction.players.get(playerId) : null;
    const ready = this.readySnapshot(roomCode);
    const priceFloor = auction.highestBid || auction.currentCard?.basePrice || 0;

    return {
      card: auction.currentCard,
      currentIndex: auction.currentCardIndex,
      totalCards: auction.deck.length,
      minimumBid: this.calculateMinimumBid(priceFloor),
      bidIncrement: Validator.bidStep(priceFloor),
      highestBid: auction.highestBidder ? auction.highestBid : 0,
      highestBidder: auction.highestBidder,
      bids: [...(auction.bidHistory || [])].reverse(),
      secondsRemaining,
      phase: auction.phase,
      waitingForReady: Boolean(auction.waitingForReady),
      readyPlayers: ready.readyPlayers,
      readyCount: ready.readyCount,
      totalPlayers: ready.totalPlayers,
      spectatorIds: ready.spectatorIds,
      cheapestBid: ready.cheapestBid,
      youSpectating: Boolean(you && you.balance < ready.cheapestBid),
      yourBalance: you ? you.balance : null,
      yourCards: Array.isArray(ownedCards) ? deepCopy(ownedCards) : [],
      youSkipped: Boolean(playerId && auction.skippedPlayers.has(playerId))
    };
  }
  
  /**
   * Process player skip
   */
  processSkip(roomCode, playerId) {
    const auction = this.getAuction(roomCode);
    if (!auction) {
      return { success: false, error: ERROR_CODES.AUCTION_NOT_ACTIVE };
    }
    
    if (auction.phase !== 'bidding') {
      return { success: false, error: ERROR_CODES.AUCTION_NOT_ACTIVE };
    }
    
    const player = auction.players.get(playerId);
    if (!player) {
      return { success: false, error: ERROR_CODES.INVALID_PARAMETERS };
    }
    
    const snapshot = () => {
      const history = auction.bidHistory || [];
      return {
        success: true,
        playerId,
        username: player.username,
        skippedCount: auction.skippedPlayers.size,
        allSkipped: this._onlinePlayersAllSkipped(auction),
        highestBid: auction.highestBidder ? auction.highestBid : 0,
        minimumBid: this.calculateMinimumBid(auction.highestBid || auction.currentCard?.basePrice || 0),
        bidIncrement: Validator.bidStep(auction.highestBid || auction.currentCard?.basePrice || 0),
        bids: [...history].reverse()
      };
    };

    if (player.hasSkipped) {
      return { ...snapshot(), alreadySkipped: true };
    }

    // Leaving the card withdraws this player's bids so everyone else can still bid.
    auction.bidHistory = (auction.bidHistory || []).filter((bid) => bid.playerId !== playerId);
    auction.bids.delete(playerId);
    if (auction.bidHistory.length === 0) {
      auction.highestBid = auction.currentCard?.basePrice || 0;
      auction.highestBidder = null;
    } else {
      const top = auction.bidHistory[auction.bidHistory.length - 1];
      auction.highestBid = top.bidAmount;
      auction.highestBidder = top.playerId;
    }

    player.hasSkipped = true;
    auction.skippedPlayers.add(playerId);
    logWithTime(`${player.username} skipped card in room ${roomCode}`);
    this._touch(roomCode);

    return snapshot();
  }
  
  /**
   * Resolve current card (determine winner)
   */
  _viableWinner(auction) {
    const history = [...(auction.bidHistory || [])].reverse();
    const seen = new Set();
    for (const bid of history) {
      if (!bid?.playerId || seen.has(bid.playerId)) continue;
      seen.add(bid.playerId);
      const player = auction.players.get(bid.playerId);
      const amount = bid.bidAmount;
      if (!player || !Number.isInteger(amount) || player.balance < amount) continue;
      return { player, amount };
    }
    return null;
  }

  resolveCard(roomCode) {
    const auction = this.getAuction(roomCode);
    if (!auction || !auction.currentCard || auction.phase !== 'bidding') return null;
    auction.phase = 'resolving';
    this.clearTimer(roomCode);
    if (!auction.soldCardIds) auction.soldCardIds = new Set();

    const result = {
      cardId: auction.currentCard.id,
      cardName: auction.currentCard.name,
      card: deepCopy(auction.currentCard),
      winnerId: null,
      winnerUsername: null,
      finalPrice: 0,
      status: 'discarded'
    };

    const alreadySold = auction.currentCard.id != null && auction.soldCardIds.has(auction.currentCard.id);
    const viable = alreadySold ? null : this._viableWinner(auction);

    if (!viable) {
      logWithTime(`Card ${auction.currentCard.name} discarded (no payable bids in room ${roomCode})`);
      this._touch(roomCode);
      return result;
    }

    viable.player.balance -= viable.amount;
    viable.player.cardsWon++;
    if (auction.currentCard.id != null) auction.soldCardIds.add(auction.currentCard.id);

    result.winnerId = viable.player.id;
    result.winnerUsername = viable.player.username;
    result.finalPrice = viable.amount;
    result.status = 'awarded';
    logWithTime(`${viable.player.username} won ${auction.currentCard.name} for £${viable.amount}`);
    this._touch(roomCode);
    return result;
  }
  
  /**
   * Set timer callback for automatic card resolution
   */
  /**
   * Arm the bidding clock. A fresh bid resets the start. Recovery keeps the
   * original start so the deadline does not grow back to a full timer.
   */
  _armBiddingTimer(roomCode, { resetStart }) {
    const auction = this.getAuction(roomCode);
    if (!auction) return false;
    if (auction.timerTimeout) clearTimeout(auction.timerTimeout);

    const generation = (auction.timerGeneration || 0) + 1;
    auction.timerGeneration = generation;
    if (resetStart || !auction.timerStarted) auction.timerStarted = Date.now();
    const duration = auction.timerDuration || 30000;
    // A reset bid clock waits the full duration. Recovery uses the time left
    // until the original deadline, which is not rounded back up.
    const remaining = resetStart
      ? duration
      : Math.max(0, auction.timerStarted + duration - Date.now());
    auction.timerTimeout = setTimeout(() => {
      if (auction.timerGeneration !== generation) return;
      if (auction.phase !== 'bidding') return;
      auction.timerTimeout = null;
      if (typeof auction.onTimeout === 'function') auction.onTimeout();
    }, remaining);
    this._touch(roomCode);
    return true;
  }

  setTimerCallback(roomCode, callback) {
    const auction = this.getAuction(roomCode);
    if (!auction || auction.phase !== 'bidding') return;
    
    if (callback) auction.onTimeout = callback;
    this._armBiddingTimer(roomCode, { resetStart: true });
  }

  /**
   * Re-arm the persisted deadline without moving timerStarted.
   */
  resumeTimer(roomCode, callback) {
    const auction = this.getAuction(roomCode);
    if (!auction || auction.phase !== 'bidding') return false;
    if (callback) auction.onTimeout = callback;
    return this._armBiddingTimer(roomCode, { resetStart: false });
  }
  
  /**
   * Clear timer
   */
  clearTimer(roomCode) {
    const auction = this.getAuction(roomCode);
    if (!auction) return;
    auction.timerGeneration = (auction.timerGeneration || 0) + 1;
    if (auction.timerTimeout) {
      clearTimeout(auction.timerTimeout);
      auction.timerTimeout = null;
    }
    this._touch(roomCode);
  }
  
  /**
   * Mark player as ready for next card
   */
  setPlayerReady(roomCode, playerId) {
    const auction = this.getAuction(roomCode);
    if (!auction) return { success: false, error: 'Auction not found' };

    if (auction.phase === 'advancing') {
      const ready = this.readySnapshot(roomCode);
      return {
        success: true,
        alreadyAdvancing: true,
        allReady: false,
        readyCount: ready.readyCount,
        totalPlayers: ready.totalPlayers
      };
    }

    if (auction.phase !== 'waiting-for-ready') {
      return {
        success: false,
        error: 'STILL_BIDDING',
        message: 'Other players are still bidding on this card.'
      };
    }

    const player = auction.players.get(playerId);
    if (player && player.balance < this.cheapestBid()) {
      const watching = this.readySnapshot(roomCode);
      return {
        success: true,
        spectating: true,
        readyCount: watching.readyCount,
        totalPlayers: watching.totalPlayers,
        allReady: false
      };
    }
    
    auction.readyPlayers.add(playerId);
    const ready = this.readySnapshot(roomCode);
    const allReady = this.claimAdvance(roomCode);
    if (!allReady) this._touch(roomCode);
    
    logWithTime(`Player ready: ${ready.readyCount}/${ready.totalPlayers} in room ${roomCode}`);
    
    return {
      success: true,
      readyCount: ready.readyCount,
      totalPlayers: ready.totalPlayers,
      allReady
    };
  }
  
  /**
   * Reset ready players for next card
   */
  resetReadyPlayers(roomCode) {
    const auction = this.getAuction(roomCode);
    if (auction) {
      auction.readyPlayers.clear();
      auction.waitingForReady = false;
      this._touch(roomCode);
    }
  }
  
  /**
   * Set auction to waiting for ready state
   */
  setWaitingForReady(roomCode) {
    const auction = this.getAuction(roomCode);
    if (auction) {
      auction.waitingForReady = true;
      auction.phase = 'waiting-for-ready';
      this._touch(roomCode);
    }
  }

  /**
   * Next legal bid. Uses Validator so the engine and the shared rule stay one definition.
   */
  calculateMinimumBid(currentBid) {
    return Validator.nextMinimumBid(currentBid);
  }
  
  /**
   * Check if auction is finished
   */
  isAuctionFinished(roomCode) {
    const auction = this.getAuction(roomCode);
    if (!auction) return false;
    
    return auction.currentCardIndex >= auction.deck.length;
  }
  
  /**
   * Get auction summary
   */
  getAuctionSummary(roomCode) {
    const auction = this.getAuction(roomCode);
    if (!auction) return null;
    
    const playerStats = [];
    for (const player of auction.players.values()) {
      playerStats.push({
        id: player.id,
        username: player.username,
        balance: player.balance,
        cardsWon: player.cardsWon,
        cardsRemaining: player.balance
      });
    }
    
    return {
      roomCode,
      currentCardIndex: auction.currentCardIndex,
      totalCards: auction.deck.length,
      players: playerStats.sort((a, b) => b.cardsWon - a.cardsWon)
    };
  }
  
  /**
   * Count armed bidding clocks and transition timers. Read-only.
   */
  runtimeTimers() {
    let biddingTimers = 0;
    let transitionTimers = 0;
    for (const auction of this.auctions.values()) {
      if (auction?.timerTimeout) biddingTimers += 1;
      transitionTimers += auction?.transitions?.size || 0;
    }
    return {
      auctions: this.auctions.size,
      biddingTimers,
      transitionTimers
    };
  }

  /**
   * Clean up auction
   */
  clearAuction(roomCode) {
    const auction = this.getAuction(roomCode);
    if (auction) {
      this.clearTimer(roomCode);
      this.clearTransitions(roomCode);
    }
    this.auctions.delete(roomCode);
    this._touch(roomCode);
  }
}
