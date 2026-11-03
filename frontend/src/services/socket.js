/**
 * SOCKET.IO CLIENT SERVICE
 * Manages real-time communication with backend
 */

import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_IO_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';
const SOCKET_PATH = import.meta.env.VITE_SOCKET_IO_PATH || '/socket.io';

class SocketService {
  constructor() {
    this.socket = null;
    this._connecting = false;
    this._pendingListeners = [];
    this._pendingEmits = [];
    this._listeners = new Map();
    this._session = null;
    this._admitted = false;
    this._hasConnectedOnce = false;
    this._connectionState = 'disconnected';
  }

  getConnectionState() {
    if (this.socket?.connected) return 'connected';
    if (this._connectionState === 'lost') return 'lost';
    if (this.socket?.active || this._connecting) {
      return this._hasConnectedOnce ? 'reconnecting' : 'connecting';
    }
    return this._connectionState || 'disconnected';
  }

  _setConnectionState(state) {
    this._connectionState = state;
    this._emitLocal('connection:state', state);
  }

  _emitLocal(event, payload) {
    const listeners = this._listeners.get(event);
    if (!listeners) return;
    for (const callback of listeners) callback(payload);
  }

  /**
   * Initialize Socket.IO connection
   */
  connect() {
    if (this.socket?.connected || this._connecting) return;
    if (this.socket) {
      this._connecting = true;
      this._setConnectionState(this._hasConnectedOnce ? 'reconnecting' : 'connecting');
      this.socket.connect();
      return;
    }
    this._connecting = true;
    this._connectionState = 'connecting';

    this.socket = io(SOCKET_URL, {
      path: SOCKET_PATH,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling']
    });

    for (const [event, callbacks] of this._listeners) {
      if (event === 'connection:state') continue;
      for (const callback of callbacks) this.socket.on(event, callback);
    }
    this._pendingListeners = [];

    this.socket.on('connect', () => {
      console.log('✅ Connected to server');
      this._connecting = false;
      const isReconnect = this._hasConnectedOnce;
      this._hasConnectedOnce = true;
      if (this._pendingEmits.length > 0) {
        const queued = this._pendingEmits.splice(0);
        for (const { event, data, callback } of queued) {
          this.socket.emit(event, data, callback);
        }
      }

      const session = this._session || this.savedSession();
      if (!this._quit && isReconnect && this._admitted && session?.username && session?.roomCode) {
        this._session = session;
        const payload = { username: session.username, roomCode: session.roomCode };
        if (session.seatToken) payload.seatToken = session.seatToken;
        this.socket.emit('room:join', payload, (response) => {
          if (response?.success) {
            this._admitted = true;
            if (response.seatToken) {
              this._persistSession({
                username: session.username,
                roomCode: session.roomCode,
                seatToken: response.seatToken
              });
            }
            return;
          }
          this._admitted = false;
          this._emitLocal('session:rejected', response || {
            message: 'Could not rejoin this room.'
          });
        });
      }

      this._setConnectionState('connected');
    });

    this.socket.on('disconnect', () => {
      console.log('❌ Disconnected from server');
      this._connecting = false;
      this._setConnectionState('reconnecting');
    });

    this.socket.on('connect_error', (error) => {
      console.error('Connection error:', error);
      this._connecting = false;
      const gaveUp = this.socket && this.socket.active === false;
      this._setConnectionState(gaveUp ? 'lost' : (this._hasConnectedOnce ? 'reconnecting' : 'connecting'));
      if (gaveUp || !this._admitted) {
        this._failPending('The server could not be reached.');
      }
    });

    this.socket.io.on('reconnect_failed', () => {
      this._setConnectionState('lost');
      this._failPending('The server could not be reached.');
    });
  }

