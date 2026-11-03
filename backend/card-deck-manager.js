/**
 * CARD DECK MANAGER
 * Manages card deck per room
 */

import { shuffleArray, logWithTime } from './utils.js';
import { GAME_CONFIG } from './constants.js';
import { testCardLimitEnabled } from './security/production.js';

export class CardDeckManager {
  constructor(allCards = []) {
    this.allCards = allCards;
    this.roomDecks = new Map();
  }
  
  /**
   * Initialize deck for a room (shuffle cards)
   */
  initializeRoomDeck(roomCode) {
    if (!this.allCards || this.allCards.length === 0) {
      logWithTime(`Warning: No cards available for room ${roomCode}`, 'WARN');
      return [];
    }
    
    const shuffled = shuffleArray(this.allCards);
    const limit = Number(process.env.AUCTION_CARD_LIMIT);
    const testLimit = testCardLimitEnabled()
      && Number.isInteger(limit)
      && limit > 0
      && limit < shuffled.length;
    const cards = testLimit ? shuffled.slice(0, limit) : shuffled;
    const deck = {
      cards,
      currentIndex: 0,
      discardedCards: [],
      auctionedCards: []
    };
    
    this.roomDecks.set(roomCode, deck);
    logWithTime(`Deck initialized for room ${roomCode} with ${deck.cards.length} cards`);
    return deck.cards;
  }
  
  /**
   * Get next card from deck
   */
  getNextCard(roomCode) {
    const deck = this.roomDecks.get(roomCode);
    if (!deck || deck.currentIndex >= deck.cards.length) {
      return null;
    }
    
    const card = deck.cards[deck.currentIndex];
    deck.currentIndex++;
    return card;
  }
  
  /**
   * Mark card as auctioned
   */
  markAuctioned(roomCode, cardId, winnerId) {
    const deck = this.roomDecks.get(roomCode);
    if (!deck) return false;
    
    deck.auctionedCards.push({
      cardId,
      winnerId,
      auctionedAt: Date.now()
    });
    return true;
  }
  
  /**
   * Mark card as discarded
   */
  markDiscarded(roomCode, cardId) {
    const deck = this.roomDecks.get(roomCode);
    if (!deck) return false;
    
    deck.discardedCards.push({
      cardId,
      discardedAt: Date.now()
    });
    return true;
  }
  
  /**
   * Get deck status
   */
  getDeckStatus(roomCode) {
    const deck = this.roomDecks.get(roomCode);
    if (!deck) return null;
    
    return {
      totalCards: deck.cards.length,
      currentIndex: deck.currentIndex,
      remainingCards: deck.cards.length - deck.currentIndex,
      auctionedCount: deck.auctionedCards.length,
      discardedCount: deck.discardedCards.length
    };
  }
  
  /**
   * Clean up room deck
   */
  clearRoomDeck(roomCode) {
    this.roomDecks.delete(roomCode);
  }

  /**
   * Put a recovered deck back. currentIndex stays on the auction, not here.
   */
  restoreRoomDeck(roomCode, cards) {
    this.roomDecks.set(roomCode, {
      cards: cards || [],
      currentIndex: 0,
      discardedCards: [],
      auctionedCards: []
    });
  }
}
