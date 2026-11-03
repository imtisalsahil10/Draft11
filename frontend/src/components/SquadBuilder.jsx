/**
 * TACTICAL SQUAD
 * Pitch, formation, and bench. Ratings shown here come from the server.
 */

import { useRef, useState } from 'react';
import PlayerCard from './PlayerCard';
import { QuitAuction, TopBar } from './AuctionScreens';
import { Alert, Badge, Button, Panel } from './ui';
import { FORMATIONS, SQUAD_RATING } from '@shared/squad-evaluation.js';

function cardKey(card) {
  return card?.id == null ? '' : String(card.id);
}

function findCard(cards, cardId) {
  if (cardId == null) return null;
  const key = String(cardId);
  return cards.find((card) => cardKey(card) === key) || null;
}

function compareCards(left, right) {
  const leftOverall = left?.stats?.overall;
  const rightOverall = right?.stats?.overall;
  const leftRated = typeof leftOverall === 'number';
  const rightRated = typeof rightOverall === 'number';
  if (leftRated !== rightRated) return leftRated ? -1 : 1;
  if (leftRated && rightOverall !== leftOverall) return rightOverall - leftOverall;
  return String(left?.name || '').localeCompare(String(right?.name || ''));
}

export default function SquadBuilder({
  code,
  connected,
  connectionLabel,
  onRetry,
  cards,
  lineup,
  busy,
  error,
  onUpdate,
  onReview,
  onContinue,
  onQuit,
  continueText,
  reviewText = 'Review squads'
}) {
  const [heldId, setHeldId] = useState(null);
  const [overSlot, setOverSlot] = useState(null);
  const dragging = useRef(false);
  const owned = Array.isArray(cards) ? cards : [];
  const formation = FORMATIONS[lineup.formation] || FORMATIONS['4-3-3'];
  const evaluation = lineup.evaluation;
  const held = findCard(owned, heldId);
  const assignedIds = new Set(
    (lineup.assignments || [])
      .map((slot) => (slot.cardId == null ? null : String(slot.cardId)))
      .filter(Boolean)
  );
  const bench = owned.filter((card) => !assignedIds.has(cardKey(card))).sort(compareCards);
  const placed = (lineup.assignments || [])
    .map((slot) => {
      const card = findCard(owned, slot.cardId);
      const rated = evaluation?.slots?.find((item) => item.slotId === slot.slotId);
      return card ? { slot, card, rated } : null;
    })
    .filter(Boolean);

  const save = (payload) => onUpdate({
    formation: lineup.formation,
    expectedRevision: lineup.revision,
    ...payload
  });

  const place = (slotId, cardId) => {
    if (busy || !connected || cardId == null) return;
    const next = lineup.assignments.map((slot) => {
      if (slot.slotId === slotId) return { slotId, cardId };
      if (slot.cardId != null && String(slot.cardId) === String(cardId)) {
        return { slotId: slot.slotId, cardId: null };
      }
      return { slotId: slot.slotId, cardId: slot.cardId ?? null };
    });
    setHeldId(String(cardId));
    save({ assignments: next, confirm: false });
  };

  const clearCard = (cardId) => {
    if (busy || !connected || cardId == null) return;
    const next = lineup.assignments.map((slot) => (
      slot.cardId != null && String(slot.cardId) === String(cardId)
        ? { slotId: slot.slotId, cardId: null }
        : { slotId: slot.slotId, cardId: slot.cardId ?? null }
    ));
    setHeldId(null);
    save({ assignments: next, confirm: false });
  };

  const onSlotClick = (slotId) => {
    if (dragging.current) return;
    const current = lineup.assignments.find((slot) => slot.slotId === slotId);
    if (held) {
      if (current?.cardId != null && String(current.cardId) === cardKey(held)) {
        clearCard(held.id);
        return;
      }
      place(slotId, held.id);
      return;
    }
    if (current?.cardId != null) setHeldId(String(current.cardId));
  };

  const onSlotKey = (event, slotId) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSlotClick(slotId);
  };

  const changeFormation = (id) => {
    if (busy || !connected || id === lineup.formation) return;
    setHeldId(null);
    onUpdate({
      formation: id,
      expectedRevision: lineup.revision,
      confirm: false
    });
  };

  const confirm = () => {
    if (busy || !connected || !evaluation?.complete) return;
    if (lineup.confirmed) {
      onContinue();
      return;
    }
    save({ assignments: lineup.assignments, confirm: true }).then((response) => {
      if (response?.success) onContinue();
    });
  };

  const ready = Boolean(evaluation?.complete);
  const continueLabel = continueText || (lineup.confirmed ? 'Continue' : 'Confirm lineup');

  return (
    <div className="stack stack-lg">
      <TopBar
        code={code}
        status={lineup.confirmed ? 'Lineup confirmed' : 'Building'}
        tone={lineup.confirmed ? 'good' : 'wait'}
        connected={connected}
        connectionLabel={connectionLabel}
        onRetry={onRetry}
      />

      <header className="page-header">
        <p className="eyebrow">Tactical squad</p>
        <h1>Lineup</h1>
        <p className="lede">
          Place the players you bought. A player can hold one place. Changing formation keeps every acquired player.
        </p>
      </header>

      <div className="formation-row" role="radiogroup" aria-label="Formation">
        {Object.values(FORMATIONS).map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={item.id === formation.id}
            className={item.id === formation.id ? 'btn btn-primary' : 'btn btn-secondary'}
            onClick={() => changeFormation(item.id)}
            disabled={busy || !connected}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? <Alert>{error}</Alert> : null}

      <div className="metrics" aria-live="polite">
        <div className="metric">
          <p className="metric-label">Squad strength</p>
          <p className="metric-value">{evaluation?.strength ?? '—'}</p>
          <p className="metric-note">Placed players only</p>
        </div>
        <div className="metric">
          <p className="metric-label">Places</p>
          <p className="metric-value">{evaluation?.filled ?? 0}/11</p>
          <p className="metric-note">{ready ? 'Ready to confirm' : 'Still open'}</p>
        </div>
        <div className="metric">
          <p className="metric-label">Coverage</p>
          <p className="metric-value">{evaluation?.coverage?.percent ?? 0}%</p>
          <p className="metric-note">
            {evaluation?.coverage?.natural ?? 0} natural · {evaluation?.coverage?.suitable ?? 0} suitable
          </p>
        </div>
      </div>

      <p className="lede">{evaluation?.summary}</p>

      <div className="btn-row">
        <Button onClick={confirm} disabled={!ready || busy || !connected}>
          {busy ? 'Saving' : continueLabel}
        </Button>
        <Button variant="secondary" onClick={onReview} disabled={busy}>
          {reviewText}
        </Button>
        <QuitAuction onQuit={onQuit} />
        {held ? (
          <Button variant="ghost" onClick={() => clearCard(held.id)} disabled={busy || !connected || !assignedIds.has(cardKey(held))}>
            Move {held.name} to bench
          </Button>
        ) : null}
      </div>

      <div className="squad-layout">
        <section className="panel pitch-panel" aria-busy={busy}>
          <h2 className="panel-title">{formation.label}</h2>
          <p className="field-hint">
            {held
              ? `${held.name} is selected. Choose a place, or move the player to the bench.`
              : 'Select a player, then a place. You can also drag a card onto the pitch.'}
          </p>
          <div className="pitch" aria-label={`${formation.label} pitch`}>
            <div className="pitch-lines" aria-hidden="true" />
            {formation.slots.map((slot) => {
              const assignment = lineup.assignments.find((item) => item.slotId === slot.id);
              const card = findCard(owned, assignment?.cardId);
              const rated = evaluation?.slots?.find((item) => item.slotId === slot.id);
              const selected = card && cardKey(card) === heldId;
              const label = card
                ? `${slot.role}, ${card.name}, ${rated?.fit?.label || 'unrated'}`
                : `${slot.role}, empty`;
              return (
                <div
                  key={slot.id}
                  className={[
                    'pitch-slot',
                    selected ? 'is-selected' : '',
                    overSlot === slot.id ? 'is-over' : ''
                  ].filter(Boolean).join(' ')}
                  style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  aria-pressed={selected}
                  onClick={() => onSlotClick(slot.id)}
                  onKeyDown={(event) => onSlotKey(event, slot.id)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setOverSlot(slot.id);
                  }}
                  onDragLeave={() => setOverSlot((current) => (current === slot.id ? null : current))}
                  onDrop={(event) => {
                    event.preventDefault();
                    setOverSlot(null);
                    const cardId = event.dataTransfer.getData('text/plain');
                    if (cardId) place(slot.id, cardId);
                  }}
                >
                  {card ? (
                    <div
                      draggable={!busy && connected}
                      onDragStart={(event) => {
                        dragging.current = true;
                        event.dataTransfer.setData('text/plain', cardKey(card));
                        event.dataTransfer.effectAllowed = 'move';
                        setHeldId(cardKey(card));
                      }}
                      onDragEnd={() => {
                        window.setTimeout(() => {
                          dragging.current = false;
                        }, 0);
                      }}
                    >
                      <PlayerCard card={card} size="pitch" />
                    </div>
                  ) : (
                    <div className="pitch-empty">{slot.role}</div>
                  )}
                  {card ? (
                    <span className={`fit-pip fit-${rated?.fit?.key || 'unknown'}`} title={rated?.fit?.label || 'Unrated'}>
                      <span className="sr-only">{rated?.fit?.label || 'Unrated'}</span>
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <div className="stack">
          <Panel title={held ? held.name : 'Selected player'}>
            {held ? (
              <div className="squad-selected">
                <PlayerCard card={held} size="small" />
                <p className="field-hint">
                  {held.position ? `Listed as ${held.position}` : 'Position: Unavailable'}
                  {typeof held.stats?.overall === 'number' ? ` · OVR ${held.stats.overall}` : ' · Overall: Unavailable'}
                </p>
              </div>
            ) : (
              <p className="empty-state">Select a card to inspect it.</p>
            )}
          </Panel>

          <Panel title={`Bench (${bench.length})`}>
            {bench.length === 0 ? (
              <p className="empty-state">Everyone you bought is on the pitch.</p>
            ) : (
              <div className="card-scroller">
                {bench.map((card) => {
                  const selected = cardKey(card) === heldId;
                  return (
                    <div
                      key={cardKey(card)}
                      className={`bench-card ${selected ? 'is-selected' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected}
                      aria-label={`${card.name}, bench, not assigned`}
                      draggable={!busy && connected}
                      onDragStart={(event) => {
                        dragging.current = true;
                        event.dataTransfer.setData('text/plain', cardKey(card));
                        event.dataTransfer.effectAllowed = 'move';
                        setHeldId(cardKey(card));
                      }}
                      onDragEnd={() => {
                        window.setTimeout(() => {
                          dragging.current = false;
                        }, 0);
                      }}
                      onClick={() => setHeldId(selected ? null : cardKey(card))}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        setHeldId(selected ? null : cardKey(card));
                      }}
                    >
                      <PlayerCard card={card} size="small" />
                      <Badge tone="neutral">Bench</Badge>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title={`On the pitch (${placed.length})`}>
            {placed.length === 0 ? (
              <p className="empty-state">No players assigned yet.</p>
            ) : (
              <ul className="status-list">
                {placed.map(({ slot, card, rated }) => (
                  <li key={slot.slotId} className="status-row">
                    <button
                      type="button"
                      className="squad-pick"
                      onClick={() => setHeldId(cardKey(card))}
                    >
                      <span className="status-name">{card.name}</span>
                    </button>
                    <span className={`fit-label fit-${rated?.fit?.key || 'unknown'}`}>
                      {slot.role} · {rated?.fit?.label || 'Unrated'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {evaluation?.filled > 0 && evaluation.weak?.length > 0 ? (
            <Panel title="Needs attention">
              <ul className="status-list">
                {evaluation.weak.map((item) => (
                  <li key={`${item.slotId}-${item.reason}`} className="status-row">
                    <span className="status-name">{item.role}</span>
                    <Badge tone={item.reason === 'Empty' ? 'neutral' : 'wait'}>{item.reason}</Badge>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel title="How the rating works">
            <p className="lede">{SQUAD_RATING.summary}</p>
            <ul className="rating-parts">
              <li>Position fit {Math.round(SQUAD_RATING.suitabilityWeight * 100)}%</li>
              <li>Overall {Math.round(SQUAD_RATING.overallWeight * 100)}%</li>
              <li>Role stats {Math.round(SQUAD_RATING.attributeWeight * 100)}%</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
