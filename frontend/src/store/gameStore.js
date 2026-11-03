/**
 * GAME STATE STORE (Zustand)
 * Centralized state management for game
 */

import { create } from 'zustand';

export const useGameStore = create((set) => ({
  // Room state
  roomCode: null,
  playerId: null,
  username: null,
  players: [],
  status: 'idle', // idle, waiting, auction, match, finished

  // Auction state
  currentCard: null,
  minimumBid: 0,
  currentBid: 0,
  highestBidder: null,
  bids: [],
  skippedCount: 0,
  timerSeconds: 30,

  // Player state
  balance: 1000,
  team: [],
  cardsWon: 0,

  // Match state
  matchStarted: false,
  matchResult: null,

  // UI state
  loading: false,
  error: null,

  // ACTIONS
  setRoomCode: (code) => set({ roomCode: code }),
  setPlayerId: (id) => set({ playerId: id }),
  setUsername: (name) => set({ username: name }),
  setPlayers: (players) => set({ players }),
  setStatus: (status) => set({ status }),

  setCurrentCard: (card) => set({ currentCard: card }),
  setMinimumBid: (bid) => set({ minimumBid: bid }),
  setCurrentBid: (bid) => set({ currentBid: bid }),
  setHighestBidder: (bidder) => set({ highestBidder: bidder }),
  addBid: (bid) => set((state) => ({ bids: [...state.bids, bid] })),
  setSkippedCount: (count) => set({ skippedCount: count }),
  setTimerSeconds: (seconds) => set((state) => ({ 
    timerSeconds: typeof seconds === 'function' ? seconds(state.timerSeconds) : seconds 
  })),

  setBalance: (balance) => set({ balance }),
  addCardToTeam: (card) => set((state) => ({ team: [...state.team, card] })),
  setCardsWon: (count) => set({ cardsWon: count }),

  setMatchStarted: (started) => set({ matchStarted: started }),
  setMatchResult: (result) => set({ matchResult: result }),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  // Reset game
  reset: () => set({
    roomCode: null,
    playerId: null,
    username: null,
    players: [],
    status: 'idle',
    currentCard: null,
    minimumBid: 0,
    currentBid: 0,
    highestBidder: null,
    bids: [],
    skippedCount: 0,
    timerSeconds: 30,
    balance: 1000,
    team: [],
    cardsWon: 0,
    matchStarted: false,
    matchResult: null,
    loading: false,
    error: null
  })
}));
