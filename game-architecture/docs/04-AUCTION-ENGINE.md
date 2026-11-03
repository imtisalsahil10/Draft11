# Auction Engine & Bidding Logic

## 1. AUCTION ENGINE OVERVIEW

The auction engine manages the lifecycle of card auctions in a room. It's stateful and runs one card at a time.

```javascript
class AuctionEngine {
  constructor(room) {
    this.room = room;
    this.currentCard = null;
    this.timerInterval = null;
    this.remainingTime = 30; // seconds
    this.bidHistory = [];
    this.playerBidStates = new Map(); // track who bid/skipped
  }

  // Main methods
  startAuction()
  presentNextCard()
  processPlayerBid(playerId, bidAmount)
  processPlayerSkip(playerId)
  resolveCard()
  handleTimerTick()
  endAuction()
}
```

---

## 2. AUCTION LIFECYCLE

### Phase 1: Initialization
```javascript
startAuction(room) {
  // Called when all players ready and game started
  
  // 1. Shuffle 100 cards
  const shuffledCards = CardDeckManager.shuffleDeck(room.playerIds);
  this.room.cardDeck = shuffledCards;
  
  // 2. Initialize tracking
  this.room.auction = {
    cardIndex: 0,
    totalCards: 100,
    cardsAuctioned: 0,
    cardsDiscarded: 0,
    cardsSkipped: 0,
    totalBids: 0
  };
  
  // 3. Present first card
  this.presentNextCard();
}
```

### Phase 2: Card Presentation
```javascript
presentNextCard() {
  // 1. Check if auction complete
  if (this.room.auction.cardIndex >= this.room.cardDeck.length) {
    this.endAuction();
    return;
  }
  
  // 2. Get next card
  const cardId = this.room.cardDeck[this.room.auction.cardIndex];
  const card = CardDeckManager.getCardById(cardId);
  
  // 3. Initialize auction state
  this.currentCard = {
    cardId: cardId,
    name: card.name,
    position: card.position,
    stats: card.stats,
    basePrice: card.basePrice,
    category: card.category,
    
    currentBid: card.basePrice,
    currentBidder: null,
    bidHistory: [],
    
    timerStart: Date.now(),
    timerEnd: Date.now() + 30000, // 30 seconds
    status: "active"
  };
  
  // 4. Reset player bid states for this card
  this.playerBidStates.clear();
  for (const playerId of this.room.players.keys()) {
    this.playerBidStates.set(playerId, {
      bid: false,
      skipped: false,
      amount: 0
    });
  }
  
  // 5. Broadcast to room
  io.to(this.room.roomCode).emit("auction:card-presented", {
    cardId: this.currentCard.cardId,
    card: {
      name: this.currentCard.name,
      position: this.currentCard.position,
      stats: this.currentCard.stats,
      category: this.currentCard.category,
      imageUrl: CardDeckManager.getImageUrl(cardId)
    },
    startPrice: this.currentCard.basePrice,
    timerMs: 30000,
    cardNumber: this.room.auction.cardIndex + 1,
    totalCards: 100
  });
  
  // 6. Start timer
  this.startTimer();
}

startTimer() {
  this.remainingTime = 30;
  
  this.timerInterval = setInterval(() => {
    this.handleTimerTick();
  }, 1000);
}

handleTimerTick() {
  this.remainingTime--;
  
  // Broadcast tick
  io.to(this.room.roomCode).emit("auction:timer-tick", {
    cardId: this.currentCard.cardId,
    remainingSeconds: this.remainingTime,
    remainingMs: this.remainingTime * 1000
  });
  
  // Check if timer expired
  if (this.remainingTime <= 0) {
    this.stopTimer();
    this.resolveCard();
  }
}

stopTimer() {
  clearInterval(this.timerInterval);
  this.timerInterval = null;
}
```

