/**
 * GAME CONSTANTS
 * Centralized configuration for all game rules and settings
 */

export const GAME_CONFIG = {
  // BALANCE & PRICING
  // The next bid is the current bid plus MIN_BID_INCREMENT while that bid is
  // below BID_INCREMENT_THRESHOLD, and plus BID_INCREMENT_HIGH from the
  // threshold upward. Bids are whole pounds.
  INITIAL_BALANCE: 1000,
  MIN_BID_INCREMENT: 5,
  BID_INCREMENT_THRESHOLD: 100,
  BID_INCREMENT_HIGH: 10,
  
  // PLAYERS & ROOMS
  MAX_PLAYERS_PER_ROOM: 5,
  MIN_PLAYERS_FOR_TOURNAMENT: 3,
  
  // AUCTION
  TOTAL_CARDS: 100,
  CARDS_PER_AUCTION: 100,
  AUCTION_TIMER_SECONDS: 30,
  
  // TEAM BUILDING
  // Auction purchases are limited by INITIAL_BALANCE and by unique card
  // ownership in the room. There is no 14-card purchase cap.
  // A match squad is exactly REQUIRED_TEAM_SIZE. ALLOWED_SUBSTITUTES is
  // unused: substitutions are not an auction or match rule.
  REQUIRED_TEAM_SIZE: 11,
  ALLOWED_SUBSTITUTES: 3,
  
  // POSITIONS (11-a-side football)
  POSITIONS: [
    'GK',  // Goalkeeper
    'CB',  // Center Back
    'LB',  // Left Back
    'RB',  // Right Back
    'CM',  // Center Midfielder
    'CAM', // Attacking Midfielder
    'CDM', // Defensive Midfielder
    'LW',  // Left Winger
    'RW',  // Right Winger
    'ST',  // Striker
    'CF'   // Center Forward
  ],
  
  // CARD CATEGORIES & PRICING
  CARD_CATEGORIES: {
    LEGENDARY: { basePrice: 25, rarity: 'Legendary' },
    RARE: { basePrice: 15, rarity: 'Rare' },
    BASIC: { basePrice: 10, rarity: 'Basic' }
  },
  
  // MATCH SIMULATION
  MATCH_DURATION_MINUTES: 90,
  TOURNAMENT_FORMAT: 'round-robin', // single-elimination or round-robin
  
  // TIMINGS
  ROOM_TIMEOUT_MS: 3600000, // 1 hour
  DISCONNECT_TIMEOUT_MS: 30000 // 30 seconds
};

// Bump this when the live-room document shape changes in a way older
// processes must not load. Unknown versions are left in MongoDB untouched.
// A seat lineup (formation, revision, places, card ids) is optional at this
// version. Documents saved before lineups existed still load.
export const ROOM_SCHEMA_VERSION = 1;

// League documents are separate from live rooms. Version 2 adds an optional
// participating squad on each member and fixture lineup confirmations.
// A member may also store auctionSeat: the hash of a finished live-room seat
// token, the room id, and the seat id. The raw token is not stored.
// Version 1 documents still load. This process writes version 2.
export const LEAGUE_SCHEMA_VERSION = 2;

/**
 * Bidding clock for a card. The default stays AUCTION_TIMER_SECONDS.
 * A shorter AUCTION_TIMER_MS is accepted only inside that range so tests can
 * finish an auction without changing the clock for a normal server.
 */
export function auctionTimerMs() {
  const configured = Number(process.env.AUCTION_TIMER_MS);
  const maximum = GAME_CONFIG.AUCTION_TIMER_SECONDS * 1000;
  if (Number.isInteger(configured) && configured >= 500 && configured <= maximum) {
    return configured;
  }
  return maximum;
}

/**
 * Gap between a sale and the ready prompt, and between ready and the next
 * card. The defaults stay 2000ms and 1000ms. A shorter AUCTION_GAP_MS is
 * accepted only inside that range so a test server can move on without
 * changing a normal server.
 */
export function auctionGapMs(kind) {
  const configured = Number(process.env.AUCTION_GAP_MS);
  const fallback = kind === 'ready-prompt' ? 2000 : 1000;
  if (Number.isInteger(configured) && configured >= 50 && configured <= fallback) {
    return configured;
  }
  return fallback;
}

export const PLAYER_STATS = [
  'pace',
  'shooting',
  'passing',
  'defense',
  'physical',
  'overall'
];

export const STAT_WEIGHTS = {
  pace: 0.15,
  shooting: 0.15,
  passing: 0.20,
  defense: 0.20,
  physical: 0.15,
  overall: 0.15
};

export const ERROR_CODES = {
  // Room errors
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_ALREADY_STARTED: 'ROOM_ALREADY_STARTED',
  PLAYER_ALREADY_IN_ROOM: 'PLAYER_ALREADY_IN_ROOM',
  
  // Auction errors
  AUCTION_NOT_ACTIVE: 'AUCTION_NOT_ACTIVE',
  INVALID_BID: 'INVALID_BID',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INVALID_BID_INCREMENT: 'INVALID_BID_INCREMENT',
  CANNOT_BID_TWICE: 'CANNOT_BID_TWICE',
  
  // Team errors
  TEAM_INCOMPLETE: 'TEAM_INCOMPLETE',
  INVALID_POSITION: 'INVALID_POSITION',
  DUPLICATE_POSITION: 'DUPLICATE_POSITION',
  DUPLICATE_PLAYER: 'DUPLICATE_PLAYER',
  CARD_NOT_OWNED: 'CARD_NOT_OWNED',
  INVALID_FORMATION: 'INVALID_FORMATION',
  STALE_LINEUP: 'STALE_LINEUP',
  AUCTION_NOT_FINISHED: 'AUCTION_NOT_FINISHED',
  
  // General errors
  INVALID_PARAMETERS: 'INVALID_PARAMETERS',
  SERVER_ERROR: 'SERVER_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED'
};
