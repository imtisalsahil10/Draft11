import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'url';
import { chooseCatalog } from '../catalog.js';
import { canonicalCard } from '../league-match.js';
import { presentCard, presentClientPayload } from '../public-card.js';
import { isAllowedPlayerPhoto } from '../../shared/player-photo.js';
import { ROOM_SCHEMA_VERSION } from '../constants.js';
import { materializeLiveRoom } from '../room-snapshot.js';
import { createIsolatedRoomFile } from './support/isolated-rooms.js';

const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const fifa = {
  id: 'fifa_158023',
  name: 'L. Messi',
  position: 'CF',
  club: 'FC Barcelona',
  league: 'La Liga',
  category: 'LEGENDARY',
  basePrice: 25,
  stats: { pace: 93, shooting: 89, passing: 86, dribbling: 96, defense: 27, physical: 63, overall: 93 },
  source: { dataset: 'fifa', sofifaId: 158023 }
};

const legacy = {
  id: 'card_00001',
  name: 'Pelé',
  position: 'ST',
  club: '525',
  category: 'LEGENDARY',
  basePrice: 25,
  stats: { pace: 96, shooting: 97, passing: 94, defense: 61, physical: 78, overall: 99 }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const image = {
  id: 'fut23_lionel_messi',
  name: 'Lionel Messi',
  imageCatalogue: true,
  cardArtUrl: '/player-cards/fut23_lionel_messi_primary.webp',
  position: 'RW',
  category: 'LEGENDARY',
  basePrice: 25,
  stats: { overall: 93 }
};

describe('image auction catalog', () => {
  it('deals image cards and keeps FIFA and legacy ids for recovery', () => {
    const chosen = chooseCatalog({
      mongoCards: [legacy, { ...fifa, name: 'Stored Messi' }],
      fileCards: [fifa],
      imageCards: [image, { ...fifa, imageCatalogue: true }]
    });
    assert.deepEqual(chosen.auction.map((card) => card.id), ['fut23_lionel_messi']);
    assert.equal(chosen.source, 'image-catalogue');
    assert.equal(chosen.recovery.find((card) => card.id === 'card_00001').name, 'Pelé');
    assert.equal(chosen.recovery.find((card) => card.id === 'fifa_158023').name, 'Stored Messi');

    const fileOnly = chooseCatalog({ mongoCards: [legacy], fileCards: [fifa], imageCards: [image] });
    assert.deepEqual(fileOnly.auction.map((card) => card.id), ['fut23_lionel_messi']);
    assert.equal(fileOnly.recovery.some((card) => card.id === 'fifa_158023'), true);

    const emptyImages = chooseCatalog({ mongoCards: [fifa], fileCards: [fifa], imageCards: [] });
    assert.deepEqual(emptyImages.auction, []);
    assert.equal(emptyImages.recovery.some((card) => card.id === 'fifa_158023'), true);
  });

  it('restores a saved room and leaves a completed match snapshot unchanged', () => {
    const matchResults = { winner: 'Ada', goals: { team1: 2, team2: 1 }, cards: [{ id: 'card_00001', name: 'Pelé' }] };
    const doc = {
      roomId: 'room-old',
      code: 'OLD123',
      schemaVersion: ROOM_SCHEMA_VERSION,
      stateVersion: 3,
      status: 'finished',
      phase: 'complete',
      state: {
        createdAt: Date.now(),
        lastActivity: Date.now(),
        seats: [{
          seatId: 'seat-ada',
          username: 'Ada',
          balance: 800,
          cardIds: ['card_00001'],
          builtCardIds: [],
          joinedAt: Date.now(),
          lastActivity: Date.now()
        }],
        cardCache: {},
        matchResults,
        gameFinished: true,
        finalSquads: [{ seatId: 'seat-ada', username: 'Ada', balance: 800, cardIds: ['card_00001'] }]
      }
    };
    const catalog = new Map(chooseCatalog({
      mongoCards: [legacy],
      fileCards: [fifa]
    }).recovery.map((card) => [card.id, card]));
    const live = materializeLiveRoom(doc, { catalog, socketsDead: true });
    assert.equal(live.room.players.get('seat-ada').team[0].name, 'Pelé');
    assert.equal(live.room.players.get('seat-ada').team[0].stats.overall, 99);
    assert.deepEqual(live.room.matchResults, matchResults);
    assert.equal(live.room.finalSquads[0].cards[0].id, 'card_00001');

    const savedSquad = canonicalCard({
      id: 'card_00009',
      name: 'Archived',
      position: 'CM',
      stats: { overall: 80, pace: 70 },
      club: 'Old Club'
    });
    assert.equal(savedSquad.name, 'Archived');
    assert.equal(savedSquad.stats.overall, 80);
    assert.equal(savedSquad.id, 'card_00009');
  });

  it('shows only an approved local photo and rejects remote urls', () => {
    assert.equal(isAllowedPlayerPhoto('/player-images/158023.png'), true);
    assert.equal(isAllowedPlayerPhoto('/player-images/158023.jpg'), true);
    assert.equal(isAllowedPlayerPhoto('/player-images/158023.webp'), true);
    assert.equal(isAllowedPlayerPhoto('https://evil.example/a.png'), false);
    assert.equal(isAllowedPlayerPhoto('https://media.api-sports.io/football/players/276.png'), false);
    assert.equal(isAllowedPlayerPhoto('https://sofifa.com/player/158023'), false);
    assert.equal(isAllowedPlayerPhoto('/player-images/../secret.png'), false);
    assert.equal(isAllowedPlayerPhoto('//evil.example/a.png'), false);

    const card = {
      ...fifa,
      photoRef: '/player-images/158023.png',
      photoApproved: false
    };
    assert.equal(presentCard(card, { photosEnabled: true }).photoUrl, undefined);
    assert.equal(presentCard({ ...card, photoApproved: true }, { photosEnabled: false }).photoUrl, undefined);
    assert.equal(presentCard({ ...card, photoApproved: true }, { photosEnabled: true }).photoUrl, '/player-images/158023.png');
    assert.equal(isAllowedPlayerPhoto('/player-images/fut23_lionel_messi.jpg'), true);
    assert.equal(isAllowedPlayerPhoto('https://upload.wikimedia.org/wikipedia/commons/a.jpg'), false);
    const elite = {
      ...card,
      photoUrl: '/player-images/fut23_lionel_messi.jpg',
      photoApproved: true
    };
    assert.equal(presentCard(elite, { photosEnabled: true }).photoUrl, undefined);
    assert.equal(presentCard({
      ...elite,
      photoManifestApproved: true,
      rightsReviewed: true,
      imageValidated: true
    }, { photosEnabled: true }).photoUrl, '/player-images/fut23_lionel_messi.jpg');
    const rejected = presentClientPayload({
      card: { ...card, photoApproved: true, photoRef: 'https://evil.example/a.png' }
    }, { photosEnabled: true });
    assert.equal(rejected.card.photoUrl, undefined);
    assert.equal(JSON.stringify(rejected).includes('photoRef'), false);
    assert.equal(JSON.stringify(rejected).includes('sofifaId'), false);
  });

  it('has no API-Football client, script, or env key in the player path', () => {
    const players = fs.readdirSync(path.join(backendRoot, 'players'));
    assert.equal(players.some((name) => name.includes('api-football') || name.includes('sync')), false);
    const packageJson = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.scripts['sync:players'], undefined);
    assert.equal(packageJson.scripts['import:players'], 'node players/import-cli.js');
    const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(rootPackage.scripts['sync:players'], undefined);
    const example = fs.readFileSync(path.join(backendRoot, '.env.example'), 'utf8');
    assert.equal(example.includes('API_FOOTBALL'), false);
    const server = fs.readFileSync(path.join(backendRoot, 'server.js'), 'utf8');
    assert.equal(server.includes('API_FOOTBALL'), false);
    assert.equal(server.includes('api-football'), false);
    const catalogFile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'cards.json'), 'utf8'));
    assert.equal(catalogFile.length, 45);
    assert.equal(catalogFile.every((card) => /^fifa_\d+$/.test(card.id) && card.stats.overall >= 85), true);
  });

  it('starts the server without an API football key and without mongo', async () => {
    const port = '3098';
    const env = { ...process.env };
    delete env.API_FOOTBALL_KEY;
    delete env.API_FOOTBALL_BASE_URL;
    env.MONGODB_URI = '';
    env.NODE_ENV = 'test';
    env.REQUIRE_MONGO = '0';
    env.PORT = port;
    env.DRAFT11_PLAYER_PHOTOS = '0';
    const rooms = createIsolatedRoomFile();
    env.DRAFT11_TEST_ROOM_FILE = rooms.file;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: backendRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    try {
      let healthy = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (child.exitCode != null) break;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          if (response.status === 503) {
            const body = await response.json();
            healthy = body.status === 'unavailable' && body.database === 'disconnected';
            break;
          }
        } catch {
          // Still starting.
        }
        await sleep(250);
      }
      assert.equal(healthy, true, output);
      const cards = await fetch(`http://127.0.0.1:${port}/api/cards`);
      const body = await cards.json();
      assert.equal(body.success, true);
      assert.equal(body.count, 1009);
      assert.equal(body.source, 'image-catalogue');
      assert.equal(body.cards.every((card) => String(card.id).startsWith('fut23_')), true);
      assert.equal(output.includes('api-football'), false);
      assert.equal(output.includes('api-sports.io'), false);
    } finally {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(4000)
      ]);
      rooms.cleanup();
    }
  });
});
