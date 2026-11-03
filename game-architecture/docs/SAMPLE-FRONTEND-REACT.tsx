// Frontend: App.tsx - Main React component with routing

import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

// Pages
import HomePage from './pages/HomePage';
import GameRoomPage from './pages/GameRoom';
import LeaderboardPage from './pages/Leaderboard';
import NotFoundPage from './pages/NotFound';

// Services
import { initializeSocket } from './services/socket';
import { useGameStore } from './services/gameState';

// Styles
import './styles/global.css';

function App() {
  const { setSocket } = useGameStore();

  useEffect(() => {
    // Initialize Socket.IO connection
    const socket = initializeSocket();
    setSocket(socket);

    return () => {
      socket.disconnect();
    };
  }, [setSocket]);

  return (
    <Router>
      <div className="app-container">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/room/:roomCode" element={<GameRoomPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        <Toaster position="top-right" />
      </div>
    </Router>
  );
}

export default App;

// ============================================
// Frontend: services/socket.ts - Socket.IO client setup

import io, { Socket } from 'socket.io-client';

let socket: Socket | null = null;

export const initializeSocket = (): Socket => {
  if (socket) return socket;

  socket = io(import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001', {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5
  });

  socket.on('connect', () => {
    console.log('[Socket] Connected:', socket?.id);
  });

  socket.on('connect_error', (error) => {
    console.error('[Socket] Connection error:', error);
  });

  socket.on('disconnect', (reason) => {
    console.log('[Socket] Disconnected:', reason);
  });

  return socket;
};

export const getSocket = (): Socket => {
  if (!socket) {
    throw new Error('Socket not initialized');
  }
  return socket;
};

export const emitEvent = (event: string, data: any) => {
  getSocket().emit(event, data);
};

export const onEvent = (event: string, callback: (data: any) => void) => {
  getSocket().on(event, callback);
};

// ============================================
// Frontend: services/gameState.ts - Zustand store

import { create } from 'zustand';
import { Socket } from 'socket.io-client';

interface GameState {
  // Connection
  socket: Socket | null;
  setSocket: (socket: Socket | null) => void;

  // Room
  roomCode: string | null;
  players: Map<string, PlayerData>;
  maxPlayers: number;
  gameStatus: 'waiting' | 'auctioning' | 'team_review' | 'matching' | 'finished';
  setRoomCode: (code: string) => void;
  addPlayer: (id: string, data: PlayerData) => void;
  removePlayer: (id: string) => void;
  setGameStatus: (status: GameState['gameStatus']) => void;

  // Current player
  currentPlayerId: string | null;
  currentUsername: string | null;
  currentBalance: number;
  currentTeam: Card[];
  setCurrentPlayer: (id: string, username: string) => void;
  updateBalance: (amount: number) => void;
  addCardToTeam: (card: Card) => void;

  // Auction
  currentCard: Card | null;
  highestBid: number;
  highestBidder: string | null;
  timeRemaining: number;
  setCurrentCard: (card: Card) => void;
  setHighestBid: (amount: number, bidderId: string) => void;
  setTimeRemaining: (seconds: number) => void;

  // Match & Results
  matchResults: any | null;
  leaderboard: any[] | null;
  setMatchResults: (results: any) => void;
  setLeaderboard: (leaderboard: any[]) => void;
}

export const useGameStore = create<GameState>((set) => ({
  socket: null,
  setSocket: (socket) => set({ socket }),

  roomCode: null,
  players: new Map(),
  maxPlayers: 5,
  gameStatus: 'waiting',
  setRoomCode: (code) => set({ roomCode: code }),
  addPlayer: (id, data) => set((state) => {
    const newPlayers = new Map(state.players);
    newPlayers.set(id, data);
    return { players: newPlayers };
  }),
  removePlayer: (id) => set((state) => {
    const newPlayers = new Map(state.players);
    newPlayers.delete(id);
    return { players: newPlayers };
  }),
  setGameStatus: (status) => set({ gameStatus: status }),

  currentPlayerId: null,
  currentUsername: null,
  currentBalance: 1000,
  currentTeam: [],
  setCurrentPlayer: (id, username) => set({
    currentPlayerId: id,
    currentUsername: username
  }),
  updateBalance: (amount) => set((state) => ({
    currentBalance: Math.max(0, state.currentBalance + amount)
  })),
  addCardToTeam: (card) => set((state) => ({
    currentTeam: [...state.currentTeam, card]
  })),

  currentCard: null,
  highestBid: 0,
  highestBidder: null,
  timeRemaining: 30,
  setCurrentCard: (card) => set({
    currentCard: card,
    highestBid: card.basePrice,
    highestBidder: null
  }),
  setHighestBid: (amount, bidderId) => set({
    highestBid: amount,
    highestBidder: bidderId
  }),
  setTimeRemaining: (seconds) => set({ timeRemaining: seconds }),

  matchResults: null,
  leaderboard: null,
  setMatchResults: (results) => set({ matchResults: results }),
  setLeaderboard: (leaderboard) => set({ leaderboard })
}));

// ============================================
// Frontend: pages/HomePage.tsx - Create/Join room

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGameStore } from '../services/gameState';
import toast from 'react-hot-toast';

