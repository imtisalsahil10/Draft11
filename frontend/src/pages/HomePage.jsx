/**
 * HOME PAGE
 * Create room or join existing room
 */

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiService from '../services/api';
import socketService from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { Alert, Button, Panel, Screen, Spinner, TextField } from '../components/ui';

export default function HomePage() {
  const navigate = useNavigate();
  const { setUsername, setRoomCode, setPlayerId, setPlayers, setStatus } = useGameStore();
  const [username, setUsernameInput] = useState('');
  const [roomCode, setRoomCodeInput] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  const finish = () => {
    busyRef.current = false;
    setBusy('');
  };

  const handleCreateRoom = async () => {
    if (busyRef.current) return;
    if (!username.trim()) {
      setError('Please enter your username');
      return;
    }

    busyRef.current = true;
    socketService.connect();

    setBusy('create');
    setError('');
    try {
      const created = await apiService.createRoom();
      if (!created?.success || !created.roomCode) {
        setError(created?.error || 'Failed to create room');
        finish();
        return;
      }
      const createdCode = created.roomCode;

      setUsername(username);
      setRoomCode(createdCode);

      socketService.joinRoom(username, createdCode, (response) => {
        finish();
        if (response?.success) {
          setPlayerId(response.playerId);
          if (response.players) setPlayers(response.players);
          setStatus('waiting');
          navigate(`/room/${createdCode}`);
        } else {
          setError(response?.message || response?.error || 'Failed to join room');
        }
      });
    } catch (err) {
      setError('Failed to create room: ' + err.message);
      finish();
    }
  };

  const handleJoinRoom = async () => {
    if (busyRef.current) return;
    if (!username.trim()) {
      setError('Please enter your username');
      return;
    }
    if (!roomCode.trim()) {
      setError('Please enter a room code');
      return;
    }

    busyRef.current = true;
    socketService.connect();

    setBusy('join');
    setError('');
    try {
      setUsername(username);
      setRoomCode(roomCode);

      socketService.joinRoom(username, roomCode.toUpperCase(), (response) => {
        finish();
        if (response?.success) {
          setPlayerId(response.playerId);
          if (response.players) setPlayers(response.players);
          setStatus('waiting');
          navigate(`/room/${roomCode.toUpperCase()}`);
        } else {
          setError(response?.message || response?.error || 'Failed to join room');
        }
      });
    } catch (err) {
      setError('Failed to join room: ' + err.message);
      finish();
    }
  };

  return (
    <Screen image="/stadium-main.jpg" variant="home" width="narrow" className="screen-center">
      <main className="stack stack-lg">
        <div className="hero-copy">
          <p className="eyebrow">Draft11</p>
          <h1>Football Auction</h1>
          <p className="lede">
            Build a squad in a live room. Bid on player cards, pass when the price is wrong, and ready up for the next one.
          </p>
        </div>

        <Panel className="panel-accent">
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              handleCreateRoom();
            }}
          >
            <TextField
              id="username"
              name="username"
              label="Username"
              placeholder="Enter your name"
              value={username}
              onChange={(event) => {
                setUsernameInput(event.target.value);
                if (error === 'Please enter your username') setError('');
              }}
              disabled={Boolean(busy)}
              maxLength={20}
              autoComplete="username"
              error={error === 'Please enter your username' ? error : ''}
            />
            <Button type="submit" block size="lg" disabled={Boolean(busy)}>
              {busy === 'create' ? <Spinner /> : null}
              {busy === 'create' ? 'Creating room' : 'Create Room'}
            </Button>
          </form>
        </Panel>

        <p className="section-label">Join a room</p>

        <Panel>
          <div className="stack">
            <TextField
              id="room-code"
              name="roomCode"
              label="Room code"
              inputClassName="input-code"
              placeholder="Enter code"
              value={roomCode}
              onChange={(event) => {
                setRoomCodeInput(event.target.value.toUpperCase());
                if (error === 'Please enter a room code') setError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleJoinRoom();
                }
              }}
              maxLength={6}
              disabled={Boolean(busy)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck="false"
              error={error === 'Please enter a room code' ? error : ''}
            />
            <Button variant="secondary" block size="lg" onClick={handleJoinRoom} disabled={Boolean(busy)}>
              {busy === 'join' ? <Spinner /> : null}
              {busy === 'join' ? 'Joining room' : 'Join Room'}
            </Button>
          </div>
        </Panel>

        {error && error !== 'Please enter your username' && error !== 'Please enter a room code' ? (
          <Alert>{error}</Alert>
        ) : null}

        <Button variant="secondary" block onClick={() => navigate('/catalogue')}>
          Browse player cards
        </Button>

        <Button variant="secondary" block onClick={() => navigate('/league')}>
          Play a league
        </Button>

        <div className="chip-row">
          <span className="chip">Up to 5 players</span>
          <span className="chip">£1000 budget</span>
        </div>
        <p className="lede" style={{ textAlign: 'center' }}>
          Real-time multiplayer · Strategic bidding · 11-card squads
        </p>
      </main>
    </Screen>
  );
}
