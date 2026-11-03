# PHASE 1 QUICK START

## 🚀 Get Running in 5 Minutes

### Prerequisites
- Node.js 18+ installed
- npm installed
- cards.json in `d:\Draft11\`

### Step 1: Install Backend

```powershell
cd d:\Draft11\backend
npm install
```

Expected time: ~2-3 minutes

### Step 2: Install Frontend

```powershell
cd d:\Draft11\frontend
npm install
```

Expected time: ~2-3 minutes

### Step 3: Start Backend (Terminal 1)

```powershell
cd d:\Draft11\backend
npm start
```

Expected output:
```
🎮 Football Auction Game Server running on port 3000
📡 Socket.IO ready at http://localhost:3000
```

### Step 4: Start Frontend (Terminal 2)

```powershell
cd d:\Draft11\frontend
npm run dev
```

Expected output:
```
VITE v5.x.x ready in XXX ms

➜  Local:   http://localhost:5173/
➜  press h to show help
```

### Step 5: Open Browser

Navigate to: **http://localhost:5173**

You should see the home page with:
- ⚽ Football Auction title
- Username input field
- "Create Room" button
- "Join Room" option

---

## 🎮 Test the Game

### Create a Game
1. Enter username: "Player1"
2. Click "✨ Create Room"
3. You'll be taken to room page with a 6-digit room code
4. Copy the room code

### Join Same Game
1. Open new browser tab (or use incognito)
2. Go to http://localhost:5173
3. Enter username: "Player2"
4. Enter the room code from step 3
5. Click "🎮 Join Room"
6. You should see both players in the room

### Start Auction
1. In original tab, click "▶️ Start Auction"
2. Both players should see a football card
3. First card is displayed with all stats
4. Minimum bid shown
5. Enter bid amount and click "💰 Place Bid"
6. Other player can bid or skip

---

## 📁 Key Files to Know

### Backend
- **server.js** - Main server, all Socket.IO events
- **constants.js** - Game configuration
- **validators.js** - Input validation
- **auction-engine.js** - Bidding logic
- **.env** - Configuration (PORT, MongoDB URL)

### Frontend
- **App.jsx** - Main app component
- **gameStore.js** - Zustand state store
- **HomePage.jsx** - Create/join room
- **RoomPage.jsx** - Waiting room
- **AuctionPage.jsx** - Main game (bidding)
- **.env** - API URLs

### Data
- **cards.json** - Generated FIFA catalog (overall 85+, five leagues)
- **data/imports/fifa.csv** - Source file for `npm run import:players`

---

## ✅ WHAT'S WORKING

- ✅ Create room (generates 6-digit code)
- ✅ Join room (with code)
- ✅ Multiple players in same room
- ✅ Display cards with stats
- ✅ Bid on cards
- ✅ Skip cards
- ✅ Track balance
- ✅ Show all players
- ✅ Timer countdown
- ✅ Real-time Socket.IO events

---

## ⚠️ KNOWN LIMITATIONS (Phase 1)

- ❌ No MongoDB - data not persisted
- ❌ No team building UI - just card counting
- ❌ No match simulation - winner not determined
- ❌ No leaderboard - results not stored
- ❌ Limited error handling
- ❌ No reconnection after disconnect
- ❌ No duplicate card filtering
- ❌ No position validation

These will be added in Phase 2+

---

## 🐛 TROUBLESHOOTING

### Port Already in Use

If port 3000 or 5173 is in use:

Backend:
```powershell
# Check what's using port 3000
netstat -ano | findstr :3000

# Kill the process (if needed)
taskkill /PID <PID> /F

# Or change port in .env
# Change PORT=3000 to PORT=3001
```

Frontend:
```powershell
# Vite will auto-use next available port
# Or change vite.config.ts:
# port: 5174
```

### MongoDB Connection Error

Backend shows MongoDB error - this is OK for Phase 1.
Cards are loaded from cards.json, not database.

Fix: Edit `.env` and comment out if needed:
```
# MONGODB_URI=mongodb://localhost:27017/football-auction
```

### Socket Connection Failed

If frontend can't connect to backend:
1. Make sure backend is running on port 3000
2. Check VITE_SOCKET_IO_URL in frontend/.env
3. Should be: `http://localhost:3000`
4. Clear browser cache and reload

### Cards Not Loading

If no cards appear in auction:
1. Check cards.json exists in `d:\Draft11\`
2. Regenerate it with `npm run import:players` if it is missing
3. Check server logs for errors

---

## 📊 TESTING CHECKLIST

After running Phase 1:

- [ ] Backend starts without errors
- [ ] Frontend loads at http://localhost:5173
- [ ] Can create room with username
- [ ] Room code displayed and shareable
- [ ] Can join room with code
- [ ] Multiple players appear in room
- [ ] Can start auction
- [ ] Card displays with stats
- [ ] Can place bid
- [ ] Can skip card
- [ ] Timer counts down
- [ ] Balance updates
- [ ] Player list shows all players
- [ ] Next card appears after resolve

---

## 🎯 NEXT PHASES

**Phase 2:** MongoDB integration
- Persist game data
- Store results
- Build leaderboard

**Phase 3:** Team building
- Validate team composition
- Save teams
- Match simulation

**Phase 4:** Polish & Deploy
- Error handling
- Reconnection
- Security
- Performance

---

## 💬 READY?

Run these commands:

```powershell
# Terminal 1
cd d:\Draft11\backend && npm install && npm start

# Terminal 2
cd d:\Draft11\frontend && npm install && npm run dev
```

Then open http://localhost:5173 🎮

Enjoy! ⚽