### Phase 3: Bidding
```javascript
processPlayerBid(playerId, bidAmount) {
  // VALIDATION LAYER 1: Player State
  if (!this.room.players.has(playerId)) {
    return {
      success: false,
      error: "NOT_IN_ROOM"
    };
  }
  
  const player = this.room.players.get(playerId);
  if (player.balance < bidAmount) {
    return {
      success: false,
      error: "INSUFFICIENT_FUNDS",
      currentBalance: player.balance,
      bidAmount: bidAmount
    };
  }
  
  // VALIDATION LAYER 2: Auction State
  if (!this.currentCard || this.currentCard.status !== "active") {
    return {
      success: false,
      error: "CARD_NOT_ACTIVE"
    };
  }
  
  if (this.remainingTime <= 0) {
    return {
      success: false,
      error: "TIMER_EXPIRED"
    };
  }
  
  // VALIDATION LAYER 3: Bid History
  const playerState = this.playerBidStates.get(playerId);
  if (playerState.skipped) {
    return {
      success: false,
      error: "PLAYER_SKIPPED"
    };
  }
  
  if (playerState.bid && bidAmount <= playerState.amount) {
    return {
      success: false,
      error: "MUST_INCREASE_BID",
      currentBid: playerState.amount,
      minimumIncrease: this.calculateMinimumBid(playerState.amount + 1)
    };
  }
  
  // VALIDATION LAYER 4: Bid Increment Rules
  const minimumBid = this.calculateMinimumBid(this.currentCard.currentBid);
  if (bidAmount < minimumBid) {
    return {
      success: false,
      error: "INVALID_INCREMENT",
      currentBid: this.currentCard.currentBid,
      minimumBid: minimumBid,
      requiredIncrement: this.currentCard.currentBid < 100 ? 5 : 10
    };
  }
  
  // ✓ VALID BID - Update state
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
  
  // BROADCAST to all players
  io.to(this.room.roomCode).emit("auction:bid-received", {
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
  
  return {
    success: true,
    newBid: bidAmount,
    currentHolder: playerId
  };
}

calculateMinimumBid(currentBidAmount) {
  // Rules:
  // +£5 until £100
  // +£10 above £100
  
  if (currentBidAmount < 100) {
    return currentBidAmount + 5;
  } else {
    return currentBidAmount + 10;
  }
}
```

### Phase 4: Skipping
```javascript
processPlayerSkip(playerId) {
  // VALIDATION
  if (!this.room.players.has(playerId)) {
    return { success: false, error: "NOT_IN_ROOM" };
  }
  
  const playerState = this.playerBidStates.get(playerId);
  if (playerState.skipped) {
    return { success: false, error: "ALREADY_SKIPPED" };
  }
  
  if (playerState.bid) {
    return { success: false, error: "ALREADY_BID" };
  }
  
  // MARK AS SKIPPED
  playerState.skipped = true;
  
  // BROADCAST
  io.to(this.room.roomCode).emit("auction:player-skipped", {
    cardId: this.currentCard.cardId,
    userId: playerId,
    username: this.room.players.get(playerId).username,
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
}

countSkippedPlayers() {
  let count = 0;
  for (const state of this.playerBidStates.values()) {
    if (state.skipped) count++;
  }
  return count;
}

allPlayersSkipped() {
  for (const state of this.playerBidStates.values()) {
    if (!state.skipped && !state.bid) return false;
  }
  return true;
}
```

### Phase 5: Card Resolution
```javascript
resolveCard() {
  this.currentCard.status = "resolved";
  this.room.auction.cardIndex++;
  
  let result;
  
  // CASE 1: Card sold (highest bidder exists)
  if (this.currentCard.currentBidder) {
    const winner = this.room.players.get(this.currentCard.currentBidder);
    const finalBid = this.currentCard.currentBid;
    
    // Deduct from winner's balance
    winner.balance -= finalBid;
    
    // Add card to winner's team
    const card = CardDeckManager.getCardById(this.currentCard.cardId);
    winner.team.push(card);
    
    this.room.auction.cardsAuctioned++;
    
    // Broadcast result
    io.to(this.room.roomCode).emit("auction:card-result", {
      cardId: this.currentCard.cardId,
      cardName: this.currentCard.name,
      status: "sold",
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
  }
  
  // CASE 2: No bids - card discarded
  else {
    this.room.auction.cardsDiscarded++;
    
    io.to(this.room.roomCode).emit("auction:card-result", {
      cardId: this.currentCard.cardId,
      cardName: this.currentCard.name,
      status: "discarded",
      reason: "NO_BIDS"
    });
  }
  
  // Clear current card
  this.currentCard = null;
  
  // Check if auction complete
  if (this.room.auction.cardIndex >= this.room.cardDeck.length) {
    this.endAuction();
  } else {
    // Schedule next card (0.5s delay for UX)
    setTimeout(() => {
      this.presentNextCard();
    }, 500);
  }
}
```

