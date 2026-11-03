# Socket.IO Event Design & Protocol

## 1. SOCKET.IO NAMESPACE STRUCTURE

```
/                  → General server connection
/rooms/:roomCode   → Room-specific events (auction, match)
```

## 2. CONNECTION & AUTHENTICATION FLOW

```
Client                              Server
  |                                  |
  |--- io.connect("http://api") --→  |
  |                                  |
  |← connection (socket.id) --------|
  |                                  |
  |--- REST POST /api/rooms/join -→  | (validates, creates room)
  |← { roomCode, playerId } ---------|
  |                                  |
  |--- socket.emit("room:join", {---→| (WebSocket upgrade)
  |    roomCode, playerId, username) |
  |                                  |
  |← socket.on("room:player-joined") | (joins namespace)
  |   { players, status }  ----------|
  |                                  |
```

## 3. DETAILED EVENT SPECIFICATIONS

### CONNECTION EVENTS

#### `connection` (Server → Client, automatic)
```javascript
// Emitted when socket connects successfully
// No explicit emit needed, built-in Socket.IO event

socket.on("connect", () => {
  console.log("Connected with socket:", socket.id);
});

socket.on("disconnect", (reason) => {
  console.log("Disconnected:", reason);
});
```

---

### ROOM MANAGEMENT EVENTS

#### `room:join` (Client → Server)
Request to join a room via WebSocket.
```javascript
// CLIENT
socket.emit("room:join", {
  roomCode: "ABC123",
  userId: "player_1",
  username: "john_doe"
});

// SERVER
socket.on("room:join", async (data) => {
  const { roomCode, userId, username } = data;
  // Validate room exists, player not already in room
  // Add player to room
  // Update socket's room namespace
  // Broadcast to all players in room
});
```

**Server Response (Broadcast to room):**
```javascript
// SERVER
io.to(roomCode).emit("room:player-joined", {
  player: {
    userId: "player_1",
    username: "john_doe",
    balance: 1000,
    team: [],
    status: "waiting"
  },
  totalPlayers: 2,
  players: [ /* all players in room */ ]
});
```

**Error Handling:**
```javascript
socket.emit("room:join-error", {
  error: "ROOM_FULL" | "ROOM_NOT_FOUND" | "USERNAME_TAKEN" | "ALREADY_IN_ROOM",
  message: "Room is full. Max 5 players allowed."
});
```

---

#### `room:leave` (Client → Server)
```javascript
// CLIENT
socket.emit("room:leave", {
  roomCode: "ABC123",
  userId: "player_1"
});

// SERVER BROADCASTS
io.to(roomCode).emit("room:player-left", {
  userId: "player_1",
  username: "john_doe",
  totalPlayers: 1,
  players: [ /* remaining players */ ]
});

// If room empty, delete room from memory
// If game in progress, penalize disconnected player
```

---

#### `room:status` (Server → Client, broadcast)
Periodic status update (sent every 5s or on change).
```javascript
io.to(roomCode).emit("room:status", {
  status: "waiting", // or "auctioning" or "finished"
  playerCount: 2,
  playersReady: 1,
  canStart: true, // all players joined?
  auctionProgress: {
    cardIndex: 0,
    totalCards: 100,
    cardsRemaining: 100
  }
});
```

---

#### `room:start` (Client → Server)
Only the room creator can start the auction.
```javascript
// CLIENT
socket.emit("room:start", {
  roomCode: "ABC123",
  createdBy: "player_1"
});

// SERVER VALIDATES
// - Player is creator
// - At least 2 players in room
// - No game currently in progress

// SERVER BROADCASTS
io.to(roomCode).emit("room:started", {
  status: "auctioning",
  allPlayers: [ /* all players */ ],
  totalCards: 100,
  startTime: Date.now()
});
```

---

### AUCTION EVENTS

#### `auction:card-presented` (Server → Client, broadcast)
Emitted when a new card comes up for auction.
```javascript
// SERVER (auto-emit after previous card resolves)
io.to(roomCode).emit("auction:card-presented", {
  cardId: "card_001",
  card: {
    name: "Player Name",
    position: "ST",
    nation: "Portugal",
    stats: {
      pace: 92,
      shooting: 89,
      passing: 81,
      defense: 45,
      physical: 87,
      overall: 88
    },
    category: "Legendary",
    imageUrl: "/cards/card_001.svg"
  },
  startPrice: 25,
  timerMs: 30000, // 30 seconds
  cardNumber: 1,
  totalCards: 100,
  auctionStatus: {
    cardsAuctioned: 0,
    cardsDiscarded: 0,
    cardsSkipped: 0
  }
});
```

