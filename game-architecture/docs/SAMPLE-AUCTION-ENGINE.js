// Backend: services/AuctionEngine.js
// Core auction logic - turn-based bidding with 30-second timer per card

const CardDeckManager = require('./CardDeckManager');

class AuctionEngine {
  constructor(room, io) {
    this.room = room;
    this.io = io;
    this.currentCard = null;
    this.timerInterval = null;
    this.remainingTime = 30;
    this.playerBidStates = new Map();
  }

  /**
   * Starts auction: shuffle deck, present first card
   */
  startAuction() {
    try {
      // Shuffle deck
      const allCards = CardDeckManager.getAllCards();
      this.room.cardDeck = this.shuffleArray(
        allCards.map(c => c.cardId)
      );

      // Initialize auction tracking
      this.room.auction = {
        cardIndex: 0,
        totalCards: this.room.cardDeck.length,
        cardsAuctioned: 0,
        cardsDiscarded: 0,
        cardsSkipped: 0,
        totalBids: 0
      };

      console.log(`[Auction] Starting auction for room ${this.room.roomCode}`);

      // Present first card
      this.presentNextCard();
    } catch (error) {
      console.error('[AuctionEngine] startAuction error:', error);
    }
  }

  /**
   * Present next card in deck
   */
  presentNextCard() {
    try {
      // Check if auction complete
      if (this.room.auction.cardIndex >= this.room.cardDeck.length) {
        this.endAuction();
        return;
      }

      // Get next card
      const cardId = this.room.cardDeck[this.room.auction.cardIndex];
      const card = CardDeckManager.getCardById(cardId);

      if (!card) {
        console.error(`[AuctionEngine] Card not found: ${cardId}`);
        return;
      }

      // Initialize card auction state
      this.currentCard = {
        cardId: cardId,
        name: card.name,
        position: card.position,
        stats: card.stats,
        basePrice: card.basePrice,
        category: card.category,
        imageUrl: card.imageUrl,

        currentBid: card.basePrice,
        currentBidder: null,
        bidHistory: [],

        timerStart: Date.now(),
        timerEnd: Date.now() + 30000,
        status: 'active'
      };

      // Reset player bid states for this card
      this.playerBidStates.clear();
      for (const playerId of this.room.players.keys()) {
        this.playerBidStates.set(playerId, {
          bid: false,
          skipped: false,
          amount: 0
        });
      }

      // Broadcast card presentation
      this.io.to(`room_${this.room.roomCode}`).emit('auction:card-presented', {
        cardId: this.currentCard.cardId,
        card: {
          name: this.currentCard.name,
          position: this.currentCard.position,
          stats: this.currentCard.stats,
          category: this.currentCard.category,
          imageUrl: this.currentCard.imageUrl
        },
        startPrice: this.currentCard.basePrice,
        timerMs: 30000,
        cardNumber: this.room.auction.cardIndex + 1,
        totalCards: this.room.auction.totalCards
      });

      // Start timer
      this.startTimer();

      console.log(`[Auction] Card ${this.room.auction.cardIndex + 1}/100: ${card.name}`);
    } catch (error) {
      console.error('[AuctionEngine] presentNextCard error:', error);
    }
  }

  /**
   * Start 30-second timer for current card
   */
  startTimer() {
    this.remainingTime = 30;

    this.timerInterval = setInterval(() => {
      this.handleTimerTick();
    }, 1000);
  }