### Phase 6: Auction End
```javascript
endAuction() {
  this.room.status = "finished";
  
  // Validate all players have at least 11 cards
  for (const player of this.room.players.values()) {
    if (player.team.length < 11) {
      // This is OK - they can have <11 players
      // Game still proceeds
    }
  }
  
  // Emit summary
  io.to(this.room.roomCode).emit("auction:ended", {
    status: "auction_complete",
    timestamp: Date.now(),
    finalStats: {
      totalBids: this.room.auction.totalBids,
      cardsAuctioned: this.room.auction.cardsAuctioned,
      cardsDiscarded: this.room.auction.cardsDiscarded,
      cardsSkipped: this.room.cardDeck.length - this.room.auction.cardsAuctioned - this.room.auction.cardsDiscarded,
      avgBidPerCard: (
        this.room.auction.totalBids /
        (this.room.auction.cardsAuctioned || 1)
      ).toFixed(2)
    },
    nextPhase: "team_review",
    teamReviewTimeMs: 30000
  });
  
  // Wait for team confirmation, then start match
  setTimeout(() => {
    this.startMatchSimulation();
  }, 30000);
}
```

---

## 3. BID INCREMENT RULES (Detailed)

```javascript
/**
 * Bid Increment Rules:
 * - £0-£100: increment by £5 (£10, £15, £20, ... £95, £100)
 * - £100+: increment by £10 (£110, £120, £130, ...)
 * 
 * Examples:
 * - Current bid: £25 → Next minimum: £30
 * - Current bid: £95 → Next minimum: £100 (last £5 increment)
 * - Current bid: £100 → Next minimum: £110 (jump to £10 increments)
 * - Current bid: £105 → Next minimum: £115
 */

calculateMinimumBid(currentBid) {
  if (currentBid < 100) {
    // Increment by £5
    return currentBid + 5;
  } else {
    // Increment by £10
    return currentBid + 10;
  }
}

/**
 * Validate bid against minimum
 * Returns { valid: boolean, error?: string }
 */
validateBidIncrement(currentBid, proposedBid) {
  const minimumBid = this.calculateMinimumBid(currentBid);
  
  if (proposedBid < minimumBid) {
    return {
      valid: false,
      error: "INVALID_INCREMENT",
      currentBid,
      proposedBid,
      minimumBid,
      required: currentBid < 100 ? 5 : 10
    };
  }
  
  return { valid: true };
}

/**
 * Suggested bid amounts for UI
 * Shows next valid bid and few alternatives
 */
suggestedBids(currentBid, playerBalance) {
  const minimum = this.calculateMinimumBid(currentBid);
  const step = currentBid < 100 ? 5 : 10;
  
  const suggestions = [
    minimum,
    minimum + step,
    minimum + step * 2,
    minimum + step * 3
  ].filter(bid => bid <= playerBalance);
  
  return suggestions;
}
```

---

## 4. EDGE CASES & CONFLICT RESOLUTION

### Edge Case 1: Simultaneous Bids
```javascript
/**
 * If two bids arrive within 50ms of each other,
 * server processes them sequentially by received order
 * Later bid must beat the earlier bid
 */

// Server receives:
// T=1000ms: Player A bids £30
// T=1001ms: Player B bids £40

// Processing:
// 1. A's £30 accepted (minimum £30, valid)
// 2. Current bid = £30, bidder = A
// 3. B's £40 arrives (minimum £35, £40 > £35, valid)
// 4. Current bid = £40, bidder = B
```