function HomePage() {
  const navigate = useNavigate();
  const { setRoomCode, setCurrentPlayer } = useGameStore();
  const [mode, setMode] = useState<'create' | 'join'>('join');
  const [username, setUsername] = useState('');
  const [roomCode, setRoomCodeInput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      toast.error('Please enter a username');
      return;
    }

    setLoading(true);
    try {
      const newRoomCode = generateRoomCode();
      const response = await fetch(`${import.meta.env.VITE_API_URL}/api/rooms/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: newRoomCode,
          username: username,
          createdBy: generateUserId()
        })
      });

      if (!response.ok) {
        throw new Error('Failed to create room');
      }

      const data = await response.json();
      setRoomCode(newRoomCode);
      setCurrentPlayer(data.userId, username);
      toast.success(`Room created! Code: ${newRoomCode}`);
      navigate(`/room/${newRoomCode}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create room');
    } finally {
      setLoading(false);
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !roomCode.trim()) {
      toast.error('Please enter username and room code');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/api/rooms/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: roomCode.toUpperCase(),
          username: username,
          userId: generateUserId()
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to join room');
      }

      const data = await response.json();
      setRoomCode(roomCode.toUpperCase());
      setCurrentPlayer(data.userId, username);
      toast.success('Joined room!');
      navigate(`/room/${roomCode.toUpperCase()}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to join room');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="home-page">
      <div className="container max-w-md mx-auto py-20">
        <h1 className="text-4xl font-bold mb-8 text-center">Football Auction</h1>

        <div className="tabs mb-8 flex gap-4">
          <button
            onClick={() => setMode('join')}
            className={`flex-1 py-2 px-4 rounded ${
              mode === 'join'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200'
            }`}
          >
            Join Room
          </button>
          <button
            onClick={() => setMode('create')}
            className={`flex-1 py-2 px-4 rounded ${
              mode === 'create'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200'
            }`}
          >
            Create Room
          </button>
        </div>

        <form onSubmit={mode === 'create' ? handleCreateRoom : handleJoinRoom}>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Your username"
              className="w-full px-4 py-2 border rounded"
              disabled={loading}
            />
          </div>

          {mode === 'join' && (
            <div className="mb-6">
              <label className="block text-sm font-medium mb-2">Room Code</label>
              <input
                type="text"
                value={roomCode}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                placeholder="e.g., ABC123"
                className="w-full px-4 py-2 border rounded"
                disabled={loading}
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-3 rounded font-semibold hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Loading...' : mode === 'create' ? 'Create Room' : 'Join Room'}
          </button>
        </form>

        <div className="mt-8 p-4 bg-blue-50 rounded">
          <h3 className="font-semibold mb-2">How to play:</h3>
          <ul className="text-sm space-y-1">
            <li>• Max 5 players per room</li>
            <li>• Start with £1000</li>
            <li>• Bid on 100 football player cards</li>
            <li>• Build your best 11-player team</li>
            <li>• Simulate match to determine winner</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function generateRoomCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateUserId(): string {
  return `user_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

export default HomePage;

// ============================================
// Frontend: components/auction/AuctionView.tsx - Auction display

import React, { useEffect } from 'react';
import { useGameStore } from '../../services/gameState';
import { getSocket } from '../../services/socket';
import CardDisplay from './CardDisplay';
import BiddingControls from './BiddingControls';
import TimerBar from './TimerBar';
import BidHistory from './BidHistory';
import toast from 'react-hot-toast';

function AuctionView() {
  const {
    currentCard,
    currentPlayerId,
    currentBalance,
    timeRemaining,
    setTimeRemaining,
    setCurrentCard,
    updateBalance
  } = useGameStore();

  const socket = getSocket();

  useEffect(() => {
    // Listen to auction events
    socket.on('auction:card-presented', (data) => {
      setCurrentCard(data.card);
      setTimeRemaining(30);
    });

    socket.on('auction:timer-tick', (data) => {
      setTimeRemaining(data.remainingSeconds);
    });

    socket.on('auction:bid-received', (data) => {
      // Update UI (card display updates via store)
    });

    socket.on('auction:card-result', (data) => {
      if (data.status === 'sold' && data.winner.userId === currentPlayerId) {
        updateBalance(-data.winner.finalBid);
        toast.success(`You won ${data.cardName} for £${data.winner.finalBid}!`);
      }
    });

    return () => {
      socket.off('auction:card-presented');
      socket.off('auction:timer-tick');
      socket.off('auction:bid-received');
      socket.off('auction:card-result');
    };
  }, [socket, setCurrentCard, setTimeRemaining, updateBalance, currentPlayerId]);

  if (!currentCard) {
    return <div className="text-center py-8">Loading auction...</div>;
  }

  return (
    <div className="auction-view grid grid-cols-2 gap-6 py-6">
      <div>
        <CardDisplay card={currentCard} />
      </div>
      <div>
        <TimerBar remainingSeconds={timeRemaining} />
        <BiddingControls card={currentCard} balance={currentBalance} />
        <BidHistory />
      </div>
    </div>
  );
}

export default AuctionView;
