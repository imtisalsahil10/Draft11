/**
 * LOCAL IMAGE CATALOGUE
 * Browse, select, and place the imported card images. This page does not
 * The selected cards on this page are the live auction pool.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PlayerCard from '../components/PlayerCard';
import SquadBuilder from '../components/SquadBuilder';
import { Alert, Button, Panel, Screen } from '../components/ui';
import apiService from '../services/api';
import { applyLineupChange, presentLineup } from '@shared/squad-evaluation.js';

function shown(value, whenMissing) {
  if (value == null || value === '') return whenMissing;
  return String(value);
}

function attributeLine(player) {
  const missing = 'Unavailable';
  if (player.goalkeeping) {
    const keeper = player.goalkeeping;
    return `DIV ${keeper.diving ?? missing}  HAN ${keeper.handling ?? missing}  KIC ${keeper.kicking ?? missing}  REF ${keeper.reflexes ?? missing}  SPE ${keeper.speed ?? missing}  POS ${keeper.positioning ?? missing}`;
  }
  const stats = player.stats || {};
  return `PAC ${stats.pace ?? missing}  SHO ${stats.shooting ?? missing}  PAS ${stats.passing ?? missing}  DRI ${stats.dribbling ?? missing}  DEF ${stats.defense ?? missing}  PHY ${stats.physical ?? missing}`;
}

function blankLineup() {
  return presentLineup([], { formation: '4-3-3', revision: 0 });
}

function uniqueById(list) {
  const seen = new Set();
  const players = [];
  for (const player of list) {
    const id = player?.id;
    if (id == null || id === '' || seen.has(id)) continue;
    seen.add(id);
    players.push(player);
  }
  return players;
}

export default function CataloguePage() {
  const navigate = useNavigate();
  const [players, setPlayers] = useState([]);
  const [audit, setAudit] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [focusId, setFocusId] = useState('');
  const [owned, setOwned] = useState([]);
  const [lineup, setLineup] = useState(blankLineup);
  const [fallbacks, setFallbacks] = useState([]);

  useEffect(() => {
    let cancelled = false;
    apiService.getLocalCatalogue()
      .then((body) => {
        if (cancelled) return;
        const list = uniqueById(Array.isArray(body?.players) ? body.players : []);
        setPlayers(list);
        setAudit(body?.audit || null);
        setFocusId(list[0]?.id || '');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'The local catalogue could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reportArt = useCallback((card, status) => {
    setFallbacks((current) => {
      const id = card?.id;
      if (!id) return current;
      if (status === 'shown') {
        return current.some((item) => item.id === id) ? current.filter((item) => item.id !== id) : current;
      }
      if (current.some((item) => item.id === id && item.status === status)) return current;
      return [...current.filter((item) => item.id !== id), { id, name: card.name, status }];
    });
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return players;
    return players.filter((player) => (
      String(player.name || '').toLowerCase().includes(needle)
      || String(player.position || '').toLowerCase().includes(needle)
      || String(player.id || '').toLowerCase().includes(needle)
    ));
  }, [players, query]);

  const focused = players.find((player) => player.id === focusId) || null;

  const addFocused = () => {
    if (!focused) return;
    setOwned((current) => (
      current.some((player) => player.id === focused.id) ? current : [...current, focused]
    ));
  };

  useEffect(() => {
    setLineup((current) => presentLineup(owned, current));
  }, [owned]);

  const onLineup = (change) => {
    const result = applyLineupChange({
      ownedCards: owned,
      lineup,
      formation: change.formation,
      assignments: change.assignments,
      expectedRevision: change.expectedRevision,
      confirm: false
    });
    if (result.ok) setLineup(result.lineup);
  };

  return (
    <Screen width="squad">
      <main className="catalogue-page">
        <div className="btn-row">
          <Button variant="secondary" onClick={() => navigate('/')}>Home</Button>
        </div>
        <div>
          <p className="eyebrow">Local catalogue</p>
          <h1>Player cards</h1>
          <p className="lede">
            Each player uses the selected card image. These cards are the live auction pool.
          </p>
        </div>

        {error ? <Alert>{error}</Alert> : null}

        <div className="catalogue-browser">
          <Panel title="Catalogue">
            <p data-testid="catalogue-count">{players.length} players</p>
            <p data-testid="catalogue-served">
              {audit ? `${audit.imagesServed} card images on disk` : 'Checking images'}
            </p>
            <label className="field" htmlFor="catalogue-search">
              Search
              <input
                id="catalogue-search"
                className="input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, position, or id"
              />
            </label>
            <p data-testid="visible-count">{visible.length} shown</p>
            <div className="catalogue-grid" data-testid="catalogue-grid">
              {visible.map((player) => (
                <button
                  key={player.id}
                  type="button"
                  className={`catalogue-cell ${player.id === focusId ? 'is-selected' : ''}`}
                  data-testid="catalogue-card"
                  data-player-id={player.id}
                  data-art={player.cardArtUrl || ''}
                  aria-pressed={player.id === focusId}
                  onClick={() => setFocusId(player.id)}
                >
                  <PlayerCard card={player} size="small" onArtStatus={reportArt} />
                  <span className="catalogue-caption" data-testid="card-caption">
                    <strong>{player.name}</strong>
                    <span>{[player.stats?.overall, player.position].filter((value) => value != null && value !== '').join(' ') || 'Unavailable'}</span>
                  </span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Player details">
          {focused ? (
            <div className="catalogue-detail" data-testid="player-detail">
              <PlayerCard card={focused} size="large" onArtStatus={reportArt} />
              <div className="stack">
                <p data-testid="detail-name">{focused.name}</p>
                <p data-testid="detail-overall">{shown(focused.stats?.overall, 'Unavailable')}</p>
                <p data-testid="detail-position">{shown(focused.position, 'Unavailable')}</p>
                <p data-testid="detail-nationality">{shown(focused.nationality, focused.flagOnCard ? 'Flag on card' : 'Unavailable')}</p>
                <p data-testid="detail-club">{shown(focused.club, focused.crestOnCard ? 'Club crest on card' : 'Unavailable')}</p>
                <p data-testid="detail-attributes">{attributeLine(focused)}</p>
                <p>League: {shown(focused.league, 'Not on card')}</p>
                <p data-testid="detail-art">{focused.cardArtUrl || 'No card image'}</p>
                <Button data-testid="add-to-squad" onClick={addFocused}>Add to squad</Button>
              </div>
            </div>
          ) : (
            <p className="empty-state">No player is selected.</p>
          )}
          </Panel>
        </div>

        <Panel title="Auction card">
          <div data-testid="auction-card">
            {focused ? <PlayerCard card={focused} size="large" onArtStatus={reportArt} /> : <p className="empty-state">No auction card selected.</p>}
          </div>
        </Panel>

        <Panel title="Selected players">
          {owned.length === 0 ? (
            <p className="empty-state" data-testid="selection-empty">No players selected.</p>
          ) : (
            <div className="selection-tray" data-testid="selection-tray">
              {owned.map((player) => (
                <PlayerCard key={player.id} card={player} size="small" onArtStatus={reportArt} />
              ))}
            </div>
          )}
        </Panel>

        <section data-testid="squad-display">
          {owned.length === 0 ? (
            <Panel title="Squad">
              <p className="empty-state">Add a player to place them on the squad.</p>
            </Panel>
          ) : (
            <SquadBuilder
              code="LOCAL"
              connected
              connectionLabel="Local catalogue"
              cards={owned}
              lineup={lineup}
              busy={false}
              error=""
              onUpdate={onLineup}
              onReview={() => {}}
              onContinue={() => {}}
              continueText="Local squad"
            />
          )}
        </section>

        <Panel title="Image fallbacks">
          <div data-testid="art-fallbacks">
            {fallbacks.length === 0 ? (
              <p>No fallback cards.</p>
            ) : (
              <ul>
                {fallbacks.map((item) => (
                  <li key={item.id} data-testid="art-fallback">
                    {item.name} ({item.id}) — {item.status === 'broken' ? 'Image unavailable' : 'No card image'}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      </main>
    </Screen>
  );
}
