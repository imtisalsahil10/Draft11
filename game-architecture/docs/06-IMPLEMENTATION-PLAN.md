# Implementation Roadmap & Step-by-Step Plan

## PHASE 1: PROJECT SETUP (Week 1, Days 1-2)

### Step 1.1: Initialize Repositories
```bash
# Create project structure
mkdir football-auction-game
cd football-auction-game

# Frontend setup
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
npm install socket.io-client zustand axios
npm install -D tailwindcss postcss autoprefixer
cd ..

# Backend setup
mkdir backend
cd backend
npm init -y
npm install express socket.io mongoose dotenv cors
npm install -D nodemon @types/node
cd ..

# Create shared types directory
mkdir shared/types
```

### Step 1.2: Configure Environment
**backend/.env**
```env
PORT=3001
MONGODB_URI=mongodb://localhost:27017/football-auction
NODE_ENV=development
SOCKET_IO_CORS=http://localhost:5173
```

**frontend/.env**
```env
VITE_API_URL=http://localhost:3001
VITE_SOCKET_URL=http://localhost:3001
```

### Step 1.3: Setup Git & Version Control
```bash
git init
git add .
git commit -m "Initial project setup"
```

---

## PHASE 2: BACKEND CORE (Week 1, Days 3-5)

### Step 2.1: Express Server & Socket.IO Setup
**backend/src/server.js**
- Initialize Express app
- Configure CORS
- Setup Socket.IO with namespace routing
- Error handling middleware

**Deliverable**: Server runs on localhost:3001, Socket.IO accepts connections

### Step 2.2: MongoDB Connection & Models
**backend/src/config/database.js**
- Connect to MongoDB
- Test connection

**backend/src/models/Player.js**
- Define Player schema
- Create indexes

**backend/src/models/Game.js**
- Define Game schema
- Relationships to Player

**backend/src/models/Card.js**
- Define Card schema (100 cards)
- Seed database

**Deliverable**: 100 custom cards in database, Player & Game records can be created

### Step 2.3: Room Manager Service
**backend/src/services/RoomManager.js**
- Create room in-memory storage (Map)
- `createRoom(roomCode, createdBy)`
- `joinRoom(roomCode, userId, username)`
- `leaveRoom(roomCode, userId)`
- `getRoom(roomCode)`
- `deleteRoom(roomCode)`

**Deliverable**: Rooms can be created/joined/left; validated max 5 players

### Step 2.4: Card Deck Manager
**backend/src/services/CardDeckManager.js**
- `shuffleDeck()` - Randomize 100 cards
- `getCardById(cardId)` - Retrieve card details
- `getCardStats(cardId)` - Calculate ratings

**Deliverable**: Deck shuffles, cards retrievable by ID

### Step 2.5: Auction Engine (Core Logic)
**backend/src/services/AuctionEngine.js**
- `startAuction(room)`
- `presentNextCard()`
- `processPlayerBid(playerId, bidAmount)` - Validation + execution
- `processPlayerSkip(playerId)`
- `resolveCard()`
- `endAuction()`
- `calculateMinimumBid(currentBid)`

**Deliverable**: Full auction lifecycle works; bids validated; cards assigned

### Step 2.6: REST API Routes
**backend/src/routes/rooms.js**
- `POST /api/rooms/create`
- `POST /api/rooms/join`
- `POST /api/rooms/start`
- `GET /api/rooms/:roomCode`

**backend/src/routes/games.js**
- `GET /api/games/:gameId`
- `POST /api/games` (save completed game)

**backend/src/routes/leaderboards.js**
- `GET /api/leaderboards`
- `GET /api/leaderboards/:userId`

**Deliverable**: All REST endpoints return correct responses

---

## PHASE 3: SOCKET.IO EVENT HANDLERS (Week 2, Days 1-3)

### Step 3.1: Connection & Room Events
**backend/src/sockets/handlers/connectionHandlers.js**
- `socket.on("connection")`
- `socket.on("disconnect")`
- `socket.on("error")`

**backend/src/sockets/handlers/roomHandlers.js**
- `socket.on("room:join")`
- `socket.on("room:leave")`
- `socket.on("room:start")`
- `socket.on("room:status")`

**Deliverable**: Players join rooms via WebSocket; broadcasts work

### Step 3.2: Auction Events
**backend/src/sockets/handlers/auctionHandlers.js**
- `socket.on("auction:bid")`
- `socket.on("auction:skip")`
- Auto-emit: `auction:card-presented`
- Auto-emit: `auction:timer-tick` (every 1s)
- Auto-emit: `auction:card-result`

**Deliverable**: Full auction flow works; client receives all events

### Step 3.3: Match Events
**backend/src/sockets/handlers/matchHandlers.js**
- `socket.on("team:lock")`
- Auto-emit: `match:started`
- Auto-emit: `match:event` (goals, cards, etc.)
- Auto-emit: `match:ended`
- Auto-emit: `results:leaderboard`

