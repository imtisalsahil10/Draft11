# Data Models & MongoDB Schemas

## 1. MONGODB COLLECTIONS

### 1.1 Players Collection
Used for persistent player profiles and statistics.

```javascript
// Collection: players

db.players.insertOne({
  _id: ObjectId(),
  username: "john_doe",
  email: "john@example.com", // optional, for future login
  emailHash: "sha256_hash",
  createdAt: ISODate("2025-12-29T10:00:00Z"),
  stats: {
    totalGamesPlayed: 15,
    gamesWon: 8,
    avgBudgetRemaining: 150, // after all auctions
    avgTeamRating: 82.5,
    totalSpent: 10500, // across all games
    favoritePosition: "ST" // most purchased
  },
  preferences: {
    showBudget: true,
    showTeam: false,
    notifications: true
  }
});
```

### 1.2 Games Collection
Complete game records for leaderboards and analysis.

```javascript
// Collection: games

db.games.insertOne({
  _id: ObjectId(),
  gameId: "GAME_20251229_ABC123",
  roomCode: "ABC123",
  createdAt: ISODate("2025-12-29T10:00:00Z"),
  endedAt: ISODate("2025-12-29T10:25:00Z"),
  duration: 1500, // seconds
  createdBy: "john_doe",
  
  players: [
    {
      userId: "playerId_1",
      username: "john_doe",
      initialBalance: 1000,
      finalBalance: 350,
      totalSpent: 650,
      team: [
        {
          cardId: "card_001",
          name: "Player Name",
          position: "ST",
          pace: 92,
          shooting: 89,
          passing: 81,
          defense: 45,
          physical: 87,
          rating: 88,
          pricePaid: 120,
          category: "Rare"
        }
        // ... 11 cards max
      ],
      finalTeamRating: 85.2,
      matchScore: 2,
      result: "won"
    }
    // ... max 5 players
  ],
  
  auction: {
    totalCardsPresented: 100,
    cardsAuctioned: 87,
    cardsDiscarded: 13,
    cardsSkipped: 5,
    totalBids: 234,
    avgBidPerCard: 7.8
  },
  
  match: {
    type: "1v1", // or "tournament" if >2 players
    matchups: [
      {
        playerA: "playerId_1",
        playerB: "playerId_2",
        scoreA: 2,
        scoreB: 1,
        winner: "playerId_1",
        mvp: "card_001"
      }
    ],
    finalLeaderboard: [
      { rank: 1, userId: "playerId_1", username: "john_doe", score: 6, points: 3 },
      { rank: 2, userId: "playerId_2", username: "jane_smith", score: 5, points: 0 }
    ]
  },
  
  status: "completed" // or "abandoned"
});
```

### 1.3 Leaderboards Collection
Aggregated stats for quick leaderboard queries.

```javascript
// Collection: leaderboards

db.leaderboards.insertOne({
  _id: ObjectId(),
  userId: "playerId_1",
  username: "john_doe",
  season: "2025-Q4", // for seasonal leaderboards
  
  rank: 1,
  points: 285, // from wins (3 per win, 1 per participation)
  
  stats: {
    gamesPlayed: 15,
    gamesWon: 8,
    winRate: 0.533,
    avgScore: 5.2, // goals per match
    totalBudgetRemainingSum: 2250, // across all games
    avgBudgetRemaining: 150,
    totalSpent: 10500,
    favoritePosition: "ST",
    mostPurchasedPlayer: "player_name"
  },
  
  recentGames: [
    {
      gameId: "GAME_20251229_ABC123",
      opponent: ["jane_smith"],
      result: "win",
      score: "2-1",
      date: ISODate("2025-12-29T10:00:00Z")
    }
    // ... last 10 games
  ],
  
  updatedAt: ISODate("2025-12-29T10:25:00Z")
});
```

### 1.4 Cards Collection
Master list of all 100 football player cards.

```javascript
// Collection: cards

db.cards.insertOne({
  _id: ObjectId(),
  cardId: "card_001",
  name: "Erling Haaland",
  position: "ST", // ST, CF, LW, RW, CAM, CM, CDM, LB, RB, CB, GK
  nation: "Norway",
  club: "Custom Club",
  
  stats: {
    pace: 92,
    shooting: 89,
    passing: 81,
    defense: 45,
    physical: 87,
    overall: 88
  },
  
  category: "Legendary", // Basic, Rare, Legendary
  basePrice: 25, // starting price for auction
  rarity: "legendary",
  imageUrl: "/cards/card_001.svg", // custom SVG or PNG
  
  createdAt: ISODate("2025-12-29T00:00:00Z")
});

// Example cards distribution:
// - 60 Basic cards (Pace 70-80, Overall 75-80): £10 start
// - 30 Rare cards (Pace 80-90, Overall 80-86): £15 start
// - 10 Legendary cards (Pace 90+, Overall 87-99): £25 start
```

## 2. IN-MEMORY GAME STATE MODELS

Used during active games, **NOT** persisted.

