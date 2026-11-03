/**
 * ROOM PAGE
 * Wait for other players / start auction
 */

import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import socketService from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { QuitAuction } from '../components/AuctionScreens';
import { Alert, Badge, Button, Panel, Screen, Spinner, formatMoney } from '../components/ui';

export default function RoomPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { players, setPlayers, setStatus, setPlayerId, setUsername } = useGameStore();
  const [gameStarted, setGameStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [connectionState, setConnectionState] = useState(() => socketService.getConnectionState());
  const startRef = useRef(false);
  const quitLock = useRef(false);

  const handleQuit = () => new Promise((resolve) => {
    if (quitLock.current) {
      resolve();
      return;
    }
    quitLock.current = true;
    socketService.leaveRoom(() => {
      useGameStore.getState().reset();
      navigate('/');
      resolve();
    });
  });

  useEffect(() => {
    const onJoined = (data) => {
      if (Array.isArray(data?.players)) setPlayers(data.players);
    };
    const onLeft = (data) => {
      if (Array.isArray(data?.players)) setPlayers(data.players);
    };
    const onStarted = () => {
      setStatus('auction');
      setGameStarted(true);
      navigate(`/auction/${code}`);
    };
    const onState = (state) => setConnectionState(state);

    socketService.on('room:player-joined', onJoined);
    socketService.on('room:player-left', onLeft);
    socketService.on('room:players-updated', onJoined);
    socketService.on('auction:started', onStarted);
    const onRejected = (response) => {
      setError(response?.message || response?.error || 'Could not rejoin this room.');
    };
    socketService.on('connection:state', onState);
    socketService.on('session:rejected', onRejected);
    socketService.connect();

    const session = socketService.savedSession();
    if (session?.username && session.roomCode === code) {
      setUsername(session.username);
      socketService.joinRoom(session.username, code, (response) => {
        if (!response?.success) {
          setError(response?.message || response?.error || 'Could not rejoin the room');
          return;
        }
        setPlayerId(response.playerId);
        if (response.players) setPlayers(response.players);
        if (response.auction) navigate(`/auction/${code}`);
      });
    }

    return () => {
      socketService.off('room:player-joined', onJoined);
      socketService.off('room:player-left', onLeft);
      socketService.off('room:players-updated', onJoined);
      socketService.off('auction:started', onStarted);
      socketService.off('connection:state', onState);
      socketService.off('session:rejected', onRejected);
    };
  }, [code, navigate, setPlayers, setPlayerId, setStatus, setUsername]);

  const handleStartAuction = () => {
    if (startRef.current || gameStarted || connectionState !== 'connected') return;
    startRef.current = true;
    setStarting(true);
    setError('');
    socketService.startAuction((response) => {
      startRef.current = false;
      setStarting(false);
      if (!response?.success) {
        setError(response?.message || response?.error || 'Could not start the auction');
      }
    });
  };

  const connected = connectionState === 'connected';
  const connectionLabel = connected
    ? 'Connected'
    : connectionState === 'lost'
      ? 'Connection lost'
      : connectionState === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting';
  const seated = players.length > 0 || socketService.savedSession()?.roomCode === code;

  const spotsLeft = 5 - players.length;

  return (
    <Screen image="/stadium-tunnel.jpg" variant="home" width="room" className="screen-center">
      <main className="stack stack-lg">
        <div className="page-header" style={{ textAlign: 'center' }}>
          <p className="eyebrow">Lobby</p>
          <h1>Room code</h1>
          <p className="room-code">{code}</p>
          <p className="lede">Share this code with the other players.</p>
          <p className="lede">{connectionLabel}</p>
        </div>

        {!seated ? (
          <Alert>Open this room from the home page so the server knows who you are.</Alert>
        ) : null}
        {connectionState === 'lost' ? (
          <Alert>
            The connection dropped.
            <div className="bid-actions">
              <Button onClick={() => socketService.connect()}>Retry connection</Button>
            </div>
          </Alert>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}

        <Panel title={`Players (${players.length}/5)`}>
          {players.length === 0 ? (
            <p className="empty-state">{connected ? 'Waiting for players.' : 'Connecting to the room.'}</p>
          ) : (
            <ul className="player-list">
              {players.map((player) => (
                <li key={player.id} className="player-row">
                  <strong>{player.username}</strong>
                  <span>
                    {player.isHost ? 'Host · ' : ''}
                    {player.isOnline === false ? 'Offline · ' : ''}
                    {formatMoney(player.balance)} · {player.teamSize}/11
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Button block size="lg" onClick={handleStartAuction} disabled={!connected || !seated || players.length < 1 || gameStarted || starting}>
          {starting ? <Spinner /> : null}
          {gameStarted ? 'Auction started' : starting ? 'Starting auction' : 'Start auction'}
        </Button>

        <div className="btn-row" style={{ justifyContent: 'center' }}>
          <QuitAuction onQuit={handleQuit} />
        </div>

        <p className="lede" style={{ textAlign: 'center' }}>
          {spotsLeft > 0 ? (
            <>
              Waiting for {spotsLeft} more player{spotsLeft !== 1 ? 's' : ''} (or start with current players)
            </>
          ) : (
            <Badge tone="good">Room is full</Badge>
          )}
        </p>
      </main>
    </Screen>
  );
}
