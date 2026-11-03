/**
 * AUCTION PAGE
 * Main game - bidding on cards
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import socketService from '../services/socket';
import { useGameStore } from '../store/gameStore';
import { Screen, Spinner } from '../components/ui';
import {
  AuctionBoard,
  AuctionLoading,
  MatchResult,
  ReadyGate,
  SpectatorBreak,
  SquadResults
} from '../components/AuctionScreens';
import SquadBuilder from '../components/SquadBuilder';

export default function AuctionPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  
  // Get store values (not setters - those are stable)
  const currentCard = useGameStore((state) => state.currentCard);
  const minimumBid = useGameStore((state) => state.minimumBid);
  const balance = useGameStore((state) => state.balance);
  const players = useGameStore((state) => state.players || []);
  const timerSeconds = useGameStore((state) => state.timerSeconds);
  const myTeam = useGameStore((state) => state.team || []);
  const playerId = useGameStore((state) => state.playerId);
  
  // Get setters separately (they don't cause re-renders)
  const setCurrentCard = useGameStore((state) => state.setCurrentCard);
  const setMinimumBid = useGameStore((state) => state.setMinimumBid);
  const setBalance = useGameStore((state) => state.setBalance);
  const setPlayers = useGameStore((state) => state.setPlayers);
  const setTimerSeconds = useGameStore((state) => state.setTimerSeconds);
  const addCardToTeam = useGameStore((state) => state.addCardToTeam);

  const [bidAmount, setBidAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [bidHistory, setBidHistory] = useState([]);
  const [isConnecting, setIsConnecting] = useState(true);
  const [waitingForReady, setWaitingForReady] = useState(false);
  const [readyPlayers, setReadyPlayers] = useState([]);
  const [isReady, setIsReady] = useState(false);
  const [loadingTimeout, setLoadingTimeout] = useState(false);
  const [sittingOut, setSittingOut] = useState(false);
  const [squads, setSquads] = useState(null);
  const [rematch, setRematch] = useState({ voters: [], voted: 0, total: 0, youVoted: false });
  const [connectionState, setConnectionState] = useState(() => socketService.getConnectionState());
  const [replaced, setReplaced] = useState(false);
  const actionRef = useRef(false);
  const [progress, setProgress] = useState({ index: null, total: null });
  const [readyTotals, setReadyTotals] = useState({ count: null, total: null });
  const [cheapestBid, setCheapestBid] = useState(null);
  const [spectatorIds, setSpectatorIds] = useState([]);
  const [watchSquads, setWatchSquads] = useState(null);
  const [bidIncrement, setBidIncrement] = useState(5);
  const [resumeError, setResumeError] = useState('');
  const [lineup, setLineup] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [squadBusy, setSquadBusy] = useState(false);
  const [squadError, setSquadError] = useState('');
  const [matchResult, setMatchResult] = useState(null);
  const [matchBusy, setMatchBusy] = useState(false);
  const [matchError, setMatchError] = useState('');
  const [departed, setDeparted] = useState([]);
  const squadLock = useRef(false);
  const quitLock = useRef(false);
  const lineupRef = useRef(null);

  const applyRematch = useCallback((data) => {
    const me = useGameStore.getState().username;
    const voters = Array.isArray(data?.voters) ? data.voters : [];
    setRematch({
      voters,
      voted: data?.voted ?? voters.length,
      total: data?.total ?? voters.length,
      youVoted: voters.some((voter) => voter.username === me)
    });
  }, []);

  const applyAuctionState = useCallback((state) => {
    if (!state) return;
    if (typeof state.currentIndex === 'number') {
      setProgress({ index: state.currentIndex, total: state.totalCards });
    }
    if (typeof state.cheapestBid === 'number') setCheapestBid(state.cheapestBid);
    if (Array.isArray(state.spectatorIds)) setSpectatorIds(state.spectatorIds);
    if (state.phase === 'waiting-for-ready' || state.waitingForReady) {
      setWaitingForReady(true);
      if (Array.isArray(state.readyPlayers)) {
        setReadyPlayers(state.readyPlayers);
        const myId = socketService.socket?.id || useGameStore.getState().playerId;
        setIsReady(state.readyPlayers.some((player) => player.playerId === myId));
      }
      setReadyTotals({
        count: typeof state.readyCount === 'number' ? state.readyCount : null,
        total: typeof state.totalPlayers === 'number' ? state.totalPlayers : null
      });
    } else if (state.card) {
      setWaitingForReady(false);
    }
    if (state.card) {
      setCurrentCard(state.card);
      setMinimumBid(state.minimumBid);
    }
    if (typeof state.bidIncrement === 'number') setBidIncrement(state.bidIncrement);
    if (typeof state.secondsRemaining === 'number' && state.phase === 'bidding') {
      setTimerSeconds(state.secondsRemaining);
    }
    if (Array.isArray(state.yourCards)) {
      useGameStore.setState({ team: state.yourCards, cardsWon: state.yourCards.length });
    }
    if (Array.isArray(state.bids)) {
      setBidHistory(state.bids);
    }
    if (typeof state.yourBalance === 'number') {
      setBalance(state.yourBalance);
    }
    if (state.phase === 'bidding') {
      setSittingOut(Boolean(state.youSkipped));
    }
    if (state.phase === 'finished' && Array.isArray(state.squads)) {
      setSquads(state.squads);
      if (state.lineup) {
        const incoming = state.lineup.revision ?? 0;
        const held = lineupRef.current?.revision ?? -1;
        if (incoming >= held) {
          lineupRef.current = state.lineup;
          setLineup(state.lineup);
        }
      }
      if (state.rematch) applyRematch(state.rematch);
    } else if (state.phase && state.phase !== 'finished') {
      setSquads(null);
      lineupRef.current = null;
      setLineup(null);
      setReviewing(false);
      setSquadError('');
      if (state.youSpectating && Array.isArray(state.squads)) setWatchSquads(state.squads);
    }
    if (state.match?.matches || state.match?.standings) setMatchResult(state.match);
    if (Array.isArray(state.departed)) setDeparted(state.departed);
  }, [applyRematch, setBalance, setCurrentCard, setMinimumBid, setTimerSeconds]);

  // Connect and join room on mount
  useEffect(() => {
    const initializeAuction = () => {
      try {
        socketService.connect();
      } catch (error) {
        console.error('Failed to connect:', error);
        setIsConnecting(false);
      }
    };

    initializeAuction();

    // Set timeout for loading screen - show fallback after 10 seconds
    const timeoutId = setTimeout(() => {
      if (!currentCard) {
        setLoadingTimeout(true);
      }
    }, 10000);

    return () => clearTimeout(timeoutId);
  }, [code, currentCard]);

  useEffect(() => {
    // Timer countdown
    const timer = setInterval(() => {
      setTimerSeconds(prev => {
        if (prev > 0) {
          return prev - 1;
        }
        return 0; // Stop at 0, don't reset
      });
    }, 1000);

    socketService.onCardPresented((data) => {
      const myId = socketService.socket?.id || useGameStore.getState().playerId;
      setSquads(null);
      setCurrentCard(data.card);
      setMinimumBid(data.minimumBid);
      if (typeof data.bidIncrement === 'number') setBidIncrement(data.bidIncrement);
      setTimerSeconds(30);
      setBidAmount('');
      setBidHistory([]); // Reset bid history for new card
      setWaitingForReady(false); // Exit ready mode
      setIsReady(false);
      setReadyPlayers([]);
      setReadyTotals({ count: null, total: null });
      if (typeof data.currentIndex === 'number') {
        setProgress({ index: data.currentIndex, total: data.totalCards });
      }
      if (typeof data.cheapestBid === 'number') setCheapestBid(data.cheapestBid);
      if (Array.isArray(data.spectatorIds)) setSpectatorIds(data.spectatorIds);
      setSittingOut(Array.isArray(data.passedPlayerIds) && data.passedPlayerIds.includes(myId));
    });

    socketService.onBidReceived((data) => {
      console.log('Bid received:', data);
      setBidHistory(prev => {
        const alreadyShown = prev[0]?.bidAmount === data.bidAmount
          && prev[0]?.playerUsername === data.playerUsername;
        if (alreadyShown) return prev;
        return [{
          playerUsername: data.playerUsername,
          bidAmount: data.bidAmount,
          timestamp: Date.now()
        }, ...prev];
      });
      if (typeof data.minimumBid === 'number') setMinimumBid(data.minimumBid);
      if (typeof data.bidIncrement === 'number') setBidIncrement(data.bidIncrement);
      setTimerSeconds(15);
    });

    socketService.onPlayerSkipped((data) => {
      const myId = socketService.socket?.id || useGameStore.getState().playerId;
      if (data.playerId === myId) {
        setSittingOut(true);
      }
      if (Array.isArray(data.bids)) {
        setBidHistory(data.bids);
      }
      if (typeof data.minimumBid === 'number') {
        setMinimumBid(data.minimumBid);
      }
      if (typeof data.bidIncrement === 'number') setBidIncrement(data.bidIncrement);
    });

    socketService.onCardResult((data) => {
      console.log('Card result:', data);
      
      // Update winner's balance and cards if it's the current user
      if (data.winnerId && data.finalPrice) {
        const currentPlayers = useGameStore.getState().players || [];
        setPlayers(currentPlayers.map(p => 
          p.id === data.winnerId 
            ? { ...p, balance: p.balance - data.finalPrice, teamSize: (p.teamSize || 0) + 1 }
            : p
        ));
        
        if (data.winnerId === socketService.socket?.id && data.card) {
          const owned = useGameStore.getState().team || [];
          if (!owned.some((card) => card.id != null && card.id === data.card.id)) {
            addCardToTeam(data.card);
          }
        }
      }
      
      // Show winner notification
      if (data.status === 'awarded') {
        setTimeout(() => {
          alert(`🏆 ${data.winnerUsername} won ${data.cardName} for £${data.finalPrice}!`);
        }, 100);
      } else if (data.status === 'discarded') {
        setTimeout(() => {
          alert(`❌ ${data.cardName} was discarded (no bids)`);
        }, 100);
      }
    });
    
    // Listen for player list updates
    const applyPlayers = (data) => {
      if (!data || !Array.isArray(data.players)) return;
      setPlayers(data.players);
      const mine = data.players.find((player) => player.id === (socketService.socket?.id || useGameStore.getState().playerId));
      if (mine && typeof mine.balance === 'number') setBalance(mine.balance);
    };
    socketService.on('room:players-updated', applyPlayers);
    socketService.on('room:player-joined', applyPlayers);
    socketService.on('room:player-left', (data) => {
      applyPlayers(data);
      if (Array.isArray(data?.bids)) setBidHistory(data.bids);
      if (typeof data?.minimumBid === 'number') setMinimumBid(data.minimumBid);
      if (typeof data?.bidIncrement === 'number') setBidIncrement(data.bidIncrement);
      if (data?.departed?.username) {
        setDeparted((current) => {
          const next = current.filter((seat) => seat.username !== data.departed.username);
          next.push(data.departed);
          return next;
        });
      }
    });
    
    // Listen for waiting for ready state
    socketService.on('auction:waiting-for-ready', (data) => {
      const readyList = Array.isArray(data?.readyPlayers) ? data.readyPlayers : [];
      setWaitingForReady(true);
      setIsReady(false);
      setReadyPlayers(readyList);
      setReadyTotals({
        count: typeof data?.readyCount === 'number' ? data.readyCount : readyList.length,
        total: typeof data?.totalPlayers === 'number' ? data.totalPlayers : null
      });
      if (typeof data?.cheapestBid === 'number') setCheapestBid(data.cheapestBid);
      if (Array.isArray(data?.spectatorIds)) setSpectatorIds(data.spectatorIds);
    });
    
    // Listen for player ready updates
    socketService.on('auction:player-ready-update', (data) => {
      if (Array.isArray(data?.readyPlayers)) {
        const myId = socketService.socket?.id || useGameStore.getState().playerId;
        setReadyPlayers(data.readyPlayers);
        setIsReady(data.readyPlayers.some((player) => player.playerId === myId));
      } else {
        setReadyPlayers(prev => {
          if (!prev.find(p => p.playerId === data.playerId)) {
            return [...prev, { playerId: data.playerId, playerUsername: data.playerUsername }];
          }
          return prev;
        });
      }
      if (typeof data?.readyCount === 'number' || typeof data?.totalPlayers === 'number') {
        setReadyTotals((prev) => ({
          count: typeof data.readyCount === 'number' ? data.readyCount : prev.count,
          total: typeof data.totalPlayers === 'number' ? data.totalPlayers : prev.total
        }));
      }
    });

    socketService.on('auction:spectator-squads', (data) => {
      if (Array.isArray(data?.squads)) setWatchSquads(data.squads);
    });

    socketService.on('auction:state', (state) => {
      applyAuctionState(state);
    });

    socketService.on('auction:finished', (data) => {
      if (Array.isArray(data?.squads)) {
        setSquads(data.squads);
      }
      applyRematch(data?.rematch);
      setWaitingForReady(false);
      setSittingOut(false);
      if (!lineupRef.current) {
        socketService.syncAuction((response) => {
          if (response?.success && response.state) applyAuctionState(response.state);
        });
      }
    });

    socketService.on('squad:updated', (data) => {
      if (!data?.playerId) return;
      setSquads((current) => {
        if (!Array.isArray(current)) return current;
        return current.map((squad) => (
          squad.id === data.playerId
            ? {
                ...squad,
                formation: data.formation || squad.formation,
                confirmed: Boolean(data.confirmed),
                strength: typeof data.strength === 'number' ? data.strength : null
              }
            : squad
        ));
      });
    });

    socketService.on('auction:rematch-update', (data) => {
      applyRematch(data);
    });

    socketService.on('room:session-replaced', () => {
      setReplaced(true);
      socketService.clearSession();
    });

    socketService.on('session:rejected', (response) => {
      setResumeError(response?.message || response?.error || 'Could not rejoin this room.');
      setLoadingTimeout(true);
      setWaitingForReady(false);
      setSquads(null);
      lineupRef.current = null;
      setLineup(null);
      setReviewing(false);
      setSquadError('');
      setCurrentCard(null);
    });

    socketService.on('match:results', (data) => {
      if (data?.matches || data?.standings) setMatchResult(data);
    });

    socketService.on('auction:rematch-started', () => {
      setMatchResult(null);
      setMatchError('');
      setDeparted([]);
      setSquads(null);
      lineupRef.current = null;
      setLineup(null);
      setReviewing(false);
      setSquadError('');
      navigate(`/auction/${code}`, { replace: true });
      setRematch({ voters: [], voted: 0, total: 0, youVoted: false });
      setBidHistory([]);
      setSittingOut(false);
      setWaitingForReady(false);
      setIsReady(false);
      setReadyPlayers([]);
      setReadyTotals({ count: null, total: null });
      setCheapestBid(null);
      setSpectatorIds([]);
      setWatchSquads(null);
      setCurrentCard(null);
      setBalance(1000);
      useGameStore.setState({ team: [] });
    });

    socketService.syncAuction((response) => {
      if (response?.success) {
        if (response.state) applyAuctionState(response.state);
        if (response.players) setPlayers(response.players);
        setIsConnecting(false);
        return;
      }

      const session = socketService.savedSession();
      if (session?.roomCode && session.roomCode !== code) {
        setResumeError('This browser session belongs to a different room.');
        setLoadingTimeout(true);
        setIsConnecting(false);
        return;
      }
      const name = session?.username;
      if (!name || session.roomCode !== code) {
        setResumeError('This browser is not in this auction.');
        setLoadingTimeout(true);
        setIsConnecting(false);
        return;
      }

      socketService.joinRoom(name, code, (joinResponse) => {
        setIsConnecting(false);
        if (!joinResponse?.success) {
          setResumeError(joinResponse?.message || joinResponse?.error || 'Could not rejoin this room');
          setLoadingTimeout(true);
          return;
        }
        useGameStore.getState().setUsername(name);
        if (joinResponse.playerId) useGameStore.getState().setPlayerId(joinResponse.playerId);
        if (joinResponse.players) setPlayers(joinResponse.players);
        if (typeof joinResponse.balance === 'number') setBalance(joinResponse.balance);
        if (joinResponse.auction) applyAuctionState(joinResponse.auction);
      });
    });

    return () => {
      clearInterval(timer);
      socketService.off('auction:card-presented');
      socketService.off('auction:bid-received');
      socketService.off('auction:player-skipped');
      socketService.off('auction:card-result');
      socketService.off('room:players-updated');
      socketService.off('room:player-joined');
      socketService.off('room:player-left');
      socketService.off('auction:waiting-for-ready');
      socketService.off('auction:player-ready-update');
      socketService.off('auction:spectator-squads');
      socketService.off('auction:state');
      socketService.off('auction:finished');
      socketService.off('squad:updated');
      socketService.off('auction:rematch-update');
      socketService.off('auction:rematch-started');
      socketService.off('room:session-replaced');
      socketService.off('session:rejected');
      socketService.off('match:results');
    };
  }, [
    code,
    addCardToTeam,
    applyAuctionState,
    applyRematch,
    navigate,
    setBalance,
    setCurrentCard,
    setMinimumBid,
    setPlayers,
    setTimerSeconds
  ]);

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

  const handleHome = () => {
    handleQuit();
  };

  const handlePlay = () => {
    if (matchBusy || actionRef.current || !socketService.isConnected()) return;
    actionRef.current = true;
    setMatchBusy(true);
    setMatchError('');
    socketService.emit('match:start', {}, (response) => {
      actionRef.current = false;
      setMatchBusy(false);
      if (response?.success && response.results) {
        setMatchResult(response.results);
        return;
      }
      setMatchError(response?.message || response?.error || 'The match could not be played.');
    });
  };

  const handleRematch = () => {
    if (rematch.youVoted || actionRef.current || !socketService.isConnected()) return;
    actionRef.current = true;
    socketService.emit('auction:rematch', {}, (response) => {
      actionRef.current = false;
      if (!response?.success) {
        alert(response?.message || response?.error || 'Rematch failed');
        return;
      }
      applyRematch(response);
    });
  };

  const handleQuickIncrement = () => {
    const current = parseInt(bidAmount, 10) || 0;
    const step = bidIncrement || 5;
    const newBid = current < minimumBid ? minimumBid : current + step;
    setBidAmount(String(newBid));
  };

  const handleBid = () => {
    if (actionRef.current || !socketService.isConnected()) return;
    const bid = parseInt(bidAmount, 10);
    if (!Number.isInteger(bid) || bid < minimumBid) {
      alert(`Minimum bid is £${minimumBid}`);
      return;
    }
    if (bid > balance) {
      alert(`Insufficient balance. You have £${balance}`);
      return;
    }

    actionRef.current = true;
    setLoading(true);
    socketService.placeBid(bid, (response) => {
      actionRef.current = false;
      if (response?.success) {
        setBidAmount('');
        setBidHistory((prev) => {
          const alreadyShown = prev[0]?.bidAmount === response.bidAmount
            && prev[0]?.playerUsername === response.playerUsername;
          if (alreadyShown) return prev;
          return [{
            playerUsername: response.playerUsername,
            bidAmount: response.bidAmount,
            timestamp: Date.now()
          }, ...prev];
        });
        if (typeof response.minimumBid === 'number') setMinimumBid(response.minimumBid);
        if (typeof response.bidIncrement === 'number') setBidIncrement(response.bidIncrement);
      } else {
        alert('Bid failed: ' + (response?.message || response?.error || 'Unknown error'));
      }
      setLoading(false);
    });
  };

  const handleSkip = () => {
    if (actionRef.current || !socketService.isConnected()) return;
    actionRef.current = true;
    setLoading(true);
    socketService.skipCard((response) => {
      actionRef.current = false;
      setLoading(false);
      if (response?.success) {
        setSittingOut(true);
        if (Array.isArray(response.bids)) setBidHistory(response.bids);
        if (typeof response.minimumBid === 'number') setMinimumBid(response.minimumBid);
        if (typeof response.bidIncrement === 'number') setBidIncrement(response.bidIncrement);
      } else {
        alert('Skip failed: ' + (response?.message || response?.error || 'Unknown error'));
      }
    });
  };
  
  const handleReady = () => {
    if (actionRef.current || isReady || !socketService.isConnected()) return;
    actionRef.current = true;
    setLoading(true);
    socketService.emit('auction:player-ready', {}, (response) => {
      actionRef.current = false;
      if (response?.success && !response.spectating) {
        setIsReady(true);
      } else if (!response?.success) {
        alert('Failed to ready up: ' + (response?.message || response?.error || 'Unknown error'));
      }
      setLoading(false);
    });
  };

  useEffect(() => {
    const onState = (state) => {
      setConnectionState(state);
      if (state === 'connected' || state === 'lost' || state === 'reconnecting') {
        setIsConnecting(state === 'connecting');
      }
    };
    setConnectionState(socketService.getConnectionState());
    socketService.on('connection:state', onState);
    return () => socketService.off('connection:state', onState);
  }, []);

  const connected = connectionState === 'connected';
  const connectionLabel = connected
    ? undefined
    : connectionState === 'lost'
      ? 'Connection lost'
      : connectionState === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting';
  const retryConnection = () => socketService.connect();
  const selfId = socketService.socket?.id || playerId;
  const progressLabel = progress.index && progress.total
    ? `Card ${progress.index} of ${progress.total}`
    : '';
  const readyCount = readyTotals.count ?? readyPlayers.length;
  const readyTotal = typeof readyTotals.total === 'number' ? readyTotals.total : players.length;
  const spectating = spectatorIds.includes(selfId)
    || (typeof cheapestBid === 'number' && typeof balance === 'number' && balance < cheapestBid);
  const playerIsWatching = (player) => spectatorIds.includes(player.id)
    || (typeof cheapestBid === 'number' && typeof player.balance === 'number' && player.balance < cheapestBid);
  const readyRoster = players.length
    ? players.map((player) => ({
        id: player.id,
        username: player.username,
        you: player.id === selfId,
        status: playerIsWatching(player)
          ? 'watching'
          : (readyPlayers.some((ready) => ready.playerId === player.id) || (isReady && player.id === selfId) ? 'ready' : 'waiting')
      }))
    : readyPlayers.map((ready) => ({
        id: ready.playerId,
        username: ready.playerUsername || 'Player',
        you: ready.playerId === selfId,
        status: 'ready'
      }));
  const parsedBid = Number.parseInt(bidAmount, 10);
  let bidHint = '';
  if (bidAmount && Number.isFinite(parsedBid)) {
    if (parsedBid < minimumBid) bidHint = `Minimum bid is £${minimumBid}`;
    else if (typeof balance === 'number' && parsedBid > balance) {
      bidHint = `Above your balance of £${balance}`;
    }
  }

  useEffect(() => {
    if (!squads || !code) return;
    if (!location.pathname.startsWith('/squad/')) {
      navigate(`/squad/${code}`, { replace: true });
    }
  }, [squads, code, location.pathname, navigate]);

  const handleSquadUpdate = (payload) => {
    if (squadLock.current) {
      return Promise.resolve({ success: false, message: 'Save already in progress.' });
    }
    squadLock.current = true;
    setSquadBusy(true);
    setSquadError('');
    return new Promise((resolve) => {
      socketService.updateSquad(payload, (response) => {
        if (response?.lineup) {
          lineupRef.current = response.lineup;
          setLineup(response.lineup);
          const ownerId = socketService.socket?.id || useGameStore.getState().playerId;
          setSquads((current) => {
            if (!Array.isArray(current) || !ownerId) return current;
            return current.map((squad) => (
              squad.id === ownerId
                ? {
                    ...squad,
                    formation: response.lineup.formation,
                    confirmed: Boolean(response.lineup.confirmed),
                    strength: typeof response.lineup.evaluation?.strength === 'number'
                      ? response.lineup.evaluation.strength
                      : null
                  }
                : squad
            ));
          });
        }
        if (!response?.success) {
          setSquadError(response?.message || response?.error || 'Could not save the lineup.');
        }
        squadLock.current = false;
        setSquadBusy(false);
        resolve(response || { success: false, message: 'Could not save the lineup.' });
      });
    });
  };

  if (replaced) {
    return (
      <Screen variant="home" width="narrow" className="screen-center">
        <AuctionLoading
          code={code}
          connecting={false}
          timedOut
          message="This seat was opened in another session."
          onQuit={handleQuit}
        />
      </Screen>
    );
  }

  if (matchResult) {
    return (
      <Screen image="/stadium-main.jpg">
        <MatchResult
          code={code}
          connected={connected}
          connectionLabel={connectionLabel}
          onRetry={retryConnection}
          result={matchResult}
          onQuit={handleQuit}
        />
      </Screen>
    );
  }

  const confirmedCount = Array.isArray(squads) ? squads.filter((squad) => squad.confirmed).length : 0;

  if (squads && !reviewing) {
    return (
      <Screen image="/stadium-main.jpg" width="squad">
        {lineup ? (
          <SquadBuilder
            code={code}
            connected={connected}
            connectionLabel={connectionLabel}
            onRetry={retryConnection}
            cards={myTeam}
            lineup={lineup}
            busy={squadBusy}
            error={squadError}
            onUpdate={handleSquadUpdate}
            onReview={() => setReviewing(true)}
            onContinue={() => setReviewing(true)}
            onQuit={handleQuit}
          />
        ) : (
          <div className="stack" style={{ textAlign: 'center' }}>
            <Spinner className="loading-mark" />
            <h1 className="page-title">Loading lineup</h1>
          </div>
        )}
      </Screen>
    );
  }

  if (squads) {
    return (
      <Screen image="/stadium-main.jpg">
        <SquadResults
          code={code}
          connected={connected}
          connectionLabel={connectionLabel}
          onRetry={retryConnection}
          squads={squads}
          rematch={rematch}
          players={players}
          selfId={selfId}
          onRematch={handleRematch}
          onHome={handleHome}
          onEdit={() => setReviewing(false)}
          onLeague={() => navigate('/league')}
          onQuit={handleQuit}
          onPlay={handlePlay}
          playBusy={matchBusy}
          playError={matchError}
          confirmedCount={confirmedCount}
          departed={departed}
        />
      </Screen>
    );
  }

  if (waitingForReady && spectating) {
    return (
      <Screen image="/stadium-tunnel.jpg">
        <SpectatorBreak
          code={code}
          connected={connected}
          connectionLabel={connectionLabel}
          onRetry={retryConnection}
          progressLabel={progressLabel}
          readyCount={readyCount}
          readyTotal={readyTotal}
          roster={readyRoster}
          squads={watchSquads}
          selfId={selfId}
          onQuit={handleQuit}
        />
      </Screen>
    );
  }

  if (waitingForReady) {
    return (
      <Screen image="/stadium-tunnel.jpg" variant="home" width="room" className="screen-center">
        <ReadyGate
          code={code}
          connected={connected}
          connectionLabel={connectionLabel}
          onRetry={retryConnection}
          progressLabel={progressLabel}
          readyCount={readyCount}
          readyTotal={readyTotal}
          isReady={isReady}
          loading={loading}
          roster={readyRoster}
          onReady={handleReady}
          onQuit={handleQuit}
        />
      </Screen>
    );
  }

  if (!currentCard) {
    return (
      <Screen variant="home" width="narrow" className="screen-center">
        <AuctionLoading
          code={code}
          connecting={isConnecting && connectionState !== 'lost' && !resumeError}
          timedOut={Boolean(resumeError) || loadingTimeout || connectionState === 'lost'}
          message={resumeError || undefined}
          onRetry={connectionState === 'lost' ? retryConnection : () => window.location.reload()}
          onRoom={() => navigate(`/room/${code}`)}
          onQuit={handleQuit}
        />
      </Screen>
    );
  }

  const viewOnly = spectating ? 'watching' : sittingOut ? 'passed' : null;
  const ownWatchCards = watchSquads?.find((squad) => squad.id === selfId)?.cards;

  return (
    <Screen>
      <AuctionBoard
        code={code}
        connected={connected}
        connectionLabel={connectionLabel}
        onRetry={retryConnection}
        progressLabel={progressLabel}
        currentCard={currentCard}
        timerSeconds={timerSeconds}
        bidHistory={bidHistory}
        minimumBid={minimumBid}
        bidIncrement={bidIncrement}
        bidAmount={bidAmount}
        bidHint={bidHint}
        onBidAmount={setBidAmount}
        onIncrement={handleQuickIncrement}
        onBid={handleBid}
        onSkip={handleSkip}
        loading={loading}
        balance={balance}
        squadCount={ownWatchCards ? ownWatchCards.length : myTeam.length}
        players={Array.isArray(players) ? players : []}
        selfId={selfId}
        myTeam={myTeam}
        viewOnly={viewOnly}
        watchSquads={watchSquads}
        spectatorIds={spectatorIds}
        cheapestBid={cheapestBid}
        onQuit={handleQuit}
      />
    </Screen>
  );
}