```javascript
// RoomManager manages all active rooms

class Room {
  constructor(roomCode, createdBy) {
    this.roomCode = roomCode;
    this.createdBy = createdBy;
    this.status = "waiting"; // waiting → auctioning → finished
    this.maxPlayers = 5;
    
    this.players = new Map(); // playerId → PlayerInGame
    this.cardDeck = []; // shuffled array of cardIds
    this.currentCard = null; // Card being auctioned
    this.auction = {
      cardIndex: 0,
      skippedPlayers: new Set(),
      discardedCards: 0,
      passedCards: 0
    };
    
    this.matchResults = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.endedAt = null;
  }
}

class PlayerInGame {
  constructor(userId, username) {
    this.userId = userId;
    this.username = username;
    this.socketId = null; // assigned on join
    this.startBalance = 1000;
    this.balance = 1000;
    this.team = []; // array of Card objects (max 11)
    this.bidsPlaced = 0;
    this.consecutiveSkips = 0;
    this.status = "waiting"; // waiting → bidding → ready
  }
}

class CardInAuction {
  constructor(cardId, card) {
    this.cardId = cardId;
    this.name = card.name;
    this.position = card.position;
    this.stats = card.stats;
    this.basePrice = card.basePrice;
    this.category = card.category;
    
    this.currentBid = card.basePrice;
    this.currentBidder = null; // playerId
    this.bidHistory = []; // { playerId, amount, timestamp }
    this.timerStart = null;
    this.timerEnd = null;
  }
}
```

## 3. TYPE DEFINITIONS (TypeScript/Frontend)

```typescript
// types/game.ts

export interface Card {
  cardId: string;
  name: string;
  position: Position;
  nation: string;
  club: string;
  stats: CardStats;
  category: CardCategory;
  basePrice: number;
  rarity: Rarity;
  imageUrl: string;
}

export type Position = "ST" | "CF" | "LW" | "RW" | "CAM" | "CM" | "CDM" | "LB" | "RB" | "CB" | "GK";
export type CardCategory = "Basic" | "Rare" | "Legendary";
export type Rarity = "common" | "rare" | "legendary";

export interface CardStats {
  pace: number;
  shooting: number;
  passing: number;
  defense: number;
  physical: number;
  overall: number;
}

export interface Player {
  userId: string;
  username: string;
  socketId: string;
  startBalance: number;
  balance: number;
  team: Card[];
  bidsPlaced: number;
  consecutiveSkips: number;
  status: "waiting" | "bidding" | "ready";
}

export interface Room {
  roomCode: string;
  createdBy: string;
  status: "waiting" | "auctioning" | "finished";
  maxPlayers: number;
  players: Map<string, Player>;
  currentCard: CardInAuction | null;
  auction: {
    cardIndex: number;
    skippedPlayers: Set<string>;
    discardedCards: number;
    passedCards: number;
  };
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface CardInAuction {
  cardId: string;
  name: string;
  position: Position;
  stats: CardStats;
  basePrice: number;
  category: CardCategory;
  currentBid: number;
  currentBidder: string | null;
  bidHistory: BidRecord[];
  timerStart: number;
  timerEnd: number;
}

export interface BidRecord {
  playerId: string;
  amount: number;
  timestamp: number;
}

export interface GameResult {
  gameId: string;
  roomCode: string;
  players: PlayerGameResult[];
  auction: AuctionStats;
  match: MatchResult;
  duration: number;
  completedAt: Date;
}

export interface PlayerGameResult {
  userId: string;
  username: string;
  initialBalance: number;
  finalBalance: number;
  totalSpent: number;
  team: Card[];
  matchScore: number;
  result: "won" | "lost" | "draw";
}

export interface AuctionStats {
  totalCardsPresented: number;
  cardsAuctioned: number;
  cardsDiscarded: number;
  cardsSkipped: number;
  totalBids: number;
  avgBidPerCard: number;
}

export interface MatchResult {
  type: "1v1" | "tournament";
  matchups: Matchup[];
  finalLeaderboard: LeaderboardEntry[];
}

export interface Matchup {
  playerA: string;
  playerB: string;
  scoreA: number;
  scoreB: number;
  winner: string;
  mvp: string; // cardId
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  score: number;
  points: number; // 3 for win, 1 for participation
}
```

## 4. VALIDATION SCHEMAS

```javascript
// utils/validators.js

const yup = require("yup");

// Room creation validation
const createRoomSchema = yup.object().shape({
  username: yup.string().min(2).max(20).required(),
  roomCode: yup.string().length(6).matches(/^[A-Z0-9]+$/).required()
});

// Bid validation
const bidSchema = yup.object().shape({
  roomCode: yup.string().required(),
  cardId: yup.string().required(),
  bidAmount: yup.number().integer().positive().required()
});

// Skip validation
const skipSchema = yup.object().shape({
  roomCode: yup.string().required(),
  cardId: yup.string().required()
});
```

## 5. DATABASE INDEXES

```javascript
// MongoDB indexes for performance

db.players.createIndex({ username: 1 });
db.players.createIndex({ createdAt: -1 });

db.games.createIndex({ roomCode: 1 });
db.games.createIndex({ createdAt: -1 });
db.games.createIndex({ "players.userId": 1 });
db.games.createIndex({ status: 1 });

db.leaderboards.createIndex({ season: 1, rank: 1 });
db.leaderboards.createIndex({ userId: 1, season: 1 });
db.leaderboards.createIndex({ points: -1, season: 1 });

db.cards.createIndex({ position: 1 });
db.cards.createIndex({ category: 1 });
db.cards.createIndex({ "stats.overall": -1 });
```

## 6. DATABASE MIGRATION STRATEGY

```javascript
// Version your schema

db.migrations.insertOne({
  version: 1,
  name: "initial_schema",
  appliedAt: ISODate("2025-12-29T00:00:00Z"),
  changes: [
    "Created players collection",
    "Created games collection",
    "Created leaderboards collection",
    "Created cards collection"
  ]
});

// Future: Add migration to add new fields
// db.migrations.insertOne({
//   version: 2,
//   name: "add_player_badges",
//   appliedAt: ISODate("2025-12-30T00:00:00Z")
// });
```