---

#### `auction:bid` (Client → Server)
Player places a bid on the current card.
```javascript
// CLIENT
socket.emit("auction:bid", {
  roomCode: "ABC123",
  cardId: "card_001",
  bidAmount: 50,
  userId: "player_1"
});

// SERVER VALIDATES
// 1. Player is in room and active
// 2. Player hasn't skipped this card
// 3. Bid >= current bid + minimum increment
// 4. Bid <= player balance
// 5. Card is still active
// 6. Within timer window

// If valid:
io.to(roomCode).emit("auction:bid-received", {
  cardId: "card_001",
  bidder: {
    userId: "player_1",
    username: "john_doe"
  },
  previousBid: 25,
  newBid: 50,
  bidIncrement: 25,
  timestamp: Date.now()
});

// If invalid:
socket.emit("auction:bid-error", {
  error: "INSUFFICIENT_FUNDS" | "INVALID_INCREMENT" | "PLAYER_SKIPPED" | "TIMER_EXPIRED",
  message: "Insufficient funds. Available: £750, Required: £850",
  currentBalance: 750,
  minimumBid: 55
});
```

---

#### `auction:skip` (Client → Server)
Player skips bidding on current card.
```javascript
// CLIENT
socket.emit("auction:skip", {
  roomCode: "ABC123",
  cardId: "card_001",
  userId: "player_1"
});

// SERVER VALIDATES
// - Player hasn't already bid on this card
// - Player in active state

// SERVER BROADCASTS
io.to(roomCode).emit("auction:player-skipped", {
  cardId: "card_001",
  userId: "player_1",
  username: "john_doe",
  totalSkipped: 1,
  totalPlayers: 2,
  allSkipped: false // true if all players skipped
});

// If all players skipped:
io.to(roomCode).emit("auction:card-skipped", {
  cardId: "card_001",
  cardName: "Player Name",
  reason: "ALL_PLAYERS_SKIPPED"
});
```

---

#### `auction:timer-tick` (Server → Client, broadcast)
Emitted every 1 second countdown.
```javascript
// SERVER (every 1s)
io.to(roomCode).emit("auction:timer-tick", {
  cardId: "card_001",
  remainingSeconds: 15,
  remainingMs: 15000
});

// CLIENT updates visual countdown bar
```

---

#### `auction:card-result` (Server → Client, broadcast)
Emitted when card auction resolves (timer expires or conditions met).
```javascript
// CASE 1: Card sold to highest bidder
io.to(roomCode).emit("auction:card-result", {
  cardId: "card_001",
  cardName: "Player Name",
  status: "sold",
  winner: {
    userId: "player_1",
    username: "john_doe",
    finalBid: 50
  },
  cardDetails: {
    position: "ST",
    stats: { /* ... */ }
  },
  remainingBalance: 750 // winner's balance after purchase
});

// CASE 2: No bids - card discarded
io.to(roomCode).emit("auction:card-result", {
  cardId: "card_001",
  cardName: "Player Name",
  status: "discarded",
  reason: "NO_BIDS"
});

// CASE 3: All players skipped
io.to(roomCode).emit("auction:card-result", {
  cardId: "card_001",
  cardName: "Player Name",
  status: "skipped",
  reason: "ALL_SKIPPED"
});
```

---

#### `auction:summary` (Server → Client, broadcast)
Emitted periodically or when major auction milestone reached.
```javascript
io.to(roomCode).emit("auction:summary", {
  totalCards: 100,
  cardsRemaining: 45,
  cardsAuctioned: 45,
  cardsDiscarded: 8,
  cardsSkipped: 2,
  totalBids: 120,
  players: [
    {
      userId: "player_1",
      username: "john_doe",
      balance: 750,
      cardsOwned: 3,
      totalSpent: 250,
      avgPerCard: 83.33
    }
  ]
});
```

---

#### `auction:ended` (Server → Client, broadcast)
Emitted when all cards have been processed.
```javascript
io.to(roomCode).emit("auction:ended", {
  status: "auction_complete",
  timestamp: Date.now(),
  finalStats: {
    totalBids: 120,
    cardsAuctioned: 45,
    cardsDiscarded: 8,
    cardsSkipped: 47
  },
  nextPhase: "team_review", // players can review/substitute
  teamReviewTimeMs: 30000 // 30s to make subs
});
```

---

### TEAM MANAGEMENT EVENTS

