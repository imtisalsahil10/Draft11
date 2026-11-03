# Multiplayer Football Auction Game - System Architecture

## 1. ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                             │
│                    React (Vite) Frontend                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ • Auction UI (real-time updates)                         │   │
│  │ • Team Builder (player selection)                        │   │
│  │ • Leaderboard & Match Results                            │   │
│  │ • Socket.IO client for real-time events                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↕
                      Socket.IO WebSocket
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    SERVER LAYER (Node.js)                        │
│                    Express + Socket.IO                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ API Routes                                               │   │
│  │ • POST /api/rooms/create                                │   │
│  │ • POST /api/rooms/join                                  │   │
│  │ • GET /api/leaderboards                                 │   │
│  │ • GET /api/past-games                                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Socket.IO Event Handlers                                │   │
│  │ • room:join, room:start, room:leave                     │   │
│  │ • auction:bid, auction:skip, auction:timer              │   │
│  │ • match:simulate, match:results                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Game Engine (In-Memory State)                           │   │
│  │ • Room Manager (instance per room)                      │   │
│  │ • Auction Engine (turn logic, bidding)                  │   │
│  │ • Match Simulator (AI team simulation)                  │   │
│  │ • Card Deck Manager (100 custom football cards)         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↕
                      REST + MongoDB Driver
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    DATA LAYER (MongoDB)                          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Collections:                                             │   │
│  │ • players (username, email hash, stats)                 │   │
│  │ • games (completed games with results)                  │   │
│  │ • leaderboards (rating, wins, money average)            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## 2. DATA FLOW DIAGRAM

### Auction Flow:
```
Room Created
    ↓
All Players Joined
    ↓
Shuffle Cards → Start Auction
    ↓
[For each card]:
    ↓
Card Presented (30s timer starts)
    ↓
Player → Bid / Skip (Socket event)
    ↓
Server validates bid (funds check, increment check)
    ↓
Update bidder & broadcast to room
    ↓
Timer expires OR all players skipped/passed
    ↓
Card assigned to highest bidder (if any)
    ↓
Next card OR End auction
    ↓
Match Simulation (AI team vs AI team)
    ↓
Leaderboard update
    ↓
Game saved to MongoDB
```

## 3. KEY ARCHITECTURAL DECISIONS

### 3.1 Why In-Memory Game State?
- **Latency**: Real-time bidding requires <100ms response times
- **Simplicity**: No complex database queries during auction
- **Scalability**: Each room is independent, scales horizontally
- **Tradeoff**: Room data lost on server restart (acceptable for a game)
- **Mitigation**: Game results persisted to MongoDB; room state can be rebuilt

### 3.2 Room-Based Architecture
- **Isolation**: Each room has independent game state
- **Concurrency**: Multiple rooms don't interfere with each other
- **Memory**: Clean up completed rooms to prevent memory leaks
- **Socket.IO Namespaces**: Use `/rooms/:roomCode` for organized events

### 3.3 Socket.IO over REST
- **Auction**: Requires real-time, low-latency updates (Socket.IO)
- **Setup**: Room creation/joining uses REST (simpler, stateless)
- **Results**: Game results use REST (can be queried later)
- **Hybrid**: Combine both for flexibility

### 3.4 No Max Bid Cap
- **Design**: Players can outbid each other indefinitely
- **Risk**: One player empties funds early
- **Strategy**: Forces careful budget management
- **Validation**: Server checks "available funds" on each bid

### 3.5 AI-Based Simulation
- **Rationale**: Fair match simulation without real players
- **Algorithm**: Weighted random + card stats
- **Scalability**: Single match takes <1s to simulate
- **Results**: Deterministic (same cards = same win probability)

## 4. GAME STATE STRUCTURE (In-Memory)