**Deliverable**: Match simulation runs; results sent to clients

---

## PHASE 4: MATCH SIMULATOR (Week 2, Days 4-5)

### Step 4.1: Team Rating Calculator
**backend/src/services/MatchSimulator.js**
- `calculateTeamStats(team)` - Average card stats
- `calculateWinProbability(teamA, teamB)` - Elo-based odds

**Deliverable**: Team ratings calculated correctly

### Step 4.2: Match Simulation Engine
**backend/src/utils/SeededRandom.js**
- Implement SeededRandom class for deterministic RNG

**backend/src/services/MatchSimulator.js (continued)**
- `simulateSingleMatch(teamA, teamB, seed)` - 90-min simulation
- `simulateMinute(minute, matchState)` - Generate events
- `processShot(team, matchState)` - Goal probabilities
- `calculateMVP(matchState)` - Find MVP

**Deliverable**: Matches simulate; scores depend on team ratings

### Step 4.3: Tournament Simulation
**backend/src/services/MatchSimulator.js (continued)**
- `simulateTournament(playerTeams)` - Round-robin for 3+ players
- Standings calculation (points, goal diff)
- Final leaderboard ranking

**Deliverable**: 3-5 player tournaments complete; standings correct

---

## PHASE 5: FRONTEND - HOME & ROOM SETUP (Week 3, Days 1-2)