#### `team:substitute` (Client → Server)
Player can swap bench players with starting XI during review phase.
```javascript
// CLIENT
socket.emit("team:substitute", {
  roomCode: "ABC123",
  userId: "player_1",
  cardToRemove: "card_001",
  cardToAdd: "card_045"
});

// SERVER validates team has exactly 11 players
// Broadcasts update to room
io.to(roomCode).emit("team:substitution-made", {
  userId: "player_1",
  username: "john_doe",
  action: "swapped",
  removed: "card_001",
  added: "card_045"
});
```

---

#### `team:lock` (Client → Server)
Player confirms their final team.
```javascript
// CLIENT
socket.emit("team:lock", {
  roomCode: "ABC123",
  userId: "player_1"
});

// SERVER checks if player has ≥ 11 players
io.to(roomCode).emit("team:locked", {
  userId: "player_1",
  username: "john_doe",
  teamCount: 11,
  playersReady: 2,
  totalPlayers: 2,
  allReady: true // if true, start match
});

// ERROR if < 11 players
socket.emit("team:lock-error", {
  error: "INSUFFICIENT_PLAYERS",
  message: "Need 11 players, you have 8",
  playersNeeded: 3
});
```

---

### MATCH SIMULATION EVENTS

#### `match:started` (Server → Client, broadcast)
Emitted when all teams locked and match simulation begins.
```javascript
io.to(roomCode).emit("match:started", {
  matchType: "1v1", // or "tournament"
  matchups: [
    {
      matchId: "match_1",
      playerA: {
        userId: "player_1",
        username: "john_doe",
        teamRating: 85.2
      },
      playerB: {
        userId: "player_2",
        username: "jane_smith",
        teamRating: 82.5
      }
    }
  ],
  totalMatches: 1,
  timestamp: Date.now()
});
```

---

#### `match:event` (Server → Client, broadcast)
Emitted during match simulation for each major event.
```javascript
// GOAL EVENT
io.to(roomCode).emit("match:event", {
  matchId: "match_1",
  type: "goal",
  minute: 12,
  playerTeam: "player_1",
  goalScorer: "card_001",
  goalScorerName: "Player Name",
  assistance: "card_005", // optional
  scoreA: 1,
  scoreB: 0
});

// CARD EVENT
io.to(roomCode).emit("match:event", {
  matchId: "match_1",
  type: "yellow_card",
  minute: 25,
  playerTeam: "player_2",
  offendingCard: "card_010",
  offendingPlayer: "Player Name"
});

// SUBSTITUTION EVENT
io.to(roomCode).emit("match:event", {
  matchId: "match_1",
  type: "substitution",
  minute: 60,
  playerTeam: "player_1",
  playerOut: "card_003",
  playerIn: "card_040"
});
```

---

#### `match:half-time` (Server → Client, broadcast)
```javascript
io.to(roomCode).emit("match:half-time", {
  matchId: "match_1",
  scoreA: 1,
  scoreB: 1,
  possessionA: 55,
  possessionB: 45,
  shotsOnTarget: { A: 4, B: 3 }
});
```

---

#### `match:ended` (Server → Client, broadcast)
Emitted when a match concludes.
```javascript
io.to(roomCode).emit("match:ended", {
  matchId: "match_1",
  playerA: "player_1",
  playerB: "player_2",
  scoreA: 2,
  scoreB: 1,
  winner: "player_1",
  mvp: {
    cardId: "card_001",
    playerName: "Player Name",
    team: "player_1",
    performance: 8.7
  },
  stats: {
    possessionA: 58,
    possessionB: 42,
    shotsOnTarget: { A: 6, B: 4 },
    fouls: { A: 12, B: 15 }
  }
});
```

---

#### `match:all-finished` (Server → Client, broadcast)
```javascript
io.to(roomCode).emit("match:all-finished", {
  timestamp: Date.now(),
  nextPhase: "results"
});
```

---

### RESULTS & LEADERBOARD EVENTS

#### `results:leaderboard` (Server → Client, broadcast)
Final leaderboard after all matches concluded.
```javascript
io.to(roomCode).emit("results:leaderboard", {
  gameId: "GAME_20251229_ABC123",
  leaderboard: [
    {
      rank: 1,
      userId: "player_1",
      username: "john_doe",
      points: 6, // 3 for each win
      goalsFor: 4,
      goalsAgainst: 2,
      budgetRemaining: 350,
      teamRating: 85.2,
      badges: ["won", "highest_rated"]
    },
    {
      rank: 2,
      userId: "player_2",
      username: "jane_smith",
      points: 3,
      goalsFor: 3,
      goalsAgainst: 4,
      budgetRemaining: 420,
      teamRating: 82.5,
      badges: ["participated"]
    }
  ],
  gameStats: {
    duration: 1500, // seconds
    totalBids: 120,
    totalCards: 45,
    avgBidPerCard: 8.9
  }
});
```

