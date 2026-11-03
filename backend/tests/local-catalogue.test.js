import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'url';
import { presentCard } from '../public-card.js';
import {
  auditLocalCatalogue,
  classifyImageCatalogueSource,
  importImageCatalogue,
  isPublicCardArtPath,
  readStoredCatalogue,
  selectedCardId,
  stableRowNumber
} from '../players/local-catalogue.js';
import { partitionSelectedCards } from '../players/selected-card-partition.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draft11-catalogue-'));
  const sourceDir = path.join(root, 'sources');
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  return { root, sourceDir, publicDir };
}

function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function productionSnapshots() {
  const required = [
    'data/local-catalogue/catalogue.json',
    'cards.json',
    'frontend/public/player-cards/fut23_aaland_primary.png'
  ];
  const optional = [
    'data/image-catalogue/player-catalogue.json',
    'data/image-catalogue/backup-phase4/player-catalogue.json',
    'data/local-catalogue/audit.json',
    'data/local-catalogue/card-ocr-audit.json'
  ];
  const files = [];
  for (const relative of required) {
    const file = path.join(repoRoot, relative);
    assert.equal(fs.existsSync(file), true, relative);
    files.push(file);
  }
  for (const relative of optional) {
    const file = path.join(repoRoot, relative);
    if (fs.existsSync(file)) files.push(file);
  }
  const datasetImage = path.join(repoRoot, '..', 'Draft11 dataset', 'images', '42_184788461.webp.png');
  if (fs.existsSync(datasetImage)) files.push(datasetImage);
  return files.map((file) => ({ file, hash: fileHash(file) }));
}

function writeOriginalFixture(dir) {
  const aalandPath = path.join(dir, '42_184788461.webp.png');
  const secondPath = path.join(dir, 'aaronson.png');
  fs.writeFileSync(aalandPath, PNG);
  fs.writeFileSync(secondPath, PNG);
  const sourceFile = path.join(dir, 'player-catalogue.json');
  const players = [
    player({
      sourceImage: '42_184788461.webp.png',
      sourceImageHash: 'hash-aaland',
      sourcePath: aalandPath,
      auctionEligible: false
    }),
    player({
      playerId: 'fut23_aaronson',
      name: 'Aaronson',
      ocrName: 'AARONSON',
      overall: 88,
      position: 'RM',
      sourceImage: 'aaronson.png',
      sourceImageHash: 'hash-aaronson',
      sourcePath: secondPath,
      auctionEligible: false
    })
  ];
  fs.writeFileSync(sourceFile, JSON.stringify({
    generatedAt: '2026-11-01T16:34:25.460Z',
    source: 'card-images',
    auctionEligible: false,
    liveAuctionActivated: false,
    players
  }));
  return { sourceFile, playerCount: players.length };
}

function writePublishedFixture(file) {
  const published = {
    source: 'image-catalogue',
    sourceCatalogue: file,
    players: [{
      playerId: 'fut23_published_sample',
      name: 'Published Sample',
      normalizedName: 'published sample',
      source: 'image-catalogue',
      sourcePlayerId: 'fut23_published_sample',
      identityStatus: 'card_image',
      imageStatus: 'selected_local',
      primaryCardId: 'fut23_published_sample_selected'
    }],
    cards: [{
      cardId: 'fut23_published_sample_selected',
      playerId: 'fut23_published_sample',
      source: 'image-catalogue',
      sourceVersion: 'card-images',
      sourceRowNumber: 7000001,
      sourceCardId: 'sample.png',
      overallRating: 90,
      position: 'ST',
      isPrimary: true,
      imagePath: '/player-cards/fut23_published_sample_primary.png',
      imageAssociation: 'selected-card',
      auctionEligible: false
    }]
  };
  fs.writeFileSync(file, JSON.stringify(published));
  return published;
}

function assertUntouched(snapshots) {
  for (const snapshot of snapshots) {
    assert.equal(fileHash(snapshot.file), snapshot.hash, snapshot.file);
  }
}

function player(overrides = {}) {
  return {
    playerId: 'fut23_aaland',
    name: 'Aaland',
    ocrName: 'AALAND',
    overall: null,
    position: null,
    nationality: null,
    club: null,
    league: null,
    pace: null,
    shooting: 97,
    passing: 82,
    dribbling: 90,
    defending: 61,
    physical: 95,
    sourceImage: 'aaland.png',
    sourceImageHash: 'hash-aaland',
    sourcePath: overrides.sourcePath,
    selectionReason: 'Highest readable card.',
    ...overrides
  };
}

