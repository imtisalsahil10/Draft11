# Constants, Validators & Utilities

## 1. GAME CONSTANTS (backend/src/utils/constants.js)

```javascript
/**
 * Global game constants
 */

module.exports = {
  // Game rules
  INITIAL_BALANCE: 1000,
  MAX_PLAYERS_PER_ROOM: 5,
  MIN_PLAYERS_TO_START: 2,
  AUCTION_TIMER_SECONDS: 30,
  TEAM_SIZE: 11,
  TOTAL_CARDS: 100,

  // Bid rules
  BID_INCREMENT_THRESHOLD: 100, // Price at which increment changes
  BID_INCREMENT_LOW: 5,  // Before £100
  BID_INCREMENT_HIGH: 10, // From £100 onwards

  // Card categories
  CARD_CATEGORIES: {
    BASIC: 'Basic',
    RARE: 'Rare',
    LEGENDARY: 'Legendary'
  },

  // Starting prices by category
  START_PRICES: {
    Basic: 10,
    Rare: 15,
    Legendary: 25
  },

  // Card distribution
  CARD_DISTRIBUTION: {
    Basic: 60,
    Rare: 30,
    Legendary: 10
  },

  // Positions (4-3-3 formation)
  POSITIONS: {
    GK: 'Goalkeeper',
    CB: 'Center Back',
    LB: 'Left Back',
    RB: 'Right Back',
    CM: 'Midfielder',
    CAM: 'Attacking Midfielder',
    CDM: 'Defensive Midfielder',
    LW: 'Left Winger',
    RW: 'Right Winger',
    ST: 'Striker',
    CF: 'Center Forward'
  },

  // Stat ranges
  STAT_RANGES: {
    pace: { min: 50, max: 99 },
    shooting: { min: 30, max: 99 },
    passing: { min: 40, max: 95 },
    defense: { min: 20, max: 99 },
    physical: { min: 40, max: 99 },
    overall: { min: 50, max: 99 }
  },

  // Room code format
  ROOM_CODE_LENGTH: 6,
  ROOM_CODE_PATTERN: /^[A-Z0-9]{6}$/,

  // Username constraints
  USERNAME_MIN_LENGTH: 2,
  USERNAME_MAX_LENGTH: 20,
  USERNAME_PATTERN: /^[a-zA-Z0-9_-]{2,20}$/,

  // Timeouts
  TEAM_REVIEW_TIMEOUT_MS: 30000,
  CARD_RESOLUTION_DELAY_MS: 500,
  DISCONNECT_TIMEOUT_MS: 30000, // Mark player offline after 30s

  // Error codes
  ERROR_CODES: {
    ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
    ROOM_FULL: 'ROOM_FULL',
    USERNAME_TAKEN: 'USERNAME_TAKEN',
    NOT_IN_ROOM: 'NOT_IN_ROOM',
    NOT_CREATOR: 'NOT_CREATOR',
    INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
    INVALID_INCREMENT: 'INVALID_INCREMENT',
    PLAYER_SKIPPED: 'PLAYER_SKIPPED',
    TIMER_EXPIRED: 'TIMER_EXPIRED',
    INVALID_INPUT: 'INVALID_INPUT',
    INSUFFICIENT_PLAYERS: 'INSUFFICIENT_PLAYERS',
    CARD_NOT_ACTIVE: 'CARD_NOT_ACTIVE',
    SERVER_ERROR: 'SERVER_ERROR'
  },

  // Game statuses
  ROOM_STATUS: {
    WAITING: 'waiting',
    AUCTIONING: 'auctioning',
    TEAM_REVIEW: 'team_review',
    MATCHING: 'matching',
    FINISHED: 'finished'
  },

  // Player statuses
  PLAYER_STATUS: {
    WAITING: 'waiting',
    BIDDING: 'bidding',
    READY: 'ready',
    OFFLINE: 'offline'
  }
};
```

---

## 2. VALIDATORS (backend/src/utils/validators.js)