### Edge Case 2: Bid After Timer Expires
```javascript
/**
 * Client-side timer expires, but bid arrives before
 * server-side timer expires. Accept or reject?
 * 
 * RULE: Server-side is authoritative. If server timer
 * hasn't expired, accept bid regardless of client state.
 */

processPlayerBid(playerId, bidAmount) {
  // This check uses SERVER time only
  if (this.remainingTime <= 0) {
    return {
      success: false,
      error: "TIMER_EXPIRED_SERVER"
    };
  }
  // ... proceed with bid validation
}
```

### Edge Case 3: Player Disconnects Mid-Auction
```javascript
/**
 * If a player disconnects during auction:
 * 1. They cannot receive or place new bids
 * 2. Existing bids stand
 * 3. They cannot win cards after disconnect
 * 4. If they reconnect, they rejoin but cannot bid on current card
 */

socket.on("disconnect", () => {
  const { roomCode, playerId } = socket.data;
  
  if (roomCode && playerId) {
    const room = RoomManager.getRoom(roomCode);
    const player = room.players.get(playerId);
    
    if (player) {
      player.socketId = null; // mark as offline
      player.status = "offline";
      
      // Broadcast disconnect notice
      io.to(roomCode).emit("room:player-offline", {
        userId: playerId,
        username: player.username
      });
      
      // If they were highest bidder on current card,
      // their bid still stands but they can't increase it
    }
  }
});

socket.on("reconnect", () => {
  // Player can rejoin, but miss any cards auctioned while away
  // Existing bids and purchases preserved
});
```

### Edge Case 4: Player Runs Out of Funds
```javascript
/**
 * If a player's balance reaches £0:
 * - They can still bid (server blocks it)
 * - They can still skip
 * - Other players continue normally
 */

if (player.balance < bidAmount) {
  socket.emit("auction:bid-error", {
    error: "INSUFFICIENT_FUNDS",
    message: `Need £${bidAmount}, you have £${player.balance}`,
    currentBalance: player.balance,
    bidAmount: bidAmount
  });
}
```

### Edge Case 5: All Players Skip (Card Discarded)
```javascript
/**
 * When all players skip a card:
 * 1. No one can bid further
 * 2. Card is discarded (removed from play)
 * 3. Move immediately to next card
 */

if (this.allPlayersSkipped()) {
  this.stopTimer();
  this.room.auction.cardsDiscarded++;
  
  io.to(this.room.roomCode).emit("auction:card-result", {
    cardId: this.currentCard.cardId,
    status: "discarded",
    reason: "ALL_PLAYERS_SKIPPED"
  });
  
  this.currentCard = null;
  
  // Continue to next card after 300ms
  setTimeout(() => this.presentNextCard(), 300);
}
```

---

## 5. PERFORMANCE OPTIMIZATIONS

```javascript
class AuctionEngineOptimized extends AuctionEngine {
  constructor(room) {
    super(room);
    
    // Pre-calculate next card
    this.nextCardBuffer = null;
  }
  
  presentNextCard() {
    // If we have a buffered card, use it
    if (this.nextCardBuffer) {
      this.currentCard = this.nextCardBuffer;
      this.nextCardBuffer = null;
    } else {
      // Fetch and initialize
      this.currentCard = this.createCardAuction();
    }
    
    // Start buffering next card asynchronously
    setImmediate(() => {
      this.nextCardBuffer = this.createCardAuction();
    });
    
    // Broadcast...
  }
  
  // Batch update bidStates instead of Map operations
  resetBidStatesForCard() {
    const playerIds = Array.from(this.room.players.keys());
    this.bidStates = Object.fromEntries(
      playerIds.map(id => [id, { bid: false, skipped: false, amount: 0 }])
    );
  }
}
```

---

## 6. TESTING SCENARIOS

| Scenario | Expected | Implementation |
|----------|----------|-----------------|
| Happy path: 2 players, 1 card | A bids £30, B bids £35, A outbid | ✓ |
| All skip | Card discarded, next card | ✓ |
| No bids | Card discarded, next card | ✓ |
| Budget exceeded | Bid rejected | ✓ |
| Invalid increment (£30 → £31) | Rejected, need £35 | ✓ |
| Simultaneous bids | First received, then second | ✓ |
| Bid after disconnect | If offline, can't bid | ✓ |
| Skip after bid | Rejected (already bid) | ✓ |