```javascript
rooms = {
  "ABC123": {
    roomCode: "ABC123",
    createdBy: "player1",
    status: "waiting", // waiting, auctioning, finished
    maxPlayers: 5,
    players: {
      "playerId1": {
        userId: "playerId1",
        username: "john_doe",
        socketId: "socket_123",
        balance: 850,
        startBalance: 1000,
        team: [...], // 11 players max, or < 11 if auction ended
        bidsPlaced: 3,
        consecutiveSkips: 0
      }
    },
    cards: {
      "cardId_1": { name: "Player Name", position: "ST", ... },
      "cardId_2": { ... }
    },
    currentCard: {
      cardId: "cardId_1",
      startPrice: 10,
      currentBid: 45,
      currentBidder: "playerId1",
      bidHistory: [...],
      timerStart: 1234567890,
      timerEnd: 1234567920
    },
    auction: {
      cardIndex: 0,
      totalCards: 100,
      skippedPlayers: ["playerId2"], // can't bid on this card anymore
      discardedCards: 5,
      passedCards: 2
    },
    matchResults: {
      winner: "playerId1",
      scores: { "playerId1": 2, "playerId2": 1 },
      mvp: "cardId_5"
    }
  }
}
```

## 5. COMPONENT HIERARCHY (Frontend)

```
App
├── Router
│   ├── Home
│   │   ├── CreateRoom
│   │   └── JoinRoom
│   ├── GameRoom
│   │   ├── Header (room code, player count)
│   │   ├── AuctionView (active during auction)
│   │   │   ├── CardDisplay (current card + stats)
│   │   │   ├── BiddingControls (Bid / Skip buttons)
│   │   │   ├── TimerBar (30s countdown)
│   │   │   └── BidHistory (recent bids)
│   │   ├── TeamView (shows 11-player team)
│   │   │   ├── PlayerCards (draggable)
│   │   │   └── FormationDisplay
│   │   └── PlayersPanel
│   │       ├── PlayerCard (budget, team preview)
│   │       └── StatusIndicator
│   ├── MatchSimulation
│   │   ├── TeamComparison (side-by-side stats)
│   │   └── MatchPlayback (animated goals, events)
│   └── Leaderboard
│       ├── GameResults
│       ├── PlayerStats
│       └── AllTimeLeaderboard
└── Common
    ├── Modal (room join/create)
    ├── Toast (notifications)
    └── Layout
```

## 6. FOLDER STRUCTURE

```
football-auction-game/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── common/
│   │   │   │   ├── Header.tsx
│   │   │   │   ├── Modal.tsx
│   │   │   │   └── Toast.tsx
│   │   │   ├── home/
│   │   │   │   ├── CreateRoom.tsx
│   │   │   │   ├── JoinRoom.tsx
│   │   │   │   └── HomePage.tsx
│   │   │   ├── auction/
│   │   │   │   ├── CardDisplay.tsx
│   │   │   │   ├── BiddingControls.tsx
│   │   │   │   ├── TimerBar.tsx
│   │   │   │   ├── BidHistory.tsx
│   │   │   │   └── AuctionView.tsx
│   │   │   ├── team/
│   │   │   │   ├── TeamBuilder.tsx
│   │   │   │   ├── PlayerCard.tsx
│   │   │   │   ├── FormationSelector.tsx
│   │   │   │   └── TeamPreview.tsx
│   │   │   ├── match/
│   │   │   │   ├── MatchSimulation.tsx
│   │   │   │   ├── TeamComparison.tsx
│   │   │   │   ├── MatchPlayback.tsx
│   │   │   │   └── MatchResults.tsx
│   │   │   └── leaderboard/
│   │   │       ├── GameLeaderboard.tsx
│   │   │       ├── AllTimeLeaderboard.tsx
│   │   │       └── PlayerProfile.tsx
│   │   ├── pages/
│   │   │   ├── GameRoom.tsx
│   │   │   ├── Home.tsx
│   │   │   ├── Leaderboard.tsx
│   │   │   └── NotFound.tsx
│   │   ├── services/
│   │   │   ├── socket.ts (Socket.IO setup)
│   │   │   ├── api.ts (REST calls)
│   │   │   └── gameState.ts (Zustand store)
│   │   ├── hooks/
│   │   │   ├── useRoom.ts
│   │   │   ├── useAuction.ts
│   │   │   ├── useTeam.ts
│   │   │   └── useTimer.ts
│   │   ├── types/
│   │   │   ├── game.ts
│   │   │   ├── auction.ts
│   │   │   └── player.ts
│   │   ├── utils/
│   │   │   ├── validators.ts
│   │   │   ├── formatters.ts
│   │   │   └── constants.ts
│   │   ├── styles/
│   │   │   ├── global.css
│   │   │   └── theme.css
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
│
├── backend/
│   ├── src/
│   │   ├── models/
│   │   │   ├── Player.js
│   │   │   ├── Game.js
│   │   │   ├── Card.js
│   │   │   └── Leaderboard.js
│   │   ├── services/
│   │   │   ├── RoomManager.js
│   │   │   ├── AuctionEngine.js
│   │   │   ├── MatchSimulator.js
│   │   │   ├── CardDeckManager.js
│   │   │   └── LeaderboardService.js
│   │   ├── routes/
│   │   │   ├── rooms.js
│   │   │   ├── leaderboards.js
│   │   │   ├── games.js
│   │   │   └── health.js
│   │   ├── sockets/
│   │   │   ├── handlers/
│   │   │   │   ├── roomHandlers.js
│   │   │   │   ├── auctionHandlers.js
│   │   │   │   ├── matchHandlers.js
│   │   │   │   └── connectionHandlers.js
│   │   │   └── index.js
│   │   ├── middleware/
│   │   │   ├── auth.js
│   │   │   ├── errorHandler.js
│   │   │   └── logger.js
│   │   ├── utils/
│   │   │   ├── validators.js
│   │   │   ├── cardGenerator.js
│   │   │   ├── statCalculator.js
│   │   │   └── constants.js
│   │   ├── config/
│   │   │   └── database.js
│   │   ├── server.js
│   │   └── app.js
│   ├── .env.example
│   ├── package.json
│   └── README.md
│
└── shared/
    └── types/
        ├── game.ts
        ├── auction.ts
        └── player.ts
```