```javascript
const constants = require('./constants');

/**
 * Validation utilities
 */

class Validator {
  /**
   * Validate room code format
   */
  static isValidRoomCode(code) {
    if (!code || typeof code !== 'string') return false;
    return constants.ROOM_CODE_PATTERN.test(code.toUpperCase());
  }

  /**
   * Validate username
   */
  static isValidUsername(username) {
    if (!username || typeof username !== 'string') return false;
    if (username.length < constants.USERNAME_MIN_LENGTH) return false;
    if (username.length > constants.USERNAME_MAX_LENGTH) return false;
    return constants.USERNAME_PATTERN.test(username);
  }

  /**
   * Validate bid amount (positive integer)
   */
  static isValidBidAmount(amount) {
    return Number.isInteger(amount) && amount > 0;
  }

  /**
   * Validate bid meets minimum increment requirement
   */
  static isValidBidIncrement(currentBid, proposedBid) {
    const minimumBid = this.calculateMinimumBid(currentBid);
    return proposedBid >= minimumBid;
  }

  /**
   * Calculate minimum bid based on current bid
   */
  static calculateMinimumBid(currentBid) {
    if (currentBid < constants.BID_INCREMENT_THRESHOLD) {
      return currentBid + constants.BID_INCREMENT_LOW;
    } else {
      return currentBid + constants.BID_INCREMENT_HIGH;
    }
  }

  /**
   * Validate player can afford bid
   */
  static canAffordBid(balance, bidAmount) {
    return balance >= bidAmount;
  }

  /**
   * Validate team size (11 players required for match)
   */
  static isValidTeamSize(teamSize) {
    return teamSize === constants.TEAM_SIZE;
  }

  /**
   * Validate card ID format
   */
  static isValidCardId(cardId) {
    return typeof cardId === 'string' && cardId.startsWith('card_');
  }

  /**
   * Validate player count for game start
   */
  static hasMinimumPlayers(playerCount) {
    return playerCount >= constants.MIN_PLAYERS_TO_START;
  }

  /**
   * Validate room not full
   */
  static canAddPlayer(currentPlayerCount) {
    return currentPlayerCount < constants.MAX_PLAYERS_PER_ROOM;
  }
}

module.exports = Validator;
```

---

## 3. CARD GENERATOR (backend/src/utils/cardGenerator.js)

```javascript
const constants = require('./constants');

/**
 * Generate custom football cards (no FIFA branding)
 */

const FIRST_NAMES = [
  'Alex', 'Jordan', 'Sam', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie',
  'Dakota', 'Morgan', 'Skylar', 'Phoenix', 'River', 'Winter', 'Storm', 'Sage'
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez'
];

const NATIONALITIES = [
  'England', 'Spain', 'Germany', 'Italy', 'France', 'Portugal', 'Netherlands',
  'Argentina', 'Brazil', 'Uruguay', 'Mexico', 'Belgium', 'Poland'
];

const CLUBS = [
  'City United', 'Star Athletic', 'Pride FC', 'Royal Rangers', 'Eagles',
  'Phoenix Rising', 'Storm United', 'Titans', 'Legends', 'Elite FC'
];

class CardGenerator {
  /**
   * Generate 100 unique cards with realistic stats
   */
  static generateDeck() {
    const cards = [];
    let cardId = 1;

    // Generate Basic cards (60)
    for (let i = 0; i < constants.CARD_DISTRIBUTION.Basic; i++) {
      cards.push(this.generateCard(
        cardId++,
        constants.CARD_CATEGORIES.BASIC,
        { min: 70, max: 80 } // Overall rating range
      ));
    }

    // Generate Rare cards (30)
    for (let i = 0; i < constants.CARD_DISTRIBUTION.Rare; i++) {
      cards.push(this.generateCard(
        cardId++,
        constants.CARD_CATEGORIES.RARE,
        { min: 80, max: 86 }
      ));
    }

    // Generate Legendary cards (10)
    for (let i = 0; i < constants.CARD_DISTRIBUTION.Legendary; i++) {
      cards.push(this.generateCard(
        cardId++,
        constants.CARD_CATEGORIES.LEGENDARY,
        { min: 87, max: 99 }
      ));
    }

    return cards;
  }

  /**
   * Generate single card with random stats
   */
  static generateCard(id, category, overallRange) {
    const overall = Math.floor(
      Math.random() * (overallRange.max - overallRange.min + 1) + overallRange.min
    );

    // Stats correlate with overall rating
    const statVariance = Math.max(0, overall - 75); // Variance increases with rating

    return {
      cardId: `card_${String(id).padStart(3, '0')}`,
      name: `${this.getRandomElement(FIRST_NAMES)} ${this.getRandomElement(LAST_NAMES)}`,
      position: this.getRandomElement(Object.keys(constants.POSITIONS)),
      nation: this.getRandomElement(NATIONALITIES),
      club: this.getRandomElement(CLUBS),
      stats: {
        pace: this.clampStat(overall - Math.random() * 15, 'pace'),
        shooting: this.clampStat(overall - Math.random() * 20, 'shooting'),
        passing: this.clampStat(overall - Math.random() * 15, 'passing'),
        defense: this.clampStat(overall - Math.random() * 25, 'defense'),
        physical: this.clampStat(overall - Math.random() * 10, 'physical'),
        overall
      },
      category,
      basePrice: constants.START_PRICES[category],
      rarity: category.toLowerCase(),
      imageUrl: `/cards/card_${String(id).padStart(3, '0')}.svg`,
      createdAt: new Date()
    };
  }

  /**
   * Clamp stat to valid range
   */
  static clampStat(value, statName) {
    const range = constants.STAT_RANGES[statName];
    return Math.max(range.min, Math.min(range.max, Math.round(value)));
  }

  /**
   * Get random element from array
   */
  static getRandomElement(array) {
    return array[Math.floor(Math.random() * array.length)];
  }

  /**
   * Calculate card rarity colors for UI
   */
  static getRarityColor(category) {
    const colors = {
      Basic: '#999999',      // Gray
      Rare: '#4169E1',       // Royal Blue
      Legendary: '#FFD700'   // Gold
    };
    return colors[category] || '#999999';
  }
}

module.exports = CardGenerator;
```

