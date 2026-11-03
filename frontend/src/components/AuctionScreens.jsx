import { useRef, useState } from 'react';
import PlayerCard from './PlayerCard';
import { Badge, Button, Panel, Spinner, formatMoney } from './ui';

export function QuitAuction({ onQuit }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  if (!onQuit) return null;

  const stay = () => {
    if (busy) return;
    setOpen(false);
  };

  const confirm = () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    Promise.resolve(onQuit()).catch(() => {
      lock.current = false;
      setBusy(false);
    });
  };

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)} data-testid="quit-auction">
        Quit Auction
      </Button>
      {open ? (
        <div className="modal-backdrop" onClick={stay}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quit-auction-title"
            aria-describedby="quit-auction-message"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="quit-auction-title">Quit Auction?</h2>
            <p id="quit-auction-message">
              Are you sure you want to leave this auction and return to the auction home screen?
            </p>
            <div className="btn-row">
              <Button variant="secondary" onClick={stay} disabled={busy}>Stay in Auction</Button>
              <Button variant="danger" onClick={confirm} disabled={busy} data-testid="quit-auction-confirm">
                {busy ? 'Leaving' : 'Quit Auction'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function TopBar({ code, status, tone = 'neutral', connected, detail, connectionLabel, onRetry }) {
  const label = connectionLabel || (connected ? 'Connected' : 'Reconnecting');
  return (
    <>
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-mark">Draft11</span>
          <span className="topbar-code">{code}</span>
        </div>
        <div className="topbar-meta">
          {detail ? <span className="topbar-detail">{detail}</span> : null}
          <Badge tone={tone}>{status}</Badge>
          <span className="conn">
            <span className={`status-dot ${connected ? 'is-on' : ''}`} aria-hidden="true" />
            {label}
          </span>
        </div>
      </header>
      {label === 'Connection lost' ? (
        <div className="alert" role="alert">
          The connection dropped. Bids and ready checks are paused.
          {onRetry ? (
            <div className="bid-actions">
              <Button onClick={onRetry}>Retry connection</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function AuctionLoading({ code, connecting, timedOut, onRetry, onRoom, onHome, onQuit, message, retryLabel }) {
  return (
    <div className="stack" style={{ textAlign: 'center' }}>
      <TopBar
        code={code}
        status={timedOut ? 'Waiting' : 'Connecting'}
        tone="wait"
        connected={!timedOut && !connecting}
        connectionLabel={timedOut ? 'Not connected' : connecting ? 'Connecting' : 'Connected'}
      />
      <Panel>
        <div className="stack">
          {timedOut ? (
            <>
              <h1 className="page-title">{message || 'Still waiting for the auction'}</h1>
              <p>{message ? 'This window is no longer in the room.' : 'The room may not have started, or the connection dropped. You can retry, return to the room, or leave.'}</p>
              <div className="bid-actions">
                {onRetry ? <Button block onClick={onRetry}>{retryLabel || 'Retry connection'}</Button> : null}
                {onRoom ? <Button block variant="secondary" onClick={onRoom}>Back to room</Button> : null}
                {onQuit ? <QuitAuction onQuit={onQuit} /> : <Button block variant="danger" onClick={onHome}>Home</Button>}
              </div>
            </>
          ) : (
            <>
              <Spinner className="loading-mark" />
              <h1 className="page-title">{connecting ? 'Connecting' : 'Loading auction'}</h1>
              <p>Room {code}</p>
              <QuitAuction onQuit={onQuit} />
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}

export function ReadyGate({
  code,
  connected,
  connectionLabel,
  onRetry,
  progressLabel,
  readyCount,
  readyTotal,
  isReady,
  loading,
  roster,
  onReady,
  onQuit
}) {
  const everyoneReady = readyTotal > 0 && readyCount >= readyTotal;
  const countLabel = readyTotal > 0 ? `${readyCount} of ${readyTotal}` : `${readyCount}`;

  return (
    <div className="stack stack-lg">
      <TopBar code={code} status="Between cards" tone="wait" connected={connected} connectionLabel={connectionLabel} onRetry={onRetry} detail={progressLabel} />
      <Panel className="stack">
        <div className="page-header">
          <p className="eyebrow">Next card</p>
          <h1>Get ready</h1>
          <p className="ready-count" aria-live="polite">{countLabel} ready</p>
          <p>
            {everyoneReady
              ? 'Everyone is ready. The next card is on its way.'
              : 'Confirm when you are ready. The next card starts after the room is in.'}
          </p>
        </div>
        {isReady ? (
          <p>{everyoneReady ? 'Ready.' : 'You are ready. Waiting for the rest of the room.'}</p>
        ) : (
          <Button size="lg" block onClick={onReady} disabled={loading || !connected}>
            {loading ? <Spinner /> : null}
            {loading ? 'Sending' : "I'm ready"}
          </Button>
        )}
        <QuitAuction onQuit={onQuit} />
      </Panel>
      <Panel title="Room">
        {roster.length === 0 ? (
          <p className="empty-state">Waiting for player status.</p>
        ) : (
          <ul className="status-list">
            {roster.map((player) => {
              const status = player.status || (player.ready ? 'ready' : 'waiting');
              const label = status === 'ready' ? 'Ready' : status === 'watching' ? 'Watching' : 'Waiting';
              const tone = status === 'ready' ? 'good' : status === 'watching' ? 'wait' : 'neutral';
              return (
                <li key={player.id} className={`status-row ${status === 'ready' ? 'is-ready' : ''}`}>
                  <span className="status-name">{player.username}{player.you ? ' (You)' : ''}</span>
                  <Badge tone={tone}>{label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function PassedNotice({ code, connected, progressLabel }) {
  return (
    <div className="stack">
      <TopBar code={code} status="Sitting out" tone="wait" connected={connected} detail={progressLabel} />
      <Panel className="stack">
        <div className="page-header">
          <p className="eyebrow">This card</p>
          <h1>You passed</h1>
          <p>The other players can still bid or pass. The ready button appears when this card is finished.</p>
        </div>
      </Panel>
    </div>
  );
}

// Bought-card average shown before anyone is placed. A placed lineup uses
// the shared squad strength instead. Zero is a real overall.
function collectionOverall(cards) {
  const rated = (cards || []).filter((card) => (
    typeof card?.stats?.overall === 'number' && Number.isFinite(card.stats.overall)
  ));
  if (!rated.length) return '';
  const overall = Math.round(rated.reduce((sum, card) => sum + card.stats.overall, 0) / rated.length);
  return `OVR ${overall}`;
}

function squadRatingNote(squad, cards) {
  if (typeof squad?.strength === 'number') {
    return squad.formation ? `${squad.formation} · Strength ${squad.strength}` : `Strength ${squad.strength}`;
  }
  return collectionOverall(cards);
}

function squadSummary(squad) {
  const cards = squad.cards || [];
  return { cards, rating: squadRatingNote(squad, cards) };
}

export function SquadList({ squads, selfId, emptyLabel = 'No squads to show yet.' }) {
  if (!squads?.length) {
    return (
      <Panel>
        <p className="empty-state">{emptyLabel}</p>
      </Panel>
    );
  }

  return squads.map((squad) => {
    const { cards, rating } = squadSummary(squad);
    const mine = squad.id === selfId;
    return (
      <Panel key={squad.id}>
        <div className="squad-head">
          <h2>{squad.username}{mine ? ' (You)' : ''}</h2>
          <p>
            {cards.length} cards
            {rating ? ` · ${rating}` : ''}
            {typeof squad.balance === 'number' ? ` · ${formatMoney(squad.balance)} left` : ''}
          </p>
        </div>
        {cards.length === 0 ? (
          <p className="empty-state">No cards won.</p>
        ) : (
          <div className="squad-grid">
            {cards.map((card, index) => (
              card?.stats ? (
                <PlayerCard key={card.id || index} card={card} size="small" />
              ) : (
                <div key={card?.id || index} className="status-row">
                  <span className="status-name">{card?.name || 'Unknown card'}</span>
                </div>
              )
            ))}
          </div>
        )}
      </Panel>
    );
  });
}

export function SpectatorBreak({
  code,
  connected,
  connectionLabel,
  onRetry,
  progressLabel,
  readyCount,
  readyTotal,
  roster,
  squads,
  selfId,
  onQuit
}) {
  const countLabel = readyTotal > 0 ? `${readyCount} of ${readyTotal} still bidding are ready` : 'Waiting for the next card';

  return (
    <div className="stack stack-lg">
      <TopBar code={code} status="Watching" tone="wait" connected={connected} connectionLabel={connectionLabel} onRetry={onRetry} detail={progressLabel} />
      <Panel className="stack">
        <div className="page-header">
          <p className="eyebrow">Out of budget</p>
          <h1>You're watching</h1>
          <p className="ready-count" aria-live="polite">{countLabel}</p>
          <p>
            You don't have enough left to bid. The other players are still in the auction.
            You'll see each card, but you can't bid or skip.
          </p>
        </div>
      </Panel>
      <Panel title="Room">
        {roster.length === 0 ? (
          <p className="empty-state">Waiting for player status.</p>
        ) : (
          <ul className="status-list">
            {roster.map((player) => {
              const status = player.status || 'waiting';
              const label = status === 'ready' ? 'Ready' : status === 'watching' ? 'Watching' : 'Waiting';
              const tone = status === 'ready' ? 'good' : status === 'watching' ? 'wait' : 'neutral';
              return (
                <li key={player.id} className={`status-row ${status === 'ready' ? 'is-ready' : ''}`}>
                  <span className="status-name">{player.username}{player.you ? ' (You)' : ''}</span>
                  <Badge tone={tone}>{label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <SquadList squads={squads} selfId={selfId} emptyLabel="Your cards will show here as the auction continues." />
      <QuitAuction onQuit={onQuit} />
    </div>
  );
}

function cardCaption(card) {
  if (!card || card.imageCatalogue) return '';
  return [card.category, card.position].filter(Boolean).join(' · ');
}

function shownFact(value) {
  if (value == null || value === '') return 'Unavailable';
  return String(value);
}

function cardFacts(card) {
  if (!card?.imageCatalogue) return null;
  const overall = typeof card.stats?.overall === 'number' && Number.isFinite(card.stats.overall)
    ? String(card.stats.overall)
    : 'Unavailable';
  const start = `Start ${formatMoney(card.basePrice)}`;
  const stats = card.stats || {};
  const keeper = card.goalkeeping;
  const attributeKeys = keeper
    ? ['diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning']
    : ['pace', 'shooting', 'passing', 'dribbling', 'defense', 'physical'];
  const source = keeper || stats;
  const attributesIncomplete = attributeKeys.some((key) => typeof source[key] !== 'number');
  return {
    name: shownFact(card.name),
    overall,
    position: shownFact(card.position),
    nationality: shownFact(card.nationality),
    start,
    attributes: attributesIncomplete ? 'Unavailable' : null
  };
}

export function AuctionBoard({
  code,
  connected,
  connectionLabel,
  onRetry,
  progressLabel,
  currentCard,
  timerSeconds,
  bidHistory,
  minimumBid,
  bidIncrement = 5,
  bidAmount,
  bidHint,
  onBidAmount,
  onIncrement,
  onBid,
  onSkip,
  loading,
  balance,
  squadCount,
  players,
  selfId,
  myTeam,
  viewOnly = null,
  watchSquads = null,
  spectatorIds = [],
  cheapestBid = null,
  onQuit
}) {
  const leader = bidHistory[0];
  const seconds = typeof timerSeconds === 'number' ? timerSeconds : 30;
  const timerTone = seconds <= 5 ? 'is-critical' : seconds <= 10 ? 'is-hot' : '';
  const recent = bidHistory.slice(1, 5);

  return (
    <div className="stack">
      <h1 className="sr-only">Live auction, room {code}</h1>
      <TopBar
        code={code}
        status={viewOnly === 'watching' ? 'Watching' : viewOnly === 'passed' ? 'Passed' : 'Live auction'}
        tone={viewOnly ? 'wait' : 'live'}
        connected={connected}
        connectionLabel={connectionLabel}
        onRetry={onRetry}
        detail={progressLabel}
      />
      <div className="auction-grid">
        <div className="card-column">
          <div className="card-stage" style={{ backgroundImage: 'url(/auction-background.jpg)' }}>
            <div className="card-stage-shade" aria-hidden="true" />
            <PlayerCard card={currentCard} size="large" />
            {cardCaption(currentCard) ? <p className="card-caption">{cardCaption(currentCard)}</p> : null}
            {cardFacts(currentCard) ? (
              <p className="card-facts" data-testid="card-facts">
                {cardFacts(currentCard).name}
                {' · '}Overall {cardFacts(currentCard).overall}
                {' · '}{cardFacts(currentCard).position}
                {' · '}{cardFacts(currentCard).nationality}
                {' · '}{cardFacts(currentCard).start}
                {cardFacts(currentCard).attributes ? ` · Attributes ${cardFacts(currentCard).attributes}` : ''}
              </p>
            ) : null}
          </div>
        </div>

        <div className="stack">
          <div className="metrics">
            <div className={`metric ${timerTone}`} role="timer" aria-label={`Time remaining ${seconds} seconds`}>
              <p className="metric-label">Time</p>
              <p className="metric-value">{seconds}</p>
              <p className="metric-note">seconds</p>
            </div>
            <div className={`metric ${leader ? 'is-lead' : ''}`}>
              <p className="metric-label">Current bid</p>
              <p className="metric-value">{leader ? formatMoney(leader.bidAmount) : '—'}</p>
              <p className="metric-note">{leader ? leader.playerUsername : 'No bids yet'}</p>
            </div>
            <div className="metric">
              <p className="metric-label">Minimum</p>
              <p className="metric-value">{formatMoney(minimumBid)}</p>
              <p className="metric-note">Next bid</p>
            </div>
          </div>

          {recent.length > 0 && (
            <Panel title="Recent bids">
              <ul className="history">
                {recent.map((bid) => (
                  <li key={`${bid.timestamp}-${bid.playerUsername}-${bid.bidAmount}`}>
                    <span>{bid.playerUsername}</span>
                    <span className="money">{formatMoney(bid.bidAmount)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {viewOnly ? (
            <Panel title={viewOnly === 'watching' ? 'Watching' : 'You passed'}>
              <p>
                {viewOnly === 'watching'
                  ? 'Your balance is too low to bid. You can follow this card and the squads below.'
                  : 'You passed this card. Bidding continues for everyone else, and you can bid again on a later card.'}
              </p>
            </Panel>
          ) : (
          <Panel title="Your bid">
            <div className="stack">
              <div className="bid-row">
                <label className="sr-only" htmlFor="bid-amount">Bid amount</label>
                <input
                  id="bid-amount"
                  className="input input-bid"
                  type="number"
                  inputMode="numeric"
                  placeholder={String(minimumBid)}
                  value={bidAmount}
                  onChange={(event) => onBidAmount(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onBid();
                  }}
                  disabled={loading || !connected}
                  aria-describedby={bidHint ? 'bid-hint' : undefined}
                />
                <Button variant="secondary" onClick={onIncrement} disabled={loading || !connected}>
                  +£{bidIncrement}
                </Button>
              </div>
              {bidHint ? <p id="bid-hint" className="field-hint">{bidHint}</p> : null}
              <div className="bid-actions">
                <Button block onClick={onBid} disabled={loading || !connected || !bidAmount}>
                  {loading ? <Spinner /> : null}
                  {loading ? 'Placing bid' : 'Place bid'}
                </Button>
                <Button block variant="secondary" onClick={onSkip} disabled={loading || !connected}>
                  Skip card
                </Button>
              </div>
            </div>
          </Panel>
          )}

          <div className="summary-grid">
            <div className="stat">
              <p className="stat-label">Balance</p>
              <p className="stat-value">{formatMoney(typeof balance === 'number' ? balance : 1000)}</p>
            </div>
            <div className="stat">
              <p className="stat-label">Squad</p>
              <p className="stat-value">{squadCount}/11</p>
            </div>
            <div className="stat">
              <p className="stat-label">Room</p>
              <p className="stat-value">{players.length}</p>
            </div>
          </div>

          <Panel title="Players">
            {players.length === 0 ? (
              <p className="empty-state">No players yet.</p>
            ) : (
              <ul className="player-list">
                {players.map((player) => {
                  const watching = spectatorIds.includes(player.id)
                    || (typeof cheapestBid === 'number' && typeof player.balance === 'number' && player.balance < cheapestBid);
                  return (
                    <li key={player.id} className="player-row">
                      <strong>{player.username}{player.id === selfId ? ' (You)' : ''}</strong>
                      <span>
                        {player.isHost ? 'Host · ' : ''}
                        {player.isOnline === false ? 'Offline · ' : ''}
                        {watching ? 'Watching · ' : ''}
                        {formatMoney(player.balance)} · {player.teamSize}/11
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          <QuitAuction onQuit={onQuit} />
        </div>
      </div>

      {viewOnly === 'watching' ? (
        <SquadList squads={watchSquads} selfId={selfId} emptyLabel="Squads appear here as cards are won." />
      ) : myTeam.length > 0 && (
        <Panel title={`Your cards (${myTeam.length}/11)`}>
          <div className="card-scroller">
            {myTeam.map((card, index) => (
              <PlayerCard key={card.id || `${card.name}-${index}`} card={card} size="small" />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

export function MatchResult({
  code,
  connected,
  connectionLabel,
  onRetry,
  result,
  onQuit
}) {
  const matches = Array.isArray(result?.matches) ? result.matches : [];
  const standings = Array.isArray(result?.standings) ? result.standings : [];
  const featured = matches[0];

  return (
    <div className="stack stack-lg">
      <TopBar code={code} status="Match complete" tone="good" connected={connected} connectionLabel={connectionLabel} onRetry={onRetry} />
      <header className="page-header">
        <p className="eyebrow">Full time</p>
        <h1>Match result</h1>
        <p className="lede">Both sides see this result. Refreshing keeps the same score.</p>
      </header>
      {featured ? (
        <Panel>
          <p className="match-score" data-testid="match-score">
            {featured.team1.username} {featured.team1.goals} – {featured.team2.goals} {featured.team2.username}
          </p>
          <p>{featured.isDraw ? 'Draw' : `${featured.winnerUsername} won`}</p>
        </Panel>
      ) : null}
      {matches.map((match, index) => (
        <Panel key={`${match.team1.playerId}-${match.team2.playerId}-${index}`} title={matches.length > 1 ? `Match ${index + 1}` : 'Match'}>
          <p>{match.team1.username} {match.team1.goals} – {match.team2.goals} {match.team2.username}</p>
          {match.events?.length ? (
            <ul className="history">
              {match.events.map((event, eventIndex) => (
                <li key={`${event.minute}-${event.player}-${eventIndex}`}>
                  <span>{event.minute}&apos; {event.player}{event.assist ? ` (assist ${event.assist})` : ''}</span>
                  <span>{event.team}</span>
                </li>
              ))}
            </ul>
          ) : <p className="empty-state">No goals.</p>}
          {match.matchStats ? (
            <div className="metrics">
              <div className="metric">
                <p className="metric-label">Possession</p>
                <p className="metric-value">{match.matchStats.possession?.team1 ?? '—'}%</p>
                <p className="metric-note">{match.team1.username} · {match.matchStats.possession?.team2 ?? '—'}% {match.team2.username}</p>
              </div>
              <div className="metric">
                <p className="metric-label">Shots</p>
                <p className="metric-value">{match.matchStats.shots?.team1 ?? '—'}–{match.matchStats.shots?.team2 ?? '—'}</p>
                <p className="metric-note">On the match record</p>
              </div>
              <div className="metric">
                <p className="metric-label">Fouls</p>
                <p className="metric-value">{match.matchStats.fouls?.team1 ?? '—'}–{match.matchStats.fouls?.team2 ?? '—'}</p>
                <p className="metric-note">On the match record</p>
              </div>
            </div>
          ) : null}
        </Panel>
      ))}
      {standings.length > 0 ? (
        <Panel title="Table">
          <ul className="player-list">
            {standings.map((row) => (
              <li key={row.playerId || row.username} className="player-row">
                <strong>{row.username}</strong>
                <span>{row.points} pts · {row.goalsFor}-{row.goalsAgainst}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <QuitAuction onQuit={onQuit} />
    </div>
  );
}

export function SquadResults({
  code,
  connected,
  connectionLabel,
  onRetry,
  squads,
  rematch,
  players,
  selfId,
  onRematch,
  onHome,
  onEdit,
  onLeague,
  onQuit,
  onPlay,
  playBusy = false,
  playError = '',
  confirmedCount = 0,
  departed = []
}) {
  const voters = Array.isArray(rematch.voters) ? rematch.voters : [];
  const roster = [];
  (players || []).forEach((player) => {
    roster.push({
      id: player.id,
      username: player.username,
      ready: voters.some((voter) => voter.id === player.id || voter.username === player.username)
    });
  });
  voters.forEach((voter) => {
    if (!roster.some((player) => player.id === voter.id || player.username === voter.username)) {
      roster.push({ id: voter.id || voter.username, username: voter.username, ready: true });
    }
  });
  const everyone = rematch.total > 0 && rematch.voted >= rematch.total;

  return (
    <div className="stack stack-lg">
      <TopBar code={code} status="Auction complete" tone="good" connected={connected} connectionLabel={connectionLabel} onRetry={onRetry} />
      <header className="page-header">
        <p className="eyebrow">Final squads</p>
        <h1>Squads</h1>
        <p className="lede">
          The auction is over. Compare the squads, then rematch or return home.
        </p>
      </header>

      <Panel className="stack">
        <p aria-live="polite">
          {rematch.youVoted
            ? `Waiting for everyone to agree to a rematch (${rematch.voted}/${rematch.total || squads.length}).`
            : 'Rematch starts when everyone still here agrees.'}
        </p>
        {everyone ? <p>Everyone is in. Starting the rematch.</p> : null}
        {roster.length > 0 && (
          <ul className="status-list">
            {roster.map((player) => (
              <li key={player.id} className={`status-row ${player.ready ? 'is-ready' : ''}`}>
                <span className="status-name">{player.username}</span>
                <Badge tone={player.ready ? 'good' : 'neutral'}>{player.ready ? 'Rematch' : 'Waiting'}</Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="btn-row">
          <Button onClick={onRematch} disabled={rematch.youVoted || !connected}>
            {rematch.youVoted ? 'Rematch requested' : 'Rematch'}
          </Button>
          {onEdit ? <Button variant="secondary" onClick={onEdit}>Edit lineup</Button> : null}
          {onLeague ? <Button variant="secondary" onClick={onLeague}>Take squad to a league</Button> : null}
          {onPlay ? (
            <Button onClick={onPlay} disabled={playBusy || !connected || confirmedCount < 2} data-testid="play-match">
              {playBusy ? 'Playing match' : 'Play match'}
            </Button>
          ) : null}
          {onQuit ? <QuitAuction onQuit={onQuit} /> : <Button variant="secondary" onClick={onHome}>Home</Button>}
        </div>
        {confirmedCount < 2 ? (
          <p>A match starts when two players have each confirmed a lineup of 11.</p>
        ) : null}
        {playError ? <p role="alert">{playError}</p> : null}
        {departed.length > 0 ? (
          <ul className="status-list">
            {departed.map((seat) => (
              <li key={seat.username} className="status-row">
                <span className="status-name">
                  {seat.username} left. {seat.cardCount} card{seat.cardCount === 1 ? '' : 's'} stay with them.
                  {seat.squadStatus === 'abandoned' ? ' Their unfinished lineup is abandoned.' : ' Their confirmed lineup is kept and is not transferred.'}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      {squads.length === 0 ? (
        <Panel>
          <p className="empty-state">No squads to show yet.</p>
        </Panel>
      ) : squads.map((squad) => {
        const cards = squad.cards || [];
        const rating = squadRatingNote(squad, cards);
        const mine = squad.id === selfId;
        return (
          <Panel key={squad.id}>
            <div className="squad-head">
              <h2>{squad.username}{mine ? ' (You)' : ''}</h2>
              <p data-testid={mine ? 'own-squad-summary' : undefined}>
                {cards.length} cards
                {rating ? ` · ${rating}` : ''}
                {typeof squad.balance === 'number' ? ` · ${formatMoney(squad.balance)} left` : ''}
              </p>
            </div>
            {cards.length === 0 ? (
              <p className="empty-state">No cards won.</p>
            ) : (
              <div className="squad-grid">
                {cards.map((card, index) => (
                  card?.stats ? (
                    <PlayerCard key={card.id || index} card={card} size="small" />
                  ) : (
                    <div key={card?.id || index} className="status-row">
                      <span className="status-name">{card?.name || 'Unknown card'}</span>
                    </div>
                  )
                ))}
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