### Step 5.1: Project Structure & Styling
**frontend/src/**
- Setup Tailwind CSS
- Create component directory structure
- Setup Zustand store (gameState.ts)
- Setup Socket.IO client (services/socket.ts)

### Step 5.2: Home Page
**frontend/src/pages/Home.tsx**
**frontend/src/components/home/CreateRoom.tsx**
- Form: room code input, username input
- Submit: calls REST API `/api/rooms/create`
- On success: navigate to GameRoom with room code

**frontend/src/components/home/JoinRoom.tsx**
- Form: room code input, username input
- Submit: calls REST API `/api/rooms/join`
- Validation: room exists, not full, username unique
- On success: navigate to GameRoom

**Deliverable**: Create/join room forms work; navigation correct

### Step 5.3: Game Room Layout
**frontend/src/pages/GameRoom.tsx**
**frontend/src/components/GameRoom/Header.tsx**
- Display room code
- Display player count
- Display current player balance
- Leave room button

**frontend/src/components/GameRoom/PlayersPanel.tsx**
- List all players in room
- Show username, balance, cards count
- Indicate ready status

**Deliverable**: Room UI shows players and status

---

## PHASE 6: FRONTEND - AUCTION UI (Week 3, Days 3-5)

### Step 6.1: Auction View
**frontend/src/pages/GameRoom/AuctionView.tsx**

### Step 6.2: Card Display Component
**frontend/src/components/auction/CardDisplay.tsx**
- Show card image (SVG placeholder)
- Display: Name, Position, Stats (pace, shooting, etc.)
- Display: Current bid, current bidder

### Step 6.3: Bidding Controls
**frontend/src/components/auction/BiddingControls.tsx**
- Button: "Skip" (if not bid yet)
- Input: Bid amount (with suggested amounts)
- Button: "Place Bid"
- Validation: Can't exceed balance, must meet increment

### Step 6.4: Timer Bar
**frontend/src/components/auction/TimerBar.tsx**
- Visual countdown (30s → 0s)
- Color change: green → yellow → red
- Disable controls at 0s

### Step 6.5: Bid History
**frontend/src/components/auction/BidHistory.tsx**
- Show recent bids (last 5)
- Format: "Player Name: £50"
- Update in real-time via Socket.IO

**Deliverable**: Full auction UI functional; can place bids

---

## PHASE 7: FRONTEND - TEAM BUILDER (Week 4, Days 1-2)

### Step 7.1: Team Review Screen
**frontend/src/components/team/TeamView.tsx**
- Show all acquired cards (max 11)
- Show team overall rating
- Lock button to confirm team

### Step 7.2: Player Card Component
**frontend/src/components/team/PlayerCard.tsx**
- Card image + stats display
- Draggable (for future substitution feature)
- Position indicator (ST, CM, etc.)

### Step 7.3: Formation Display
**frontend/src/components/team/FormationSelector.tsx** (optional)
- Show 4-3-3 formation visual
- Allow drag-and-drop positioning

**Deliverable**: Team viewer shows 11 cards; can lock team

---

## PHASE 8: FRONTEND - MATCH & RESULTS (Week 4, Days 3-5)

### Step 8.1: Match Simulation View
**frontend/src/components/match/MatchSimulation.tsx**
- Show team A vs team B
- Live event display (goals, cards, etc.)
- Score update

### Step 8.2: Match Results
**frontend/src/components/match/MatchResults.tsx**
- Final score
- MVP display
- Player stats comparison

### Step 8.3: Leaderboard
**frontend/src/pages/Leaderboard.tsx**
**frontend/src/components/leaderboard/GameLeaderboard.tsx**
- Rank, player, points, score, budget remaining
- Badges (UNDEFEATED, HIGHEST_RATED, etc.)

**Deliverable**: Match results display correctly; leaderboard shows rankings

---

## PHASE 9: DATABASE PERSISTENCE (Week 4, Days 4-5)

### Step 9.1: Save Game to MongoDB
**backend/src/services/GameService.js**
- `saveGameResult(roomCode, leaderboard, matchResults)`
- Create Game document with all player data

**Deliverable**: Completed games saved to DB

### Step 9.2: Leaderboard Aggregation
**backend/src/services/LeaderboardService.js**
- `updateLeaderboards(gameResult)`
- Update Player stats
- Create/update Leaderboard entries

**Deliverable**: All-time leaderboard queryable

### Step 9.3: Past Games API
**backend/src/routes/games.js**
- `GET /api/games?userId=...` - Get player's past games
- `GET /api/games/:gameId` - Get specific game details

**Deliverable**: Can retrieve and view past games

---

## PHASE 10: TESTING & POLISH (Week 5, Days 1-3)

### Step 10.1: Unit Tests
- AuctionEngine logic (bid validation, increment rules)
- MatchSimulator (team ratings, win probability)
- CardDeckManager (shuffling, stats)

### Step 10.2: Integration Tests
- REST API responses
- Socket.IO event flow
- Database persistence

### Step 10.3: E2E Tests
- Full game: create room → auction → match → results
- Multi-player scenarios
- Error conditions

### Step 10.4: Polish
- Error messages user-friendly
- Loading states on UI
- Toast notifications for important events
- Mobile-responsive design

**Deliverable**: Game playable end-to-end; no critical bugs

---

## PHASE 11: DEPLOYMENT (Week 5, Days 4-5)

### Step 11.1: Production Build
```bash
# Frontend
cd frontend
npm run build

# Backend: Set NODE_ENV=production
# Update .env for production URLs
```

### Step 11.2: Deployment Options
- **Frontend**: Vercel, Netlify
- **Backend**: Railway, Heroku, DigitalOcean
- **Database**: MongoDB Atlas

### Step 11.3: Environment Variables
- Database: production URI
- CORS origins: production URLs
- Socket.IO: production domain

**Deliverable**: Game live and playable

---

## IMPLEMENTATION CHECKLIST

```markdown
## Phase 1: Setup
- [ ] Frontend Vite project created
- [ ] Backend Express project created
- [ ] .env files configured
- [ ] MongoDB connection established

## Phase 2: Backend Core
- [ ] Express server running
- [ ] MongoDB models created
- [ ] 100 cards seeded
- [ ] Room manager implemented
- [ ] Card deck manager implemented

## Phase 3: Auction Engine
- [ ] AuctionEngine class complete
- [ ] Bid validation logic
- [ ] Timer mechanism
- [ ] Card resolution
- [ ] Socket.IO emitters

## Phase 4: Match Simulator
- [ ] Team rating calculator
- [ ] Single match simulation
- [ ] Tournament simulation
- [ ] Seeded RNG
- [ ] MVP calculation

## Phase 5-8: Frontend Components
- [ ] Home page (create/join)
- [ ] Game room layout
- [ ] Auction UI (card, bidding, timer)
- [ ] Team builder
- [ ] Match results
- [ ] Leaderboard

## Phase 9: Database
- [ ] Game results saved
- [ ] Leaderboard updated
- [ ] Past games queryable

## Phase 10: Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] E2E tests pass
- [ ] No console errors

## Phase 11: Deployment
- [ ] Frontend deployed
- [ ] Backend deployed
- [ ] Database live
- [ ] Production testing complete
```

---

## ESTIMATION

| Phase | Days | Total |
|-------|------|-------|
| Setup | 2 | 2 |
| Backend Core | 3 | 5 |
| Socket.IO | 3 | 8 |
| Match Sim | 2 | 10 |
| Frontend Home/Room | 2 | 12 |
| Frontend Auction | 3 | 15 |
| Frontend Team | 2 | 17 |
| Frontend Match | 3 | 20 |
| Persistence | 2 | 22 |
| Testing/Polish | 3 | 25 |
| Deployment | 2 | 27 |

**Total: ~27-30 days (5-6 weeks) for a single developer**

---

## CRITICAL PATH (Minimum Viable Game)

To play a complete game quickly:
1. Backend: Express + Socket.IO + Room Manager (2 days)
2. Auction Engine (2 days)
3. Match Simulator (1 day)
4. Frontend: Basic Home + Auction + Results (2 days)

**Minimum: 7 days for playable MVP**

Then add:
- Team builder UI
- Leaderboard
- Database persistence
- Polish & testing