---

## 4. FORMATTERS (frontend/src/utils/formatters.ts)

```typescript
/**
 * Format data for display
 */

export const formatCurrency = (amount: number): string => {
  return `£${amount.toLocaleString()}`;
};

export const formatRating = (rating: number): string => {
  return rating.toFixed(1);
};

export const formatTime = (seconds: number): string => {
  if (seconds <= 0) return '0s';
  return `${seconds}s`;
};

export const formatPlayerCount = (current: number, max: number): string => {
  return `${current}/${max}`;
};

export const formatPosition = (posCode: string): string => {
  const positions: { [key: string]: string } = {
    GK: 'Goalkeeper',
    CB: 'Center Back',
    LB: 'Left Back',
    RB: 'Right Back',
    CM: 'Midfielder',
    CAM: 'Attacking Mid',
    CDM: 'Defensive Mid',
    LW: 'Left Wing',
    RW: 'Right Wing',
    ST: 'Striker',
    CF: 'Center Forward'
  };
  return positions[posCode] || posCode;
};

export const formatCardCategory = (category: string): string => {
  return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
};

export const getRarityBadgeColor = (category: string): string => {
  const colors: { [key: string]: string } = {
    Basic: 'bg-gray-400',
    Rare: 'bg-blue-500',
    Legendary: 'bg-yellow-500'
  };
  return colors[category] || 'bg-gray-400';
};

export const formatStats = (stats: CardStats): string[] => {
  return [
    `Pace: ${stats.pace}`,
    `Shooting: ${stats.shooting}`,
    `Passing: ${stats.passing}`,
    `Defense: ${stats.defense}`,
    `Physical: ${stats.physical}`,
    `Overall: ${stats.overall}`
  ];
};

export const formatMatchResult = (scoreA: number, scoreB: number): string => {
  return `${scoreA} - ${scoreB}`;
};

export const formatGameDuration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
};
```

---

## 5. TESTING UTILITIES (backend/scripts/testSocket.js)

```javascript
/**
 * Test Socket.IO connection and basic events
 */

const io = require('socket.io-client');

const SOCKET_URL = 'http://localhost:3001';

async function testSocketConnection() {
  console.log('Testing Socket.IO connection...');

  const socket = io(SOCKET_URL, {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5
  });

  return new Promise((resolve, reject) => {
    socket.on('connect', () => {
      console.log('✅ Connected to server');

      // Test room:join event
      socket.emit('room:join', {
        roomCode: 'TEST1',
        userId: 'test_user_1',
        username: 'TestPlayer'
      });

      socket.on('room:player-joined', (data) => {
        console.log('✅ room:player-joined received:', data.player.username);
        socket.disconnect();
        resolve(true);
      });

      socket.on('room:join-error', (error) => {
        console.error('❌ room:join-error:', error);
        socket.disconnect();
        reject(error);
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        console.error('❌ Test timeout');
        socket.disconnect();
        reject(new Error('Test timeout'));
      }, 5000);
    });

    socket.on('connect_error', (error) => {
      console.error('❌ Connection error:', error);
      reject(error);
    });
  });
}

// Run test
testSocketConnection()
  .then(() => {
    console.log('\n✅ Socket.IO tests passed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Socket.IO tests failed:', error.message);
    process.exit(1);
  });
```

---

## 6. QUICK REFERENCE

### Bid Increment Calculation
```javascript
calculateMinimumBid(currentBid) {
  if (currentBid < 100) return currentBid + 5;
  return currentBid + 10;
}

// Examples:
// £10 → £15
// £95 → £100 (last £5 increment)
// £100 → £110 (switch to £10)
// £150 → £160
```

### Team Rating Calculation
```javascript
teamRating = (sum of all player ratings) / 11

// Example:
// 11 players with average 85 → team rating = 85.0
```

### Win Probability (Elo-like)
```javascript
ratingDiff = (ratingA - ratingB) * factors
winProbability = 1 / (1 + 10^(-ratingDiff/400))

// If A is 5 points stronger, A wins ~55% of matches
```

### Socket Message Sizes
```
card-presented: ~500 bytes
bid-received: ~150 bytes
timer-tick: ~50 bytes
card-result: ~300 bytes

Total for 45-card auction: ~100 KB
```

