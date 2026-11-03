/**
 * PLAYER CARD
 * Rating, name, and stat numbers are drawn on top of the rarity frame.
 * A photo is optional. The frame stays the fallback, and a failed image
 * stays inside the same absolute box.
 */

import { useEffect, useState } from 'react';
import { playerCardArtUrl, shouldShowCardArt } from '@shared/player-card-art.js';
import { displayClub, playerPhotoUrl } from '@shared/player-photo.js';

const FRAMES = {
  LEGENDARY: '/cards/legendary.jpg',
  RARE: '/cards/rare.jpg',
  BASIC: '/cards/basic.jpg'
};

const LAYOUT = {
  LEGENDARY: {
    ink: '#3d2b16',
    name: '#24180f',
    ovrTop: '15%',
    nameTop: '42%',
    rows: ['64.8%', '70.6%', '75.8%'],
    left: '14%',
    right: '50%'
  },
  RARE: {
    ink: '#f6e2a2',
    name: '#ffffff',
    ovrTop: '14%',
    nameTop: '42%',
    rows: ['67.2%', '73.2%', '79.2%'],
    left: '11%',
    right: '49%'
  },
  BASIC: {
    ink: '#ffffff',
    name: '#ffffff',
    ovrTop: '12%',
    nameTop: '33%',
    rows: ['69.6%', '75.4%', '81.2%'],
    left: '12%',
    right: '50%'
  }
};

function normalizeCategory(category) {
  const key = String(category || 'BASIC').toUpperCase();
  if (key.startsWith('LEGEND')) return 'LEGENDARY';
  if (key.startsWith('RARE')) return 'RARE';
  return 'BASIC';
}

function primaryPosition(position) {
  const token = String(position || '').trim().split(/[\s,]+/)[0];
  return token || '';
}

function photoSource(card, photosEnabled) {
  const enabled = photosEnabled ?? import.meta.env.VITE_PLAYER_PHOTOS === '1';
  return playerPhotoUrl(card, { photosEnabled: enabled });
}

function artSource(card, cardArtEnabled) {
  const enabled = cardArtEnabled ?? import.meta.env.VITE_PLAYER_CARD_ART === '1';
  return playerCardArtUrl(card, { cardArtEnabled: enabled || card?.imageCatalogue === true });
}

function goalkeepingValues(goalkeeping) {
  const stats = goalkeeping || {};
  return [stats.diving, stats.handling, stats.kicking, stats.reflexes, stats.speed, stats.positioning];
}

export default function PlayerCard({ card, size = 'large', photosEnabled, cardArtEnabled, onArtStatus }) {
  const photo = photoSource(card, photosEnabled);
  const art = artSource(card, cardArtEnabled);
  const [failedUrl, setFailedUrl] = useState('');
  const [loadedUrl, setLoadedUrl] = useState('');
  const [artFailed, setArtFailed] = useState('');
  const [artLoaded, setArtLoaded] = useState('');
  const artBroken = Boolean(art) && artFailed === art;
  const artReady = Boolean(art) && artLoaded === art && !artBroken;
  const artStatus = !art
    ? (card?.cardArtExpected ? 'missing' : 'none')
    : (artBroken ? 'broken' : (artReady ? 'shown' : 'loading'));

  useEffect(() => {
    if (!onArtStatus || !card) return;
    if (artStatus === 'shown' || artStatus === 'broken' || artStatus === 'missing') {
      onArtStatus(card, artStatus);
    }
  }, [artStatus, card, onArtStatus]);

  if (!card) return null;

  const category = normalizeCategory(card.category);
  const layout = LAYOUT[category];
  const stats = card.stats || {};
  const isGoalkeeper = primaryPosition(card.position) === 'GK' && card.goalkeeping;
  const values = isGoalkeeper
    ? goalkeepingValues(card.goalkeeping)
    : [
      stats.pace,
      stats.shooting,
      stats.passing,
      stats.dribbling ?? stats.overall,
      stats.defense,
      stats.physical
    ];
  const position = primaryPosition(card.position);
  const club = displayClub(card.club);
  const league = typeof card.league === 'string' ? card.league.trim() : '';
  const broken = Boolean(photo) && failedUrl === photo;
  const shown = Boolean(photo) && loadedUrl === photo && !broken;
  const photoState = !photo || broken ? 'fallback' : (shown ? 'shown' : 'loading');
  const showArt = shouldShowCardArt(art, artFailed);

  return (
    <div
      className={`pcard pcard-${size}`}
      role="img"
      data-card-id={card.id ?? ''}
      data-name={card.name || ''}
      data-club={club}
      data-league={league}
      data-dataset={card.dataset === 'fifa' ? 'fifa' : ''}
      data-photo={photoState}
      data-card-art={artReady ? 'shown' : 'fallback'}
      data-art-status={artStatus}
      data-overall={stats.overall ?? ''}
      data-pace={stats.pace ?? ''}
      data-shooting={stats.shooting ?? ''}
      data-passing={stats.passing ?? ''}
      data-defense={stats.defense ?? ''}
      data-physical={stats.physical ?? ''}
      aria-label={`${card.name || 'Player'}, ${stats.overall ?? 'unrated'} overall${position ? `, ${position}` : ''}${club ? `, ${club}` : ''}`}
      style={{
        '--ink': layout.ink,
        '--name-color': layout.name,
        '--ovr-top': layout.ovrTop,
        '--name-top': layout.nameTop,
        '--left': layout.left,
        '--right': layout.right,
        '--row-0': layout.rows[0],
        '--row-1': layout.rows[1],
        '--row-2': layout.rows[2]
      }}
    >
      {showArt ? (
        <img
          className="pcard-art"
          src={art}
          alt=""
          draggable="false"
          decoding="async"
          loading="lazy"
          onLoad={() => setArtLoaded(art)}
          onError={() => setArtFailed(art)}
        />
      ) : null}
      {showArt ? null : <img className="pcard-frame" src={FRAMES[category]} alt="" draggable="false" />}
      {artStatus === 'broken' || artStatus === 'missing' ? (
        <p className="pcard-art-note">{artStatus === 'broken' ? 'Image unavailable' : 'No card image'}</p>
      ) : null}
      {showArt || !photo ? null : (
        <div className="pcard-photo-well">
          <div className="pcard-photo-fallback" />
          {broken ? null : (
            <img
              className="pcard-photo"
              src={photo}
              alt=""
              draggable="false"
              referrerPolicy="no-referrer"
              onLoad={() => setLoadedUrl(photo)}
              onError={() => setFailedUrl(photo)}
            />
          )}
        </div>
      )}

      {showArt ? null : <div className="pcard-ovr">
        {stats.overall ?? ''}
        <div className="pcard-pos">{position}</div>
      </div>}

      {showArt ? null : <div className="pcard-name">{card.name}</div>}
      {showArt || !club ? null : <div className="pcard-club">{club}</div>}
      {showArt || !league ? null : <div className="pcard-league">{league}</div>}
      {showArt || card.dataset !== 'fifa' ? null : <div className="pcard-dataset">FIFA</div>}

      {showArt ? null : values.map((value, index) => (
        <div
          key={index}
          className={`pcard-stat ${index < 3 ? 'is-left' : 'is-right'}`}
          data-row={index % 3}
        >
          {value ?? '–'}
        </div>
      ))}
    </div>
  );
}
