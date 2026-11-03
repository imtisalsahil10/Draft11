import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'url';
import { MIN_OVERALL } from '../players/fifa-import.js';
import {
  AUCTION_PRICES,
  applyOcr,
  buildImageCatalogue,
  normalizeName,
  playerIdFor,
  presentImageCataloguePlayer,
  publicImagePath
} from '../players/image-catalogue.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function card(overrides) {
  return {
    sourceImage: 'card.webp',
    sourcePath: path.join(repoRoot, 'frontend', 'public', 'player-cards', 'fut23_lionel_messi_primary.webp'),
    sourceImageHash: 'abc',
    width: 260,
    height: 370,
    bytes: 1000,
    name: 'Lionel Messi',
    overall: 99,
    position: 'RW',
    alternatePositions: ['CF'],
    nationality: null,
    club: null,
    league: 'La Liga',
    cardType: null,
    pace: 97,
    shooting: 95,
    passing: 96,
    dribbling: 99,
    defending: 40,
    physical: 78,
    goalkeeperAttributes: null,
    flagSignature: [120, 160, 200],
    rawOcr: 'MESSI',
    extractionConfidence: 0.9,
    readableFields: 8,
    ...overrides
  };
}

describe('image catalogue', () => {
  it('reads a stat line and leaves a missing attribute null', () => {
    const parsed = applyOcr({
      sourceImage: 'a.webp',
      sourcePath: 'a.webp',
      sourceImageHash: '1',
      width: 10,
      height: 10,
      bytes: 10,
      overall: 88,
      position: 'RM',
      alternatePositions: ['CM'],
      flagSignature: null
    }, 'BRUNO FERNANDES', '76 PAC 88 SHO 90 PAS 70 DEF 79 PHY');
    assert.equal(parsed.name, 'Bruno Fernandes');
    assert.equal(parsed.pace, 76);
    assert.equal(parsed.shooting, 88);
    assert.equal(parsed.passing, 90);
    assert.equal(parsed.dribbling, null);
    assert.equal(parsed.defending, 70);
    assert.equal(parsed.physical, 79);
    assert.equal(parsed.nationality, null);
    assert.equal(parsed.club, null);
    assert.equal(parsed.league, null);
    assert.equal(parsed.goalkeeperAttributes, null);
  });

  it('reads goalkeeper labels without inventing a missing one', () => {
    const parsed = applyOcr({
      sourceImage: 'gk.webp',
      sourcePath: 'gk.webp',
      sourceImageHash: '1',
      width: 10,
      height: 10,
      bytes: 10,
      overall: 90,
      position: 'GK',
      alternatePositions: [],
      flagSignature: null
    }, 'RAMSDALE', '91 DIV 87 HAN 94 KIC 57 SPE 88 POS');
    assert.deepEqual(parsed.goalkeeperAttributes, {
      diving: 91,
      handling: 87,
      kicking: 94,
      speed: 57,
      positioning: 88
    });
    assert.equal(parsed.goalkeeperAttributes.reflexes, undefined);
    assert.equal(parsed.pace, null);
  });

  it('groups alternative cards and keeps the highest rated version only', () => {
    const result = buildImageCatalogue([
      card({ sourceImage: 'fut23_lionel_messi_card_02.webp', overall: 96, pace: 93, sourceImageHash: 'low' }),
      card({ sourceImage: 'fut23_lionel_messi_primary.webp', overall: 99, sourceImageHash: 'high' }),
      card({ sourceImage: 'fut23_lionel_messi_card_04.webp', overall: 94, sourceImageHash: 'lower' })
    ]);
    assert.equal(result.players.length, 1);
    assert.equal(result.players[0].playerId, 'fut23_lionel_messi');
    assert.equal(result.players[0].overall, 99);
    assert.equal(result.players[0].pace, 97);
    assert.equal(result.players[0].imagePath, '/player-cards/fut23_lionel_messi_primary.webp');
    assert.equal(result.alternatives.length, 2);
    assert.equal(result.alternatives.every((item) => item.overall < 99), true);
    assert.equal(result.summary.alternativeCards, 2);
  });

  it('does not merge similar names', () => {
    const result = buildImageCatalogue([
      card({ name: 'Messi', sourceImage: 'messi.webp', sourceImageHash: 'a' }),
      card({
        name: 'Messias',
        sourceImage: 'messias.webp',
        sourcePath: 'D:/Draft11 dataset/images/messias.png',
        sourceImageHash: 'b',
        flagSignature: [10, 20, 30]
      })
    ]);
    assert.equal(result.players.length, 2);
    assert.equal(result.summary.ambiguousIdentities, 2);
    assert.equal(result.review.length, 2);
    assert.equal(new Set(result.players.map((item) => item.playerId)).size, 2);
    assert.equal(result.players.every((item) => item.catalogueStatus === 'needs_review'), true);
    assert.equal(result.players.every((item) => item.auctionEligible === false), true);
    assert.equal(result.auctionCandidates.length, 0);
  });

  it('groups the same card name even when the card colours differ', () => {
    const result = buildImageCatalogue([
      card({
        name: 'Messi',
        overall: 99,
        position: 'ST',
        sourceImage: 'fut23_lionel_messi_card_08.webp',
        flagSignature: [185, 80, 130],
        league: null,
        sourceImageHash: 'a'
      }),
      card({
        name: 'Messi',
        overall: 98,
        sourceImage: 'fut23_lionel_messi_primary.webp',
        flagSignature: [34, 51, 116],
        league: null,
        sourceImageHash: 'b'
      }),
      card({
        name: 'Messi',
        overall: 94,
        sourceImage: '088.png',
        sourcePath: 'D:/Draft11 dataset/images/088.png',
        flagSignature: [50, 128, 141],
        league: null,
        sourceImageHash: 'c'
      }),
      card({
        name: 'Messi Atar',
        overall: 92,
        sourceImage: 'fut23_lionel_messi_card_06.webp',
        league: null,
        sourceImageHash: 'd'
      })
    ]);
    assert.equal(result.summary.uniqueIdentities, 2);
    assert.equal(result.summary.identitiesRetained, 2);
    assert.equal(result.selected.find((item) => item.playerId === 'fut23_messi').overall, 99);
    assert.equal(result.players.find((item) => item.playerId === 'fut23_messi').overall, 99);
    assert.equal(result.players.find((item) => item.playerId === 'fut23_messi').leagueStatus, 'unknown');
    assert.equal(result.alternatives.filter((item) => item.playerId === 'fut23_messi').length, 2);
    assert.equal(result.summary.ambiguousIdentities, 2);
    assert.equal(result.players.length, 2);
    assert.equal(result.auctionCandidates.length, 0);
  });

  it('breaks an equal rating by image quality, then OCR confidence, then filename', () => {
    const tied = buildImageCatalogue([
      card({
        sourceImage: 'b.webp',
        sourcePath: 'D:/cards/b.webp',
        overall: 90,
        pace: null,
        width: 300,
        height: 400,
        bytes: 50,
        sourceImageHash: 'b',
        league: null
      }),
      card({
        sourceImage: 'a.webp',
        sourcePath: 'D:/cards/a.webp',
        overall: 90,
        width: 200,
        height: 200,
        bytes: 500,
        sourceImageHash: 'a',
        league: null
      })
    ]);
    assert.equal(tied.selected[0].sourceImage, 'b.webp');
    assert.match(tied.selected[0].selectionReason, /pixels/);

    const pixels = buildImageCatalogue([
      card({ sourceImage: 'b.webp', sourcePath: 'D:/cards/b.webp', overall: 90, width: 100, height: 100, league: null, sourceImageHash: 'b' }),
      card({ sourceImage: 'a.webp', sourcePath: 'D:/cards/a.webp', overall: 90, width: 300, height: 400, league: null, sourceImageHash: 'a' })
    ]);
    assert.equal(pixels.selected[0].sourceImage, 'a.webp');
    assert.match(pixels.selected[0].selectionReason, /pixels/);

    const confidence = buildImageCatalogue([
      card({
        sourceImage: 'b.webp',
        sourcePath: 'D:/cards/b.webp',
        overall: 90,
        width: 200,
        height: 200,
        bytes: 100,
        extractionConfidence: 0.4,
        league: null,
        sourceImageHash: 'b'
      }),
      card({
        sourceImage: 'a.webp',
        sourcePath: 'D:/cards/a.webp',
        overall: 90,
        width: 200,
        height: 200,
        bytes: 100,
        extractionConfidence: 0.95,
        league: null,
        sourceImageHash: 'a'
      })
    ]);
    assert.equal(confidence.selected[0].sourceImage, 'a.webp');
    assert.match(confidence.selected[0].selectionReason, /confidence/);

    const names = buildImageCatalogue([
      card({ sourceImage: 'b.webp', sourcePath: 'D:/cards/b.webp', overall: 90, league: null, sourceImageHash: 'b' }),
      card({ sourceImage: 'a.webp', sourcePath: 'D:/cards/a.webp', overall: 90, league: null, sourceImageHash: 'a' })
    ]);
    assert.equal(names.selected[0].sourceImage, 'a.webp');
    assert.match(names.selected[0].selectionReason, /Filename/);
  });

  it('applies the 85 overall rule and the supported league rule', () => {
    const result = buildImageCatalogue([
      card({ name: 'Low', sourceImage: 'low.webp', overall: 84, league: 'Premier League', sourceImageHash: 'l' }),
      card({ name: 'Other League', sourceImage: 'other.webp', overall: 90, league: 'Eredivisie', sourceImageHash: 'e' }),
      card({ name: 'No League', sourceImage: 'none.webp', overall: 91, league: null, sourceImageHash: 'n' }),
      card({ name: 'Ready', sourceImage: 'ready.webp', overall: 92, league: 'Premier League', sourceImageHash: 'r' })
    ]);
    assert.equal(MIN_OVERALL, 85);
    assert.equal(result.summary.belowOverall, 1);
    assert.equal(result.summary.excludedByLeague, 1);
    assert.equal(result.players.length, 4);
    assert.equal(result.summary.identitiesRetained, 4);
    const ready = result.auctionCandidates[0];
    assert.equal(result.auctionCandidates.length, 1);
    assert.equal(ready.name, 'Ready');
    assert.equal(ready.catalogueStatus, 'identified');
    assert.equal(ready.leagueStatus, 'verified');
    assert.equal(ready.futureAuctionEligible, true);
    assert.equal(ready.auctionEligible, false);
    assert.equal(ready.imageRightsStatus, 'unverified');
    const noLeague = result.players.find((item) => item.name === 'No League');
    assert.equal(noLeague.catalogueStatus, 'identified');
    assert.equal(noLeague.leagueStatus, 'unknown');
    assert.equal(noLeague.futureAuctionEligible, false);
    assert.equal(result.reviewReports.unknownLeagues.some((item) => item.name === 'No League'), true);
    const low = result.players.find((item) => item.name === 'Low');
    assert.equal(low.catalogueStatus, 'identified');
    assert.equal(low.futureAuctionEligible, false);
    const other = result.players.find((item) => item.name === 'Other League');
    assert.equal(other.leagueStatus, 'needs_review');
    assert.equal(other.catalogueStatus, 'needs_review');
    assert.equal(result.excluded.some((item) => item.name === 'Low'), false);
    assert.equal(ready.basePrice, AUCTION_PRICES[ready.category]);
    assert.equal([10, 15, 25].includes(ready.basePrice), true);
  });

  it('keeps stable ids and the same result when generation repeats', () => {
    assert.equal(playerIdFor('Lionel Messi'), 'fut23_lionel_messi');
    assert.equal(normalizeName('Solskjær'), 'solskjaer');
    const cards = [
      card({ sourceImage: 'b.webp', overall: 96, sourceImageHash: 'b' }),
      card({ sourceImage: 'a.webp', overall: 99, sourceImageHash: 'a' })
    ];
    const first = buildImageCatalogue(cards);
    const second = buildImageCatalogue([...cards].reverse());
    assert.deepEqual(second.players.map((player) => player.playerId), first.players.map((player) => player.playerId));
    assert.deepEqual(second.players.map((player) => player.sourceImage), first.players.map((player) => player.sourceImage));
  });

  it('only publishes a local player-card path and leaves approval off', () => {
    const remote = publicImagePath({ sourceImage: 'a.webp', sourcePath: 'https://example.com/a.webp' });
    assert.equal(remote, null);
    const local = presentImageCataloguePlayer(card({}));
    assert.equal(local.imagePath, '/player-cards/fut23_lionel_messi_primary.webp');
    assert.equal(local.cardArtApproved, false);
    assert.equal(local.auctionEligible, false);
    assert.equal(local.futureAuctionEligible, false);
    assert.equal(local.imageRightsStatus, 'unverified');
    assert.equal(local.remoteImage, false);
    assert.equal(String(local.imagePath).startsWith('http'), false);
  });

  it('reads the overall and position from real card images', () => {
    const script = `
from pathlib import Path
import json, image_card_read as reader
card = Path(r'${repoRoot.replaceAll('\\', '/')}/frontend/public/player-cards')
digits, letters = reader.load_templates(card)
samples = [
    card / 'fut23_bruno_fernandes_primary.webp',
    card / 'fut23_erling_haaland_card_05.webp',
    Path(r'D:/Draft11 dataset/images/1845.png')
]
rows = []
for path in samples:
    record, _name, _stats = reader.read_image(path, digits, letters)
    rows.append({'file': path.name, 'overall': record['overall'], 'position': record['position'], 'alts': record['alternatePositions']})
print(json.dumps(rows))
`;
    const result = spawnSync('python', ['-c', script], {
      cwd: path.join(repoRoot, 'backend', 'players'),
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(rows[0], { file: 'fut23_bruno_fernandes_primary.webp', overall: 88, position: 'RM', alts: [] });
    assert.equal(rows[1].overall, 96);
    assert.equal(rows[1].position, 'ST');
    assert.deepEqual(rows[1].alts, ['CF']);
    assert.equal(rows[2].overall, 86);
    assert.equal(rows[2].position, 'ST');
    assert.deepEqual(rows[2].alts, ['CF']);
  });
});
