/**
 * CARD LAB
 * Loaded only when VITE_CARD_LAB=1. It exercises the real PlayerCard with
 * a local photo, without one, with photos switched off, with a broken file,
 * with an unapproved file, and with a remote URL. It does not fetch images.
 */

import PlayerCard from '../components/PlayerCard';
import { displayClub } from '@shared/player-photo.js';

const STATS = {
  pace: 80,
  shooting: 82,
  passing: 74,
  defense: 40,
  physical: 76,
  overall: 84
};

const shown = {
  id: 'lab-shown',
  name: 'Alex Alpha',
  position: 'ST',
  category: 'BASIC',
  club: 'Manchester United',
  photoApproved: true,
  photoUrl: '/player-images/276.png',
  stats: STATS
};

const missing = {
  id: 'lab-missing',
  name: 'Bea Beta',
  position: 'GK',
  category: 'RARE',
  club: '513',
  stats: { ...STATS, overall: 79 }
};

const disabled = {
  ...shown,
  id: 'lab-disabled',
  name: 'Casey Cole',
  photoUrl: '/player-images/999.png'
};

const broken = {
  ...shown,
  id: 'lab-broken',
  name: 'Dana Drew',
  photoUrl: '/player-images/404.png'
};

const unapproved = {
  ...shown,
  id: 'lab-unapproved',
  name: 'Fran Fell',
  photoApproved: false
};

const remote = {
  ...shown,
  id: 'lab-remote',
  name: 'Evan Edge',
  photoUrl: 'https://evil.example/a.png'
};

export default function CardLabPage() {
  const namedClub = displayClub('Arsenal');
  const numericClub = displayClub('513');
  return (
    <main className="card-lab">
      <h1>Player cards</h1>
      <div className="card-lab-row">
        <div data-testid="photo-shown">
          <PlayerCard card={shown} size="large" photosEnabled />
        </div>
        <div data-testid="photo-missing">
          <PlayerCard card={missing} size="large" photosEnabled />
        </div>
        <div data-testid="photo-disabled">
          <PlayerCard card={disabled} size="large" photosEnabled={false} />
        </div>
        <div data-testid="photo-broken">
          <PlayerCard card={broken} size="large" photosEnabled />
        </div>
        <div data-testid="photo-unapproved">
          <PlayerCard card={unapproved} size="large" photosEnabled />
        </div>
        <div data-testid="photo-remote">
          <PlayerCard card={remote} size="large" photosEnabled />
        </div>
      </div>
      <p className="league-meta" data-testid="league-club">{namedClub}</p>
      {numericClub ? <p data-testid="league-numeric-club">{numericClub}</p> : null}
    </main>
  );
}