## 7. SOCKET.IO EVENT ARCHITECTURE

### Room Events
```
CLIENT → SERVER:
  room:create { roomCode, username }
  room:join { roomCode, username }
  room:leave { roomCode }
  room:start → (only creator can start)

SERVER → CLIENT:
  room:created { roomCode, players }
  room:player-joined { player, playerCount }
  room:player-left { playerId, playerCount }
  room:started { cardCount, allPlayers }
  room:status-update { status, currentPlayers }
```

### Auction Events
```
CLIENT → SERVER:
  auction:bid { cardId, bidAmount }
  auction:skip { cardId }

SERVER → CLIENT:
  auction:card-presented { card, startPrice, timerMs }
  auction:bid-received { bidder, newBid, previousBid }
  auction:timer-tick { remainingSeconds }
  auction:card-sold { winner, finalBid }
  auction:card-skipped { reason }
  auction:card-discarded
  auction:summary { totalCards, cardsRemaining, discardedCount }
```

### Match Events
```
CLIENT → SERVER:
  match:simulate { rooms }

SERVER → CLIENT:
  match:started { teamA, teamB }
  match:goal { team, player, minute }
  match:event { type, minute, description }
  match:ended { result, winner, mvp }
  match:results { leaderboard, allScores }
```

## 8. REAL-TIME CONSTRAINTS & OPTIMIZATION

| Component | Latency Target | Strategy |
|-----------|----------------|----------|
| Bid submission | <100ms | Direct socket emit, optimize DB later |
| Bid broadcast | <150ms | Room-wide broadcast, minimal payload |
| Timer update | 1s ticks | Batched tick events |
| Card switch | <500ms | Prep next card while current resolves |
| Match sim | <1s per match | Async calculation, return results |

## 9. ERROR HANDLING STRATEGY

```javascript
// Server-side validation layers:

1. Socket Authentication
   ├─ Player must be in room
   ├─ Socket ID must match registered player
   └─ Room must be in correct status

2. Auction Validation
   ├─ Bid amount >= minimum increment
   ├─ Bid amount <= player balance
   ├─ Player hasn't skipped this card
   ├─ Player hasn't already bid highest
   └─ Card is still active

3. Business Logic Validation
   ├─ Max 5 players per room
   ├─ Max 11 players per team
   ├─ Username uniqueness (per room)
   └─ Room code validity (4-6 alphanumeric)

4. Database Error Handling
   ├─ Retry failed writes (idempotent ops)
   ├─ Circuit breaker for DB connection
   └─ Fallback to cache if DB fails
```

## 10. SCALABILITY ROADMAP

### Phase 1 (Current)
- Single Node.js server
- In-memory game state
- SQLite/Mock DB for development

### Phase 2 (Scale)
- Redis for state persistence
- Horizontal scaling with load balancer
- Connection pooling to MongoDB

### Phase 3 (High Volume)
- Room sharding by room code hash
- Dedicated match simulation workers
- Card deck caching in Redis