describe('local image catalogue', () => {
  it('keeps every identity, copies the selected image, and does not invent missing fields', async () => {
    const { root, sourceDir, publicDir } = tempWorkspace();
    const firstPath = path.join(sourceDir, 'aaland.png');
    const secondPath = path.join(sourceDir, 'aaronson.png');
    fs.writeFileSync(firstPath, PNG);
    fs.writeFileSync(secondPath, PNG);
    const existingArt = path.join(publicDir, 'fut23_keep_primary.webp');
    fs.writeFileSync(existingArt, Buffer.from('webp-bytes'));
    const sourceFile = path.join(root, 'source.json');
    const storeFile = path.join(root, 'catalogue.json');
    fs.writeFileSync(sourceFile, JSON.stringify({
      players: [
        player({ sourcePath: firstPath }),
        player({
          playerId: 'fut23_aaronson',
          name: 'Aaronson',
          ocrName: 'AARONSON',
          overall: 88,
          position: 'RM',
          sourceImage: 'aaronson.png',
          sourceImageHash: 'hash-aaronson',
          sourcePath: secondPath
        })
      ]
    }));
    fs.writeFileSync(storeFile, JSON.stringify({
      players: [{
        playerId: 'fut23_keep',
        name: 'Keep',
        normalizedName: 'keep',
        source: 'image-catalogue',
        sourcePlayerId: 'fut23_keep',
        identityStatus: 'card_image',
        imageStatus: 'selected_local',
        primaryCardId: 'fut23_keep_selected',
        nationality: null,
        club: null,
        league: null,
        age: null,
        sofifaId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }],
      cards: [{
        cardId: 'fut23_keep_selected',
        playerId: 'fut23_keep',
        source: 'image-catalogue',
        sourceVersion: 'card-images',
        sourceRowNumber: 7000001,
        sourceCardId: 'keep.png',
        overallRating: 90,
        position: 'ST',
        alternatePositions: [],
        imagePath: '/player-cards/fut23_keep_primary.webp',
        imageAssociation: 'selected-card',
        auctionEligible: false,
        isPrimary: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    }));

    const first = await importImageCatalogue({
      sourceFile,
      storeFile,
      publicDir,
      protectedIds: ['fifa_158023'],
      now: new Date('2026-11-02T00:00:00.000Z')
    });
    assert.equal(first.ok, true);
    assert.equal(first.audit.totalPlayerIdentities, 3);
    assert.equal(first.audit.totalSelectedCards, 3);
    assert.equal(first.audit.imagesServed, 3);
    assert.equal(first.audit.excluded.length, 0);
    assert.equal(first.audit.duplicateImageAssignments.length, 0);
    assert.equal(first.audit.liveAuctionActivated, false);
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const aaland = stored.players.find((item) => item.playerId === 'fut23_aaland');
    const aalandCard = stored.cards.find((item) => item.playerId === 'fut23_aaland');
    assert.equal(aaland.name, 'Aaland');
    assert.equal(aalandCard.overallRating, null);
    assert.equal(aalandCard.position, null);
    assert.equal(aalandCard.auctionEligible, false);
    assert.equal(aalandCard.cardId, selectedCardId('fut23_aaland'));
    assert.equal(aalandCard.sourceCardId, 'aaland.png');
    assert.equal(isPublicCardArtPath(aalandCard.imagePath), true);
    assert.equal(fs.existsSync(path.join(publicDir, path.basename(aalandCard.imagePath))), true);
    assert.equal(fs.readFileSync(existingArt).equals(Buffer.from('webp-bytes')), true);
    assert.equal(fs.readFileSync(firstPath).equals(PNG), true);
    assert.equal(stored.players.some((item) => item.playerId === 'fut23_keep'), true);

    const sourceBefore = fs.readFileSync(sourceFile);
    const second = await importImageCatalogue({
      sourceFile,
      storeFile,
      publicDir,
      protectedIds: ['fifa_158023'],
      now: new Date('2026-11-03T00:00:00.000Z')
    });
    assert.equal(second.ok, true);
    assert.equal(second.written, false);
    assert.equal(second.copied, 0);
    assert.equal(second.audit.totalPlayerIdentities, 3);
    assert.equal(fs.readFileSync(sourceFile).equals(sourceBefore), true);
    const rows = new Set();
    assert.equal(stableRowNumber('fut23_aaland', rows), stableRowNumber('fut23_aaland', new Set()));
  });

  it('does not replace an existing player id that belongs to a different name', async () => {
    const { root, sourceDir, publicDir } = tempWorkspace();
    const sourcePath = path.join(sourceDir, 'aaland.png');
    fs.writeFileSync(sourcePath, PNG);
    const sourceFile = path.join(root, 'source.json');
    const storeFile = path.join(root, 'catalogue.json');
    fs.writeFileSync(sourceFile, JSON.stringify({
      players: [
        player({ sourcePath }),
        player({
          playerId: 'fut23_aaronson',
          name: 'Aaronson',
          sourceImage: 'aaronson.png',
          sourceImageHash: 'hash-aaronson',
          sourcePath
        })
      ]
    }));
    fs.writeFileSync(storeFile, JSON.stringify({
      players: [{
        playerId: 'fut23_aaland',
        name: 'Someone Else',
        normalizedName: 'someone else',
        source: 'image-catalogue',
        sourcePlayerId: 'fut23_aaland',
        identityStatus: 'card_image',
        imageStatus: 'missing',
        primaryCardId: 'fut23_aaland_selected',
        nationality: null,
        club: null,
        league: null,
        age: null,
        sofifaId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }],
      cards: []
    }));
    const result = await importImageCatalogue({ sourceFile, storeFile, publicDir });
    assert.equal(result.ok, true);
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    assert.equal(stored.players.find((item) => item.playerId === 'fut23_aaland').name, 'Someone Else');
    assert.equal(stored.players.some((item) => item.playerId === 'fut23_aaronson'), true);
    assert.equal(result.audit.excluded.length, 1);
    const audit = auditLocalCatalogue(stored, publicDir, result.excluded);
    assert.equal(audit.totalPlayerIdentities, 2);
  });

  it('does not overwrite a stored card when the source card id loses its file extension', async () => {
    const { root, sourceDir, publicDir } = tempWorkspace();
    const sourcePath = path.join(sourceDir, 'aaland.png');
    const otherPath = path.join(sourceDir, 'aaronson.png');
    fs.writeFileSync(sourcePath, PNG);
    fs.writeFileSync(otherPath, PNG);
    const sourceFile = path.join(root, 'source.json');
    const storeFile = path.join(root, 'catalogue.json');
    fs.writeFileSync(sourceFile, JSON.stringify({
      source: 'card-images',
      players: [
        player({
          sourceImage: '42_184788461.webp',
          sourcePath,
          overall: 99,
          position: 'GK'
        }),
        player({
          playerId: 'fut23_aaronson',
          name: 'Aaronson',
          ocrName: 'AARONSON',
          sourceImage: 'aaronson.png',
          sourceImageHash: 'hash-aaronson',
          sourcePath: otherPath
        })
      ]
    }));
    fs.writeFileSync(storeFile, JSON.stringify({
      players: [{
        playerId: 'fut23_aaland',
        name: 'Aaland',
        normalizedName: 'aaland',
        source: 'image-catalogue',
        sourcePlayerId: 'fut23_aaland',
        identityStatus: 'card_image',
        imageStatus: 'selected_local',
        primaryCardId: 'fut23_aaland_selected',
        nationality: null,
        club: null,
        league: null,
        age: null,
        sofifaId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }],
      cards: [{
        cardId: 'fut23_aaland_selected',
        playerId: 'fut23_aaland',
        source: 'image-catalogue',
        sourceVersion: 'card-images',
        sourceRowNumber: 7317255,
        sourceCardId: '42_184788461.webp.png',
        overallRating: 90,
        position: 'ST',
        alternatePositions: [],
        imagePath: '/player-cards/fut23_aaland_primary.png',
        imageAssociation: 'selected-card',
        auctionEligible: false,
        isPrimary: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    }));
    const result = await importImageCatalogue({ sourceFile, storeFile, publicDir });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.audit.excluded.length, 1);
    assert.equal(result.audit.excluded[0].cardId, 'fut23_aaland_selected');
    assert.match(result.audit.excluded[0].reason, /source row/);
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const kept = stored.cards.find((card) => card.playerId === 'fut23_aaland');
    const added = stored.cards.find((card) => card.playerId === 'fut23_aaronson');
    assert.equal(stored.players.find((item) => item.playerId === 'fut23_aaland').name, 'Aaland');
    assert.equal(kept.sourceCardId, '42_184788461.webp.png');
    assert.equal(kept.overallRating, 90);
    assert.equal(kept.position, 'ST');
    assert.equal(added.sourceCardId, 'aaronson.png');
    assert.equal(added.overallRating, null);
  });

  it('refuses a published catalogue instead of rebuilding archived alternatives as selected cards', async () => {
    const { root, publicDir } = tempWorkspace();
    const storeFile = path.join(root, 'catalogue.json');
    const sourceFile = path.join(root, 'published.json');
    const stored = {
      source: 'image-catalogue',
      sourceCatalogue: sourceFile,
      players: [
        {
          playerId: 'fut23_joao_felix',
          name: 'João Félix',
          normalizedName: 'joao felix',
          source: 'image-catalogue',
          sourcePlayerId: 'fut23_joao_felix',
          identityStatus: 'card_image',
          imageStatus: 'selected_local',
          primaryCardId: 'fut23_joao_felix_selected'
        },
        {
          playerId: 'fut23_ao_felix',
          name: 'João Félix',
          normalizedName: 'joao felix',
          source: 'image-catalogue',
          sourcePlayerId: 'fut23_ao_felix',
          identityStatus: 'card_image',
          imageStatus: 'selected_local',
          primaryCardId: 'fut23_ao_felix_selected'
        }
      ],
      cards: ['fut23_joao_felix', 'fut23_ao_felix'].map((playerId) => ({
        cardId: `${playerId}_selected`,
        playerId,
        source: 'image-catalogue',
        sourceVersion: 'card-images',
        sourceRowNumber: playerId.endsWith('ao_felix') ? 7000002 : 7000001,
        sourceCardId: playerId.endsWith('ao_felix') ? 'ao.png' : 'joao.png',
        overallRating: 96,
        position: 'CAM',
        pace: 90,
        isPrimary: true,
        imagePath: `/player-cards/${playerId}_primary.png`,
        imageAssociation: 'selected-card',
        auctionEligible: false,
        cardPixelReading: { ocrName: 'FELIX', nameConfident: true }
      }))
    };
    fs.writeFileSync(storeFile, JSON.stringify(stored));
    const before = fs.readFileSync(storeFile);
    const beforePartition = partitionSelectedCards(JSON.parse(before.toString()));
    const published = structuredClone(stored);
    published.cards.find((card) => card.playerId === 'fut23_ao_felix').overallRating = 99;
    fs.writeFileSync(sourceFile, JSON.stringify(published));
    assert.equal(classifyImageCatalogueSource(published).format, 'published');
    const result = await importImageCatalogue({ sourceFile, storeFile, publicDir });
    assert.equal(result.ok, false);
    assert.equal(result.format, 'published');
    assert.equal(result.code, 'UNSUPPORTED_SOURCE_FORMAT');
    assert.equal(result.written, false);
    assert.equal(result.copied, 0);
    assert.equal(result.excluded.length, 0);
    assert.equal(result.audit, null);
    assert.equal(fs.readFileSync(storeFile).equals(before), true);
    assert.equal(fs.existsSync(path.join(root, 'audit.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'card-ocr-audit.json')), false);
    assert.equal(fs.readdirSync(publicDir).length, 0);
    const selected = partitionSelectedCards(JSON.parse(fs.readFileSync(storeFile, 'utf8')));
    assert.deepEqual(selected.live.players.map((item) => item.playerId), beforePartition.live.players.map((item) => item.playerId));
    assert.deepEqual(selected.archived.players.map((item) => item.playerId), ['fut23_ao_felix']);
    assert.equal(selected.live.cards[0].overallRating, 96);
    assert.equal(selected.live.cards[0].position, 'CAM');
    assert.equal(selected.live.players[0].name, 'João Félix');
  });

  it('refuses the published image catalogue and keeps the live selected-card partition', async () => {
    const guard = productionSnapshots();
    const { root, publicDir } = tempWorkspace();
    const sourceFile = path.join(root, 'published.json');
    const liveFile = path.join(repoRoot, 'data', 'local-catalogue', 'catalogue.json');
    const storeFile = path.join(root, 'catalogue.json');
    fs.copyFileSync(liveFile, storeFile);
    const published = writePublishedFixture(sourceFile);
    assert.equal(classifyImageCatalogueSource(published).format, 'published');
    const result = await importImageCatalogue({ sourceFile, storeFile, publicDir });
    assert.equal(result.ok, false);
    assert.equal(result.format, 'published');
    assert.equal(result.code, 'UNSUPPORTED_SOURCE_FORMAT');
    assert.equal(result.copied, 0);
    assert.equal(fs.readFileSync(storeFile).equals(fs.readFileSync(liveFile)), true);
    assert.equal(fs.existsSync(path.join(root, 'audit.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'card-ocr-audit.json')), false);
    const selected = partitionSelectedCards(readStoredCatalogue(storeFile));
    assert.equal(selected.live.players.length, 1009);
    assert.equal(selected.archived.players.length, 138);
    assert.equal(selected.live.players.some((player) => player.playerId === 'fut23_ca_al'), true);
    assert.equal(selected.archived.players.some((player) => player.playerId === 'fut23_carvajal'), true);
    const kept = selected.live.cards.find((card) => card.playerId === 'fut23_ca_al');
    assert.equal(kept.overallRating, 96);
    assert.equal(kept.position, 'RB');
    assert.equal(selected.live.players.find((player) => player.playerId === 'fut23_ca_al').name, 'Carvajal');
    assertUntouched(guard);
  });

  it('imports the original card-image catalogue twice without rewriting the isolated store', async () => {
    const guard = productionSnapshots();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draft11-catalogue-'));
    const publicDir = path.join(root, 'public');
    const storeFile = path.join(root, 'catalogue.json');
    const { sourceFile, playerCount } = writeOriginalFixture(root);
    try {
      const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
      assert.equal(classifyImageCatalogueSource(source).format, 'original');
      const first = await importImageCatalogue({
        sourceFile,
        storeFile,
        publicDir,
        now: new Date('2026-11-02T00:00:00.000Z')
      });
      assert.equal(first.ok, true, first.error);
      assert.equal(first.format, 'original');
      assert.equal(first.audit.totalPlayerIdentities, playerCount, JSON.stringify(first.audit.excluded.slice(0, 3)));
      assert.equal(first.audit.totalSelectedCards, playerCount);
      assert.equal(first.copied, playerCount);
      assert.equal(first.audit.excluded.length, 0);
      assert.equal(first.audit.liveAuctionActivated, false);
      const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      const aaland = stored.players.find((item) => item.playerId === 'fut23_aaland');
      const aalandCard = stored.cards.find((item) => item.playerId === 'fut23_aaland');
      assert.equal(aaland.name, 'Aaland');
      assert.equal(aalandCard.sourceCardId, '42_184788461.webp.png');
      assert.equal(aalandCard.overallRating, null);
      assert.equal(aalandCard.position, null);
      assert.equal(aalandCard.auctionEligible, false);
      const storeHash = createHash('sha256').update(fs.readFileSync(storeFile)).digest('hex');
      const second = await importImageCatalogue({
        sourceFile,
        storeFile,
        publicDir,
        now: new Date('2026-11-03T00:00:00.000Z')
      });
      assert.equal(second.ok, true, second.error);
      assert.equal(second.written, false);
      assert.equal(second.copied, 0);
      assert.equal(second.audit.totalPlayerIdentities, playerCount);
      assert.equal(second.audit.excluded.length, 0);
      assert.equal(second.audit.imagesServed, first.audit.imagesServed);
      assert.equal(createHash('sha256').update(fs.readFileSync(storeFile)).digest('hex'), storeHash);
      assert.equal(fs.existsSync(path.join(root, 'audit.json')), true);
      assert.equal(fs.existsSync(path.join(root, 'card-ocr-audit.json')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    assertUntouched(guard);
  });

  it('uses the printed card name without merging a second identity', async () => {
    const { root, sourceDir, publicDir } = tempWorkspace();
    const image = path.join(sourceDir, 'romagnoli.png');
    const other = path.join(sourceDir, 'other.png');
    const blurry = path.join(sourceDir, 'blurry.png');
    fs.writeFileSync(image, PNG);
    fs.writeFileSync(other, PNG);
    fs.writeFileSync(blurry, PNG);
    const sourceFile = path.join(root, 'source.json');
    const storeFile = path.join(root, 'catalogue.json');
    fs.writeFileSync(sourceFile, JSON.stringify({
      players: [
        player({
          playerId: 'fut23_fts',
          name: '-fts.',
          ocrName: '-fts. -',
          overall: null,
          position: null,
          pace: 86,
          shooting: 52,
          passing: 72,
          dribbling: null,
          defending: 93,
          physical: 90,
          sourceImage: 'romagnoli.png',
          sourcePath: image
        }),
        player({
          playerId: 'fut23_other_romagnoli',
          name: 'Romagnoli',
          ocrName: 'ROMAGNOLI',
          overall: 80,
          position: 'CB',
          sourceImage: 'other.png',
          sourcePath: other
        }),
        player({
          playerId: 'fut23_blurry',
          name: 'Blurry',
          ocrName: 'BLURRY',
          sourceImage: 'blurry.png',
          sourcePath: blurry
        })
      ]
    }));
    fs.writeFileSync(path.join(root, 'card-readings.json'), JSON.stringify({
      readings: [
        {
          playerId: 'fut23_fts',
          displayName: 'Romagnoli',
          ocrName: 'ROMAGNOLI',
          nameConfident: true,
          overall: 91,
          overallConfident: true,
          position: 'CB',
          positionConfident: true,
          nationality: 'Italy',
          nationalityConfident: true,
          crestOnCard: true,
          flagOnCard: true,
          pace: 86,
          shooting: 52,
          passing: 72,
          dribbling: 78,
          defending: 93,
          physical: 90,
          attributesConfident: true,
          reviewReasons: [],
          rawOcr: { name: 'NAME ROMAGNOLI', rating: 'OVR 91', position: 'POSCB' }
        },
        {
          playerId: 'fut23_blurry',
          displayName: 'Someone',
          ocrName: 'SOMEONE',
          nameConfident: false,
          overall: null,
          overallConfident: false,
          position: null,
          positionConfident: false,
          reviewReasons: ['The printed name could not be read confidently.']
        }
      ]
    }));
    const first = await importImageCatalogue({
      sourceFile,
      storeFile,
      publicDir,
      now: new Date('2026-11-02T00:00:00.000Z')
    });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.audit.excluded.length, 0);
    assert.equal(first.audit.totalPlayerIdentities, 3);
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const printed = stored.players.find((item) => item.playerId === 'fut23_fts');
    const existing = stored.players.find((item) => item.playerId === 'fut23_other_romagnoli');
    const unread = stored.players.find((item) => item.playerId === 'fut23_blurry');
    const printedCard = stored.cards.find((item) => item.playerId === 'fut23_fts');
    const unreadCard = stored.cards.find((item) => item.playerId === 'fut23_blurry');
    assert.equal(printed.playerId, 'fut23_fts');
    assert.equal(printed.name, 'Romagnoli');
    assert.equal(printed.previousName, '-fts.');
    assert.equal(printed.nationality, 'Italy');
    assert.equal(existing.name, 'Romagnoli');
    assert.notEqual(existing.playerId, printed.playerId);
    assert.equal(printedCard.overallRating, 91);
    assert.equal(printedCard.position, 'CB');
    assert.equal(printedCard.dribbling, 78);
    assert.equal(printedCard.previousOcrName, '-fts. -');
    assert.equal(printedCard.auctionEligible, false);
    assert.equal(printedCard.crestOnCard, true);
    assert.equal(unread.name, 'Blurry');
    assert.deepEqual(unreadCard.reviewReasons, ['The printed name could not be read confidently.']);
    const second = await importImageCatalogue({
      sourceFile,
      storeFile,
      publicDir,
      now: new Date('2026-11-03T00:00:00.000Z')
    });
    assert.equal(second.ok, true);
    assert.equal(second.written, false);
    assert.equal(second.audit.totalPlayerIdentities, 3);
  });

  it('keeps a local catalogue card out of the auction payload flags', () => {
    const presented = presentCard({
      id: 'fut23_aaland',
      name: 'Aaland',
      position: '',
      stats: { overall: null },
      localCatalogue: true,
      cardArtExpected: true,
      auctionEligible: false,
      cardArtUrl: '/player-cards/fut23_aaland_primary.png',
      cardArtApproved: true,
      cardArtApprovalStatus: 'approved_for_use',
      cardArtTesting: true,
      cardArtValidated: true
    }, {
      cardArtEnabled: true,
      cardArtFileExists: () => true
    });
    assert.equal(presented.auctionEligible, false);
    assert.equal(presented.cardArtUrl, '/player-cards/fut23_aaland_primary.png');
    assert.equal(presented.localCatalogue, true);
  });
});
