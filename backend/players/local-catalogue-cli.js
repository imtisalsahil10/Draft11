/**
 * IMPORT THE LOCAL IMAGE CATALOGUE
 * Reads an original card-image catalogue, publishes selected card images, and
 * writes data/local-catalogue. A published catalogue is refused and does not
 * change the store. Does not connect to MongoDB and does not change the live
 * auction deck.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { importImageCatalogue } from './local-catalogue.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const result = await importImageCatalogue({
  sourceFile: path.join(repoRoot, 'data', 'image-catalogue', 'player-catalogue.json'),
  storeFile: path.join(repoRoot, 'data', 'local-catalogue', 'catalogue.json'),
  publicDir: path.join(repoRoot, 'frontend', 'public', 'player-cards'),
  now: new Date()
});

const audit = result.audit || {};
console.log(JSON.stringify({
  ok: result.ok,
  format: result.format || null,
  code: result.code || null,
  error: result.error || null,
  written: result.written,
  copied: result.copied,
  insertedPlayers: result.insertedPlayers,
  updatedPlayers: result.updatedPlayers,
  skippedPlayers: result.skippedPlayers,
  totalPlayerIdentities: audit.totalPlayerIdentities,
  totalSelectedCards: audit.totalSelectedCards,
  imagesServed: audit.imagesServed,
  missingImageFiles: audit.missingImageFiles?.length || 0,
  brokenPaths: audit.brokenPaths?.length || 0,
  duplicateImageAssignments: audit.duplicateImageAssignments?.length || 0,
  playersWithFallback: audit.playersWithFallback?.length || 0,
  excluded: audit.excluded?.length || 0,
  liveAuctionActivated: false
}, null, 2));

if (!result.ok) process.exit(1);