---

#### `results:player-summary` (Server → Client, unicast)
Individual game summary sent to each player.
```javascript
socket.emit("results:player-summary", {
  gameId: "GAME_20251229_ABC123",
  userId: "player_1",
  username: "john_doe",
  
  auction: {
    cardsAcquired: 3,
    totalSpent: 650,
    budgetRemaining: 350,
    avgPerCard: 216.67
  },
  
  team: {
    players: [ /* 3 cards */ ],
    overallRating: 85.2,
    formation: "4-3-3"
  },
  
  match: {
    matchesPlayed: 1,
    matchesWon: 1,
    goalsFor: 2,
    goalsAgainst: 1,
    mvpAwards: 0
  },
  
  finalRank: 1,
  finalPoints: 6,
  badges: ["AUCTION_CHAMPION", "UNDEFEATED"],
  
  nextGameUrl: "/home" // can create new room
});
```

---

## 4. ERROR EVENT PATTERNS

All error events follow this structure:
```javascript
socket.emit("EVENT_NAME:error", {
  error: "ERROR_CODE", // uppercase, no spaces
  message: "Human-readable error message",
  details: {
    // optional details
    currentValue: 750,
    requiredValue: 850
  },
  timestamp: Date.now(),
  recoveryAction: "please_refresh" // optional guidance
});
```

**Error Codes:**
- `ROOM_NOT_FOUND` - Room doesn't exist or expired
- `ROOM_FULL` - Max 5 players reached
- `USERNAME_TAKEN` - Another player in room has this name
- `NOT_IN_ROOM` - Player not joined to room
- `NOT_CREATOR` - Only room creator can perform this
- `INVALID_INCREMENT` - Bid increment doesn't match rules
- `INSUFFICIENT_FUNDS` - Player balance < bid amount
- `PLAYER_SKIPPED` - Player already skipped this card
- `TIMER_EXPIRED` - Timer ran out, can't bid
- `INVALID_CARD` - Card ID not found
- `TEAM_INCOMPLETE` - Need 11 players to lock
- `ALREADY_LOCKED` - Can't change team after locking
- `SERVER_ERROR` - Generic server error

---

## 5. EVENT TIMING & SEQUENCING

```
Timeline for a single card auction:

T=0ms     : Card presented (auction:card-presented)
T=1000ms  : Timer tick (auction:timer-tick, remainingSeconds=29)
T=2500ms  : Player bids (auction:bid → auction:bid-received broadcast)
T=8000ms  : Timer tick (auction:timer-tick, remainingSeconds=22)
T=10000ms : Player skips (auction:player-skipped)
T=25000ms : Timer tick (auction:timer-tick, remainingSeconds=5)
T=30000ms : Timer expires, card sold (auction:card-result)
T=30100ms : Prepare next card (internal)
T=30500ms : Next card presented (auction:card-presented)

Total overhead between cards: ~500ms
```

---

## 6. SOCKET.IO ROOMS (Technical)

```javascript
// Server-side room management

io.on("connection", (socket) => {
  // User joins a game room
  socket.on("room:join", ({ roomCode, userId, username }) => {
    // Add socket to room "room_ABC123"
    socket.join(`room_${roomCode}`);
    
    // Broadcast to everyone in room
    io.to(`room_${roomCode}`).emit("room:player-joined", {...});
  });
  
  socket.on("room:leave", ({ roomCode, userId }) => {
    // Remove from room
    socket.leave(`room_${roomCode}`);
    
    // Notify remaining players
    io.to(`room_${roomCode}`).emit("room:player-left", {...});
  });
  
  // Emit to specific socket (unicast)
  socket.emit("match:event", {...});
  
  // Emit to all in room (broadcast)
  io.to(`room_${roomCode}`).emit("match:event", {...});
  
  // Emit to all except sender
  socket.broadcast.to(`room_${roomCode}`).emit("auction:bid-received", {...});
});
```

---

## 7. MESSAGE SIZE & BANDWIDTH OPTIMIZATION

| Event | Payload Size | Frequency | Total BW (2 players) |
|-------|--------------|-----------|----------------------|
| timer-tick | 50 bytes | 1/sec | 100 B/s |
| bid-received | 150 bytes | ~10/card avg | 1.5 KB/card |
| card-presented | 500 bytes | 1/card | 1 KB/card |
| match-event | 200 bytes | ~5/match | varies |
| **Total (45 cards, 1 match)** | | | ~100 KB total |

**Optimization strategies:**
- Compress large card stats objects
- Delta updates (only changed fields)
- Batch multiple events if safe
- Gzip compression on Socket.IO