  _failPending(message) {
    const queued = this._pendingEmits.splice(0);
    for (const { callback } of queued) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'CONNECTION_LOST', message });
      }
    }
  }

  /**
   * Disconnect Socket.IO
   */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this._connecting = false;
    this._connectionState = 'disconnected';
  }

  /**
   * Check if socket is connected
   */
  isConnected() {
    return this.socket?.connected || false;
  }

  /**
   * Emit event to server.
   * Only room joins are queued across a reconnect. Game actions fail closed
   * so a stale bid cannot be sent after the auction has moved on.
   */
  emit(event, data, callback) {
    const queueable = event === 'room:join';
    if (!this.socket) {
      if (!queueable) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'CONNECTION_LOST', message: 'Not connected to the server.' });
        }
        this.connect();
        return;
      }
      this._pendingEmits.push({ event, data, callback });
      this.connect();
      return;
    }

    if (!this.socket.connected) {
      if (!queueable) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'CONNECTION_LOST', message: 'Not connected to the server.' });
        }
        return;
      }
      this._pendingEmits.push({ event, data, callback });
      return;
    }

    this.socket.emit(event, data, callback);
  }

  /**
   * Listen for event from server
   */
  on(event, callback) {
    if (!callback) return;
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    const callbacks = this._listeners.get(event);
    if (callbacks.has(callback)) return;
    callbacks.add(callback);
    if (!this.socket) {
      this._pendingListeners.push({ event, callback });
      if (event !== 'connection:state') this.connect();
      return;
    }
    if (event !== 'connection:state') this.socket.on(event, callback);
  }

  /**
   * Remove event listener
   */
  off(event, callback) {
    if (callback) {
      this._listeners.get(event)?.delete(callback);
      this._pendingListeners = this._pendingListeners.filter(
        (listener) => listener.event !== event || listener.callback !== callback
      );
      if (event !== 'connection:state') this.socket?.off(event, callback);
      return;
    }
    this._listeners.delete(event);
    this._pendingListeners = this._pendingListeners.filter((listener) => listener.event !== event);
    if (event !== 'connection:state') this.socket?.off(event);
  }

  _persistSession(session) {
    this._session = session;
    try {
      sessionStorage.setItem('draft11-session', JSON.stringify(session));
    } catch {
      // Ignore private-mode storage failures
    }
  }

  /**
   * Join room. A saved seat token is sent only for the same name and room.
   */
  joinRoom(username, roomCode, callback) {
    const existing = this.savedSession();
    const sameSeat = existing?.username === username && existing?.roomCode === roomCode;
    const session = { username, roomCode };
    if (sameSeat && existing.seatToken) session.seatToken = existing.seatToken;
    this._persistSession(session);
    this.emit('room:join', session, (response) => {
      if (this._quit) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'LEFT', message: 'Left the auction.' });
        }
        return;
      }
      if (response?.success) {
        this._admitted = true;
        if (response.seatToken) {
          this._persistSession({ username, roomCode, seatToken: response.seatToken });
        }
      }
      if (typeof callback === 'function') callback(response);
    });
  }

  savedSession() {
    if (this._session) return this._session;
    try {
      return JSON.parse(sessionStorage.getItem('draft11-session') || 'null');
    } catch {
      return null;
    }
  }

  syncAuction(callback) {
    this.emit('auction:sync', {}, callback);
  }

  clearSession() {
    this._session = null;
    this._admitted = false;
    try {
      sessionStorage.removeItem('draft11-session');
    } catch {
      // Ignore private-mode storage failures
    }
  }

  /**
   * Leave room
   */
  leaveRoom(callback) {
    const session = this.savedSession();
    const payload = {};
    if (session?.roomCode) payload.roomCode = session.roomCode;
    if (session?.seatToken) payload.seatToken = session.seatToken;
    this._quit = true;
    this.clearSession();
    const finish = (response) => {
      this._quit = false;
      this.clearSession();
      if (typeof callback === 'function') callback(response || { success: true });
    };
    if (!this.socket?.connected) {
      if (!payload.seatToken && !payload.roomCode) {
        finish({ success: true, alreadyLeft: true });
        return;
      }
      this._pendingEmits.push({ event: 'room:leave', data: payload, callback: finish });
      this.connect();
      return;
    }
    this.socket.emit('room:leave', payload, finish);
  }

  /**
   * Start auction
   */
  startAuction(callback) {
    this.emit('room:start-auction', {}, callback);
  }

  /**
   * Place bid
   */
  placeBid(bidAmount, callback) {
    this.emit('auction:bid', { bidAmount }, callback);
  }

  /**
   * Skip card
   */
  skipCard(callback) {
    this.emit('auction:skip', {}, callback);
  }

  /**
   * Resolve card
   */
  resolveCard(callback) {
    this.emit('auction:resolve-card', {}, callback);
  }

  /**
   * Save the tactical lineup. The server checks ownership and revision.
   */
  updateSquad(payload, callback) {
    this.emit('squad:update', payload, callback);
  }

  /**
   * Listen for room updates
   */
  onPlayerJoined(callback) {
    this.on('room:player-joined', callback);
  }

  onPlayerLeft(callback) {
    this.on('room:player-left', callback);
  }

  /**
   * Listen for auction events
   */
  onAuctionStarted(callback) {
    this.on('auction:started', callback);
  }

  onCardPresented(callback) {
    this.on('auction:card-presented', callback);
  }

  onBidReceived(callback) {
    this.on('auction:bid-received', callback);
  }

  onPlayerSkipped(callback) {
    this.on('auction:player-skipped', callback);
  }

  onCardResult(callback) {
    this.on('auction:card-result', callback);
  }

  onAuctionFinished(callback) {
    this.on('auction:finished', callback);
  }
}

export default new SocketService();