  /**
   * Handle each 1-second tick of timer
   */
  handleTimerTick() {
    this.remainingTime--;

    // Broadcast tick every 5 seconds and in final 10 seconds
    if (this.remainingTime % 5 === 0 || this.remainingTime <= 10) {
      this.io.to(`room_${this.room.roomCode}`).emit('auction:timer-tick', {
        cardId: this.currentCard.cardId,
        remainingSeconds: this.remainingTime,
        remainingMs: this.remainingTime * 1000
      });
    }

    // Timer expired
    if (this.remainingTime <= 0) {
      this.stopTimer();
      this.resolveCard();
    }
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  /**
   * Process player bid - full validation
   * Returns { success: boolean, error?: string, ... }
   */
  processPlayerBid(playerId, bidAmount) {
    try {
      // ========== VALIDATION LAYER 1: Player State ==========
      if (!this.room.players.has(playerId)) {
        return {
          success: false,
          error: 'NOT_IN_ROOM',
          message: 'You are not in this room'
        };
      }

      const player = this.room.players.get(playerId);

      if (player.balance < bidAmount) {
        return {
          success: false,
          error: 'INSUFFICIENT_FUNDS',
          message: `You need £${bidAmount}, you have £${player.balance}`,
          currentBalance: player.balance,
          bidAmount: bidAmount
        };
      }

      // ========== VALIDATION LAYER 2: Auction State ==========
      if (!this.currentCard || this.currentCard.status !== 'active') {
        return {
          success: false,
          error: 'CARD_NOT_ACTIVE',
          message: 'This card is no longer being auctioned'
        };
      }

      if (this.remainingTime <= 0) {
        return {
          success: false,
          error: 'TIMER_EXPIRED',
          message: 'The auction timer for this card has expired'
        };
      }

      // ========== VALIDATION LAYER 3: Bid History ==========
      const playerState = this.playerBidStates.get(playerId);

      if (playerState.skipped) {
        return {
          success: false,
          error: 'PLAYER_SKIPPED',
          message: 'You have already skipped this card'
        };
      }

      // ========== VALIDATION LAYER 4: Bid Increment Rules ==========
      const minimumBid = this.calculateMinimumBid(this.currentCard.currentBid);

      if (bidAmount < minimumBid) {
        return {
          success: false,
          error: 'INVALID_INCREMENT',
          message: `Minimum bid is £${minimumBid}`,
          currentBid: this.currentCard.currentBid,
          minimumBid: minimumBid,
          requiredIncrement: this.currentCard.currentBid < 100 ? 5 : 10
        };
      }

      // ✓ ALL VALIDATIONS PASSED - Update state
      const previousBidder = this.currentCard.currentBidder;
      const previousBid = this.currentCard.currentBid;

      this.currentCard.currentBid = bidAmount;
      this.currentCard.currentBidder = playerId;
      this.currentCard.bidHistory.push({
        playerId: playerId,
        amount: bidAmount,
        timestamp: Date.now()
      });

      playerState.bid = true;
      playerState.amount = bidAmount;

      this.room.auction.totalBids++;

      // BROADCAST bid to all players
      this.io.to(`room_${this.room.roomCode}`).emit('auction:bid-received', {
        cardId: this.currentCard.cardId,
        bidder: {
          userId: playerId,
          username: player.username
        },
        previousBid: previousBid,
        newBid: bidAmount,
        bidIncrement: bidAmount - previousBid,
        remainingSeconds: this.remainingTime
      });

      console.log(
        `[Auction] ${player.username} bid £${bidAmount} on ${this.currentCard.name} ` +
        `(remaining: £${player.balance - bidAmount})`
      );

      return { success: true };
    } catch (error) {
      console.error('[AuctionEngine] processPlayerBid error:', error);
      return {
        success: false,
        error: 'SERVER_ERROR',
        message: error.message
      };
    }
  }

  /**
   * Process player skip
   */
  processPlayerSkip(playerId) {
    try {
      if (!this.room.players.has(playerId)) {
        return { success: false, error: 'NOT_IN_ROOM' };
      }

      const playerState = this.playerBidStates.get(playerId);
      const player = this.room.players.get(playerId);

      if (playerState.skipped) {
        return {
          success: false,
          error: 'ALREADY_SKIPPED',
          message: 'You have already skipped this card'
        };
      }

      if (playerState.bid) {
        return {
          success: false,
          error: 'ALREADY_BID',
          message: 'You cannot skip after bidding'
        };
      }

      // Mark as skipped
      playerState.skipped = true;

      // Broadcast skip
      this.io.to(`room_${this.room.roomCode}`).emit('auction:player-skipped', {
        cardId: this.currentCard.cardId,
        userId: playerId,
        username: player.username,
        skippedCount: this.countSkippedPlayers(),
        totalPlayers: this.room.players.size,
        allSkipped: this.allPlayersSkipped()
      });

      // If all skipped, resolve immediately
      if (this.allPlayersSkipped()) {
        this.stopTimer();
        this.resolveCard();
      }

      return { success: true };
    } catch (error) {
      console.error('[AuctionEngine] processPlayerSkip error:', error);
      return { success: false, error: 'SERVER_ERROR' };
    }
  }

  /**
   * Resolve current card (assign to winner or discard)
   */
  resolveCard() {
    try {
      if (!this.currentCard) return;

      this.currentCard.status = 'resolved';
      this.room.auction.cardIndex++;

      // CASE 1: Card sold to highest bidder
      if (this.currentCard.currentBidder) {
        const winner = this.room.players.get(this.currentCard.currentBidder);
        const finalBid = this.currentCard.currentBid;

        // Deduct from balance
        winner.balance -= finalBid;

        // Get full card object and add to team
        const fullCard = CardDeckManager.getCardById(this.currentCard.cardId);
        winner.team.push(fullCard);

        this.room.auction.cardsAuctioned++;

        this.io.to(`room_${this.room.roomCode}`).emit('auction:card-result', {
          cardId: this.currentCard.cardId,
          cardName: this.currentCard.name,
          status: 'sold',
          winner: {
            userId: this.currentCard.currentBidder,
            username: winner.username,
            finalBid: finalBid
          },
          remainingBalance: winner.balance,
          cardDetails: {
            position: this.currentCard.position,
            stats: this.currentCard.stats
          }
        });

        console.log(
          `[Auction] ${winner.username} won ${this.currentCard.name} for £${finalBid}`
        );
      }
      // CASE 2: No bids - card discarded
      else {
        this.room.auction.cardsDiscarded++;

        this.io.to(`room_${this.room.roomCode}`).emit('auction:card-result', {
          cardId: this.currentCard.cardId,
          cardName: this.currentCard.name,
          status: 'discarded',
          reason: 'NO_BIDS'
        });

        console.log(`[Auction] ${this.currentCard.name} discarded (no bids)`);
      }

      this.currentCard = null;

      // Check if auction complete
      if (this.room.auction.cardIndex >= this.room.cardDeck.length) {
        this.endAuction();
      } else {
        // Schedule next card with 500ms delay
        setTimeout(() => {
          this.presentNextCard();
        }, 500);
      }
    } catch (error) {
      console.error('[AuctionEngine] resolveCard error:', error);
    }
  }

  /**
   * End auction, move to team review phase
   */
  endAuction() {
    try {
      this.room.status = 'team_review';

      this.io.to(`room_${this.room.roomCode}`).emit('auction:ended', {
        status: 'auction_complete',
        timestamp: Date.now(),
        finalStats: {
          totalBids: this.room.auction.totalBids,
          cardsAuctioned: this.room.auction.cardsAuctioned,
          cardsDiscarded: this.room.auction.cardsDiscarded,
          cardsSkipped: this.room.cardDeck.length -
                        this.room.auction.cardsAuctioned -
                        this.room.auction.cardsDiscarded,
          avgBidPerCard: (
            this.room.auction.totalBids /
            (this.room.auction.cardsAuctioned || 1)
          ).toFixed(2)
        },
        nextPhase: 'team_review',
        teamReviewTimeMs: 30000
      });

      console.log(
        `[Auction] Auction complete for ${this.room.roomCode}. ` +
        `Cards: ${this.room.auction.cardsAuctioned} auctioned, ` +
        `${this.room.auction.cardsDiscarded} discarded`
      );
    } catch (error) {
      console.error('[AuctionEngine] endAuction error:', error);
    }
  }

  /**
   * Calculate minimum bid based on current bid amount
   * Rules: +£5 until £100, then +£10 above £100
   */
  calculateMinimumBid(currentBid) {
    if (currentBid < 100) {
      return currentBid + 5;
    } else {
      return currentBid + 10;
    }
  }

  /**
   * Count players who have skipped this card
   */
  countSkippedPlayers() {
    let count = 0;
    for (const state of this.playerBidStates.values()) {
      if (state.skipped) count++;
    }
    return count;
  }

  /**
   * Check if all players have skipped
   */
  allPlayersSkipped() {
    for (const state of this.playerBidStates.values()) {
      if (!state.skipped && !state.bid) {
        return false;
      }
    }
    return true;
  }

  /**
   * Shuffle array (Fisher-Yates)
   */
  shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

module.exports = AuctionEngine;
