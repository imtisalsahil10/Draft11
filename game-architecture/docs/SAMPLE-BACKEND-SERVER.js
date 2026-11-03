// Backend: server.js - Express + Socket.IO Setup
// This is the entry point that initializes the entire server

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

// Import services
const RoomManager = require('./services/RoomManager');
const AuctionEngine = require('./services/AuctionEngine');
const MatchSimulator = require('./services/MatchSimulator');

// Initialize Express
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with CORS
const io = socketIo(server, {
  cors: {
    origin: process.env.SOCKET_IO_CORS || 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    timestamp: new Date().toISOString()
  });
});

// Health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Import routes
const roomRoutes = require('./routes/rooms');
const gameRoutes = require('./routes/games');
const leaderboardRoutes = require('./routes/leaderboards');

app.use('/api/rooms', roomRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/leaderboards', leaderboardRoutes);

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================

// Connection handler
io.on('connection', (socket) => {
  console.log(`[Socket] Player connected: ${socket.id}`);

  // Store socket metadata
  socket.data.socketId = socket.id;

  // ========== ROOM EVENTS ==========
  socket.on('room:join', async (data) => {
    try {
      const { roomCode, userId, username } = data;
      
      // Validate input
      if (!roomCode || !userId || !username) {
        socket.emit('room:join-error', {
          error: 'INVALID_INPUT',
          message: 'roomCode, userId, and username required'
        });
        return;
      }

      // Get or create room
      let room = RoomManager.getRoom(roomCode);
      if (!room) {
        socket.emit('room:join-error', {
          error: 'ROOM_NOT_FOUND',
          message: `Room ${roomCode} does not exist`
        });
        return;
      }

      // Check max players
      if (room.players.size >= room.maxPlayers) {
        socket.emit('room:join-error', {
          error: 'ROOM_FULL',
          message: 'This room is full (max 5 players)'
        });
        return;
      }

      // Check username uniqueness
      for (const player of room.players.values()) {
        if (player.username === username) {
          socket.emit('room:join-error', {
            error: 'USERNAME_TAKEN',
            message: `Username '${username}' is already taken in this room`
          });
          return;
        }
      }

      // Join room
      socket.join(`room_${roomCode}`);
      socket.data.roomCode = roomCode;
      socket.data.userId = userId;

      // Create player object
      const player = {
        userId,
        username,
        socketId: socket.id,
        balance: 1000,
        startBalance: 1000,
        team: [],
        status: 'waiting'
      };

      room.players.set(userId, player);

      // Broadcast to all players in room
      io.to(`room_${roomCode}`).emit('room:player-joined', {
        player,
        totalPlayers: room.players.size,
        players: Array.from(room.players.values()).map(p => ({
          userId: p.userId,
          username: p.username,
          balance: p.balance,
          cardsOwned: p.team.length,
          status: p.status
        }))
      });

      console.log(`[Room] ${username} joined ${roomCode} (${room.players.size}/${room.maxPlayers})`);
    } catch (error) {
      console.error('[Socket Error] room:join:', error);
      socket.emit('room:join-error', {
        error: 'SERVER_ERROR',
        message: error.message
      });
    }
  });

  socket.on('room:leave', (data) => {
    try {
      const { roomCode, userId } = data;
      const room = RoomManager.getRoom(roomCode);

      if (!room) return;

      const player = room.players.get(userId);
      if (player) {
        room.players.delete(userId);

        // Broadcast departure
        io.to(`room_${roomCode}`).emit('room:player-left', {
          userId,
          username: player.username,
          totalPlayers: room.players.size,
          players: Array.from(room.players.values()).map(p => ({
            userId: p.userId,
            username: p.username,
            balance: p.balance
          }))
        });

        // Delete room if empty
        if (room.players.size === 0) {
          RoomManager.deleteRoom(roomCode);
          console.log(`[Room] ${roomCode} deleted (empty)`);
        }

        console.log(`[Room] ${player.username} left ${roomCode}`);
      }

      socket.leave(`room_${roomCode}`);
    } catch (error) {
      console.error('[Socket Error] room:leave:', error);
    }
  });

  socket.on('room:start', async (data) => {
    try {
      const { roomCode } = data;
      const room = RoomManager.getRoom(roomCode);

      if (!room) {
        socket.emit('room:start-error', {
          error: 'ROOM_NOT_FOUND',
          message: 'Room does not exist'
        });
        return;
      }

      // Only creator can start
      if (room.createdBy !== socket.data.userId) {
        socket.emit('room:start-error', {
          error: 'NOT_CREATOR',
          message: 'Only the room creator can start the game'
        });
        return;
      }

      // Need at least 2 players
      if (room.players.size < 2) {
        socket.emit('room:start-error', {
          error: 'INSUFFICIENT_PLAYERS',
          message: 'Need at least 2 players to start'
        });
        return;
      }

      room.status = 'auctioning';
      room.startedAt = Date.now();

      // Initialize auction engine
      const auctionEngine = new AuctionEngine(room, io);
      room.auctionEngine = auctionEngine;

      // Broadcast game started
      io.to(`room_${roomCode}`).emit('room:started', {
        status: 'auctioning',
        allPlayers: Array.from(room.players.values()),
        totalCards: 100,
        startTime: room.startedAt
      });

      // Start auction
      auctionEngine.startAuction();

      console.log(`[Game] ${roomCode} started with ${room.players.size} players`);
    } catch (error) {
      console.error('[Socket Error] room:start:', error);
      socket.emit('room:start-error', {
        error: 'SERVER_ERROR',
        message: error.message
      });
    }
  });

  // ========== AUCTION EVENTS ==========
  socket.on('auction:bid', (data) => {
    try {
      const { roomCode, cardId, bidAmount } = data;
      const room = RoomManager.getRoom(roomCode);

      if (!room || !room.auctionEngine) {
        socket.emit('auction:bid-error', {
          error: 'INVALID_STATE',
          message: 'Auction not in progress'
        });
        return;
      }

      const result = room.auctionEngine.processPlayerBid(
        socket.data.userId,
        bidAmount
      );

      if (!result.success) {
        socket.emit('auction:bid-error', result);
      }
      // Success broadcast handled by AuctionEngine
    } catch (error) {
      console.error('[Socket Error] auction:bid:', error);
      socket.emit('auction:bid-error', {
        error: 'SERVER_ERROR',
        message: error.message
      });
    }
  });

  socket.on('auction:skip', (data) => {
    try {
      const { roomCode, cardId } = data;
      const room = RoomManager.getRoom(roomCode);

      if (!room || !room.auctionEngine) {
        socket.emit('auction:skip-error', {
          error: 'INVALID_STATE',
          message: 'Auction not in progress'
        });
        return;
      }

      const result = room.auctionEngine.processPlayerSkip(socket.data.userId);

      if (!result.success) {
        socket.emit('auction:skip-error', result);
      }
      // Success broadcast handled by AuctionEngine
    } catch (error) {
      console.error('[Socket Error] auction:skip:', error);
      socket.emit('auction:skip-error', {
        error: 'SERVER_ERROR',
        message: error.message
      });
    }
  });

  // ========== TEAM EVENTS ==========
  socket.on('team:lock', (data) => {
    try {
      const { roomCode } = data;
      const room = RoomManager.getRoom(roomCode);

      if (!room) {
        socket.emit('team:lock-error', {
          error: 'ROOM_NOT_FOUND',
          message: 'Room does not exist'
        });
        return;
      }

      const player = room.players.get(socket.data.userId);

      if (!player) {
        socket.emit('team:lock-error', {
          error: 'NOT_IN_ROOM',
          message: 'You are not in this room'
        });
        return;
      }

      // Need at least 11 players
      if (player.team.length < 11) {
        socket.emit('team:lock-error', {
          error: 'INSUFFICIENT_PLAYERS',
          message: `You need 11 players, you have ${player.team.length}`
        });
        return;
      }

      player.status = 'ready';

      // Check if all players are ready
      let allReady = true;
      for (const p of room.players.values()) {
        if (p.status !== 'ready') {
          allReady = false;
          break;
        }
      }

      io.to(`room_${roomCode}`).emit('team:locked', {
        userId: socket.data.userId,
        username: player.username,
        teamCount: player.team.length,
        allReady
      });

      // If all ready, start match simulation
      if (allReady) {
        room.status = 'matching';
        startMatchSimulation(room);
      }
    } catch (error) {
      console.error('[Socket Error] team:lock:', error);
      socket.emit('team:lock-error', {
        error: 'SERVER_ERROR',
        message: error.message
      });
    }
  });

  // ========== DISCONNECT ==========
  socket.on('disconnect', () => {
    try {
      const { roomCode, userId } = socket.data;
      if (roomCode && userId) {
        const room = RoomManager.getRoom(roomCode);
        if (room) {
          const player = room.players.get(userId);
          if (player) {
            player.socketId = null; // Mark as offline
            player.status = 'offline';

            io.to(`room_${roomCode}`).emit('room:player-offline', {
              userId,
              username: player.username,
              totalPlayers: room.players.size
            });
          }
        }
      }
      console.log(`[Socket] Player disconnected: ${socket.id}`);
    } catch (error) {
      console.error('[Socket Error] disconnect:', error);
    }
  });
});

// ============================================
// MATCH SIMULATION HELPER
// ============================================

function startMatchSimulation(room) {
  try {
    const matchSim = new MatchSimulator();
    const playerTeams = {};
    const playerIds = [];

    // Gather teams
    for (const [userId, player] of room.players.entries()) {
      playerTeams[userId] = player.team;
      playerIds.push(userId);
    }

    // Determine match type
    const matchType = playerIds.length === 2 ? '1v1' : 'tournament';

    io.to(`room_${room.roomCode}`).emit('match:started', {
      matchType,
      timestamp: Date.now()
    });

    // Simulate
    let result;
    if (matchType === '1v1') {
      result = matchSim.simulateSingleMatch(
        playerTeams[playerIds[0]],
        playerTeams[playerIds[1]]
      );

      // Emit events
      for (const event of result.events) {
        io.to(`room_${room.roomCode}`).emit('match:event', event);
      }

      // Emit result
      io.to(`room_${room.roomCode}`).emit('match:ended', {
        playerA: playerIds[0],
        playerB: playerIds[1],
        scoreA: result.scoreA,
        scoreB: result.scoreB,
        winner: result.winner === 'A' ? playerIds[0] : playerIds[1],
        mvp: result.mvp
      });
    } else {
      result = matchSim.simulateTournament(playerTeams);

      // Similar broadcast for tournament...
    }

    // Build leaderboard
    const leaderboard = buildLeaderboard(room, result);

    io.to(`room_${room.roomCode}`).emit('results:leaderboard', leaderboard);

    // Save game to DB (async)
    saveGameToDB(room, result);

    room.status = 'finished';
    room.endedAt = Date.now();
  } catch (error) {
    console.error('Match simulation error:', error);
  }
}

function buildLeaderboard(room, matchResult) {
  const leaderboard = [];

  // For 1v1: rank by win/loss
  // For tournament: use tournament standings

  return leaderboard;
}

async function saveGameToDB(room, matchResult) {
  // Placeholder for DB save
  console.log(`Saving game ${room.roomCode} to database...`);
}

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Socket.IO listening...`);
});

module.exports = { app, server, io };
