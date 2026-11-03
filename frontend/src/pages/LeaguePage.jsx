/**
 * LEAGUE
 * Create or join a league, confirm a fixture XI, and ask the server to
 * simulate it. Scores shown here come from the saved fixture, not from
 * this browser.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import SquadBuilder from '../components/SquadBuilder';
import { displayClub } from '@shared/player-photo.js';
import { Alert, Badge, Button, Panel, Screen, Spinner, TextField } from '../components/ui';
import socketService from '../services/socket';

const SESSION_KEY = 'draft11-league';
const LIVE_EVENTS = [
  'league:fixture:updated',
  'league:round:advanced',
  'league:completed',
  'league:standings',
  'league:members',
  'league:fixture',
  'league:match-completed'
];

const PHASE_LABEL = {
  awaiting_lineups: 'Awaiting lineups',
  ready: 'Ready to simulate',
  simulating: 'Simulating',
  completed: 'Completed'
};

const STATUS_LABEL = {
  forming: 'Forming',
  active: 'In season',
  completed: 'Season complete'
};

function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function writeSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    leagueId: session.leagueId,
    memberId: session.memberId,
    memberToken: session.memberToken
  }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function auctionSeatToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('draft11-session') || 'null');
    return typeof saved?.seatToken === 'string' && saved.seatToken ? saved.seatToken : '';
  } catch {
    return '';
  }
}

function ask(event, payload) {
  return new Promise((resolve) => {
    socketService.emit(event, payload, (response) => resolve(response || {
      success: false,
      message: 'The server did not answer.'
    }));
  });
}

function managerName(league, memberId) {
  return league.members.find((member) => member.memberId === memberId)?.displayName || 'Manager';
}

function phaseTone(phase) {
  if (phase === 'completed' || phase === 'ready') return 'good';
  if (phase === 'simulating' || phase === 'awaiting_lineups') return 'wait';
  return 'neutral';
}

export default function LeaguePage() {
  const navigate = useNavigate();
  const { leagueId } = useParams();
  const [league, setLeague] = useState(null);
  const [leagueName, setLeagueName] = useState('');
  const [manager, setManager] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [connected, setConnected] = useState(socketService.isConnected());

  useEffect(() => {
    let alive = true;
    socketService.connect();

    const pull = () => {
      const session = readSession();
      if (!session?.memberToken) return;
      if (leagueId && session.leagueId !== leagueId) return;
      ask('league:subscribe', session).then((response) => {
        if (!alive) return;
        if (response?.success) {
          setLeague(response.league);
          setError('');
          if (!leagueId) navigate(`/league/${response.league.leagueId}`, { replace: true });
          return;
        }
        if (response?.error === 'CONNECTION_LOST') return;
        setError(response?.message || 'Could not load this league.');
      });
    };

    pull();
    const onState = (state) => {
      if (!alive) return;
      setConnected(state === 'connected');
      if (state === 'connected') pull();
    };
    const onLive = () => pull();
    socketService.on('connection:state', onState);
    for (const event of LIVE_EVENTS) socketService.on(event, onLive);
    return () => {
      alive = false;
      socketService.off('connection:state', onState);
      for (const event of LIVE_EVENTS) socketService.off(event, onLive);
    };
  }, [leagueId, navigate]);

  const session = () => {
    const saved = readSession();
    if (!saved?.memberToken) return null;
    if (leagueId && saved.leagueId !== leagueId) return null;
    return saved;
  };

  const run = async (label, event, extra = {}) => {
    const saved = session();
    if (!saved || busy) return null;
    setBusy(label);
    setError('');
    const response = await ask(event, { ...saved, ...extra });
    setBusy('');
    if (!response?.success) {
      setError(response?.message || 'That did not work.');
      if (response?.league) setLeague(response.league);
      return response;
    }
    if (response.league) setLeague(response.league);
    return response;
  };

  const createLeague = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy('create');
    setError('');
    const response = await ask('league:create', {
      name: leagueName,
      displayName: manager
    });
    setBusy('');
    if (!response?.success) {
      setError(response?.message || 'Could not create the league.');
      return;
    }
    writeSession({
      leagueId: response.league.leagueId,
      memberId: response.memberId,
      memberToken: response.memberToken
    });
    setLeague(response.league);
    navigate(`/league/${response.league.leagueId}`);
  };

  const joinLeague = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy('join');
    setError('');
    const response = await ask('league:join', {
      inviteCode,
      displayName: manager
    });
    setBusy('');
    if (!response?.success) {
      setError(response?.message || 'Could not join the league.');
      return;
    }
    writeSession({
      leagueId: response.league.leagueId,
      memberId: response.memberId,
      memberToken: response.memberToken
    });
    setLeague(response.league);
    navigate(`/league/${response.league.leagueId}`);
  };

  const forget = () => {
    clearSession();
    setLeague(null);
    setEditing(false);
    navigate('/league');
  };

  if (!league) {
    return (
      <Screen image="/stadium-main.jpg" variant="home" width="narrow" className="screen-center">
        <main className="stack stack-lg">
          <div className="hero-copy">
            <p className="eyebrow">Draft11</p>
            <h1>League</h1>
            <p className="lede">
              Invite managers, confirm both starting XIs, and let the server play the fixture.
            </p>
            {auctionSeatToken() ? (
              <p className="lede">
                This browser still holds an auction seat. Enter the league, then register that squad.
              </p>
            ) : null}
          </div>
          <TextField
            id="manager-name"
            label="Manager name"
            value={manager}
            onChange={(input) => setManager(input.target.value)}
            maxLength={20}
            disabled={Boolean(busy)}
          />
          <Panel className="panel-accent" title="Create a league">
            <form className="stack" onSubmit={createLeague}>
              <TextField
                id="league-name"
                label="League name"
                value={leagueName}
                onChange={(input) => setLeagueName(input.target.value)}
                maxLength={40}
                disabled={Boolean(busy)}
              />
              <Button type="submit" block disabled={Boolean(busy)}>
                {busy === 'create' ? <Spinner /> : null}
                {busy === 'create' ? 'Creating league' : 'Create league'}
              </Button>
            </form>
          </Panel>
          <Panel title="Join with an invite">
            <form className="stack" onSubmit={joinLeague}>
              <TextField
                id="invite-code"
                label="Invite code"
                value={inviteCode}
                onChange={(input) => setInviteCode(input.target.value)}
                disabled={Boolean(busy)}
                autoComplete="off"
                spellCheck="false"
              />
              <Button type="submit" variant="secondary" block disabled={Boolean(busy)}>
                {busy === 'join' ? <Spinner /> : null}
                {busy === 'join' ? 'Joining league' : 'Join league'}
              </Button>
            </form>
          </Panel>
          {error ? <Alert>{error}</Alert> : null}
          <Button variant="ghost" onClick={() => navigate('/')}>Back to rooms</Button>
        </main>
      </Screen>
    );
  }

  const you = league.you;
  const mine = league.fixtures.find((fixture) => (
    fixture.round === league.currentRound
    && (fixture.homeMemberId === you.memberId || fixture.awayMemberId === you.memberId)
  ));
  const myConfirmation = mine?.confirmations?.find((item) => item.memberId === you.memberId);
  const canSimulate = Boolean(mine && mine.phase === 'ready' && !busy);
  const squad = you.squad;
  const lineup = squad?.lineup;

  const saveLineup = (payload) => {
    const saved = session();
    if (!saved) return Promise.resolve({ success: false, message: 'Join the league again.' });
    setBusy('lineup');
    setError('');
    return ask('league:lineup:update', { ...saved, ...payload }).then((response) => {
      setBusy('');
      if (response?.league) setLeague(response.league);
      if (!response?.success) setError(response?.message || 'Could not save the lineup.');
      return response;
    });
  };

  return (
    <Screen image="/stadium-main.jpg" width="wide">
      <main className="stack stack-lg">
        <header className="page-header">
          <p className="eyebrow">Draft11 league</p>
          <h1>{league.name}</h1>
          <p className="lede">
            {STATUS_LABEL[league.status] || league.status}
            {' · '}
            <span data-testid="league-round">Round {league.currentRound || '—'}</span>
            {' · '}
            {you.displayName}
            {connected ? '' : ' · Reconnecting'}
          </p>
        </header>

        <div className="btn-row">
          {league.status === 'forming' && you.role === 'admin' ? (
            <Button onClick={() => run('schedule', 'league:schedule')} disabled={Boolean(busy)}>
              {busy === 'schedule' ? 'Scheduling' : 'Schedule season'}
            </Button>
          ) : null}
          {!squad ? (
            auctionSeatToken() ? (
              <Button
                onClick={() => run('auction', 'league:squad:link-auction', { seatToken: auctionSeatToken() })}
                disabled={Boolean(busy)}
              >
                {busy === 'auction' ? 'Registering auction squad' : 'Register auction squad'}
              </Button>
            ) : (
              <p className="lede">Finish an auction in this browser, then register that squad.</p>
            )
          ) : (
            <Button variant="secondary" onClick={() => setEditing((open) => !open)} disabled={Boolean(busy) && busy !== 'lineup'}>
              {editing ? 'Close lineup' : 'Edit lineup'}
            </Button>
          )}
          <Button variant="ghost" onClick={forget}>Use another league</Button>
        </div>

        {league.inviteCode ? (
          <p className="lede">
            Invite code <strong data-testid="league-invite">{league.inviteCode}</strong>
          </p>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
        {league.status === 'completed' ? (
          <Alert>The season is complete. Standings are final.</Alert>
        ) : null}
        {league.currentRound > 1 && league.status === 'active' ? (
          <p className="lede">Round {league.currentRound} is now open.</p>
        ) : null}

        {editing && lineup ? (
          <SquadBuilder
            code={league.name}
            connected={connected}
            connectionLabel={connected ? 'Live' : 'Reconnecting'}
            onRetry={() => socketService.connect()}
            cards={squad.cards}
            lineup={lineup}
            busy={busy === 'lineup' || busy === 'confirm'}
            error=""
            continueText="Confirm XI for this match"
            reviewText="Back to league"
            onUpdate={saveLineup}
            onReview={() => setEditing(false)}
            onContinue={() => {
              if (!mine) return;
              run('confirm', 'league:fixture:confirm-lineup', { fixtureId: mine.fixtureId }).then((response) => {
                if (response?.success) setEditing(false);
              });
            }}
          />
        ) : (
          <div className="league-layout">
            <div className="stack">
              <Panel title={mine ? 'Your match' : 'This round'}>
                {league.status === 'forming' ? (
                  <p className="empty-state">Schedule the season after every manager has joined.</p>
                ) : null}
                {league.status !== 'forming' && !mine ? (
                  <p className="empty-state">You have a bye this round.</p>
                ) : null}
                {mine ? (
                  <div className="stack">
                    <div className={`league-row is-current`}>
                      <div>
                        <p>{managerName(league, mine.homeMemberId)} vs {managerName(league, mine.awayMemberId)}</p>
                        <p className="league-meta">Round {mine.round}</p>
                      </div>
                      <Badge tone={phaseTone(mine.phase)}>{PHASE_LABEL[mine.phase] || mine.phase}</Badge>
                    </div>
                    {mine.result ? (
                      <p className="league-score" aria-label="Match score">
                        {mine.result.homeGoals}–{mine.result.awayGoals}
                      </p>
                    ) : (
                      <p className="league-meta">No result yet.</p>
                    )}
                    <ul className="status-list">
                      {mine.confirmations.map((item) => (
                        <li key={item.memberId} className="status-row">
                          <span className="status-name">{managerName(league, item.memberId)}</span>
                          <Badge tone={item.confirmed ? 'good' : 'wait'}>
                            {item.confirmed ? 'XI confirmed' : 'XI not confirmed'}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                    {mine.result?.events?.length ? (
                      <ul className="status-list">
                        {mine.result.events.map((event, index) => (
                          <li key={`${event.minute}-${event.player}-${index}`} className="status-row">
                            <span className="status-name">{event.minute}&apos; {event.player}</span>
                            <span className="league-meta">{event.team}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {mine.phase !== 'completed' ? (
                      <div className="btn-row">
                        <Button
                          onClick={() => run('confirm', 'league:fixture:confirm-lineup', {
                            fixtureId: mine.fixtureId,
                            expectedRevision: lineup?.revision
                          })}
                          disabled={!squad || Boolean(busy) || mine.phase === 'simulating' || myConfirmation?.confirmed}
                        >
                          {busy === 'confirm' ? 'Confirming' : 'Confirm XI for this match'}
                        </Button>
                        <Button
                          onClick={() => run('simulate', 'league:fixture:simulate', { fixtureId: mine.fixtureId })}
                          disabled={!canSimulate}
                        >
                          {busy === 'simulate' || mine.phase === 'simulating' ? 'Simulating' : 'Simulate match'}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="secondary"
                        onClick={() => run('simulate', 'league:fixture:simulate', { fixtureId: mine.fixtureId })}
                        disabled={Boolean(busy)}
                      >
                        {busy === 'simulate' ? 'Checking result' : 'Simulate match'}
                      </Button>
                    )}
                  </div>
                ) : null}
              </Panel>

              <Panel title="Fixtures">
                {league.fixtures.length === 0 ? (
                  <p className="empty-state">No fixtures yet.</p>
                ) : (
                  <div className="league-list">
                    {league.fixtures.map((fixture) => (
                      <div
                        key={fixture.fixtureId}
                        className={`league-row ${fixture.fixtureId === mine?.fixtureId ? 'is-current' : ''}`}
                      >
                        <div>
                          <p>{managerName(league, fixture.homeMemberId)} vs {managerName(league, fixture.awayMemberId)}</p>
                          <p className="league-meta">Round {fixture.round}</p>
                        </div>
                        <span className="league-meta">
                          {fixture.result
                            ? `${fixture.result.homeGoals}–${fixture.result.awayGoals}`
                            : (PHASE_LABEL[fixture.phase] || fixture.phase)}
                        </span>
                        {fixture.result ? (
                          <Button
                            variant="ghost"
                            onClick={() => run('simulate', 'league:fixture:simulate', { fixtureId: fixture.fixtureId })}
                            disabled={Boolean(busy)}
                          >
                            Show saved result
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            <div className="stack">
              <Panel title="Standings">
                {league.standings.length === 0 ? (
                  <p className="empty-state">Standings appear after the first result.</p>
                ) : (
                  <div className="league-list">
                    {league.standings.map((row) => (
                      <div key={row.memberId} className="league-row">
                        <div>
                          <p>{row.rank}. {row.displayName}</p>
                          <p className="league-meta">
                            P{row.played} W{row.won} D{row.drawn} L{row.lost} GD {row.goalDifference} GF {row.goalsFor}
                          </p>
                        </div>
                        <strong>{row.points} pts</strong>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
              <Panel title="Managers">
                <ul className="status-list">
                  {league.members.filter((member) => member.status === 'active').map((member) => (
                    <li key={member.memberId} className="status-row">
                      <span className="status-name">{member.displayName}</span>
                      <Badge tone={member.squad ? 'good' : 'neutral'}>
                        {member.squad ? `${member.squad.cards.length} players` : 'No squad'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </Panel>
              {squad ? (
                <Panel title="Your squad">
                  <ul className="status-list" data-testid="league-squad">
                    {squad.cards.map((card) => (
                      <li
                        key={card.id}
                        className="status-row"
                        data-card-id={card.id}
                        data-name={card.name}
                        data-overall={card.stats?.overall ?? ''}
                        data-pace={card.stats?.pace ?? ''}
                        data-shooting={card.stats?.shooting ?? ''}
                        data-passing={card.stats?.passing ?? ''}
                        data-defense={card.stats?.defense ?? ''}
                        data-physical={card.stats?.physical ?? ''}
                      >
                        <span className="status-name">{card.name}</span>
                        {displayClub(card.club) ? <span className="league-meta">{displayClub(card.club)}</span> : null}
                        <span className="league-meta">OVR {card.stats?.overall ?? '—'}</span>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
              {squad ? (
                <Panel title="Your XI">
                  <ul className="status-list">
                    {lineup.assignments.filter((slot) => slot.cardId).map((slot) => {
                      const card = squad.cards.find((item) => String(item.id) === String(slot.cardId));
                      return (
                        <li key={slot.slotId} className="status-row">
                          <span className="status-name">{card?.name || 'Player'}</span>
                          <span className="league-meta">{slot.slotId}</span>
                        </li>
                      );
                    })}
                  </ul>
                </Panel>
              ) : null}
            </div>
          </div>
        )}
      </main>
    </Screen>
  );
}
