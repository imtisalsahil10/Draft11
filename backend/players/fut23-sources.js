/**
 * LOAD FIFA 23 SOURCES
 * Reads the csv, the master workbook, the reconciliation workbook, the live
 * catalogue, and the local card-image directory. Image files are not moved.
 */

import { spawnSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { rowsToObjects } from './csv.js';
import { Fut23PlanError } from './fut23-plan.js';

const IMAGE_FILE = /^fut23_[a-z0-9_]+_(?:primary|card_\d{2})\.webp$/;

export function defaultFut23Paths(repoRoot) {
  const dataset = path.resolve(repoRoot, '..', 'Draft11 dataset');
  return {
    csv: path.join(dataset, 'FIFA_23_Fut_Players.csv'),
    workbook: path.join(dataset, 'Draft11_Elite_Player_Database_With_Images.xlsx'),
    legacyCards: path.join(dataset, 'cards.json'),
    reconciliation: path.join(repoRoot, 'Draft11_Player_Catalogue_Reconciliation.xlsx'),
    liveCards: path.join(repoRoot, 'cards.json'),
    images: path.join(repoRoot, 'frontend', 'public', 'player-cards')
  };
}

export function readWorkbook(file, sheetNames) {
  const script = fileURLToPath(new URL('./read_sheets.py', import.meta.url));
  const result = spawnSync('python', [script, file, ...sheetNames], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) {
    throw new Fut23PlanError(`Could not run the workbook reader: ${result.error.message}`, 'WORKBOOK_READ');
  }
  if (result.status !== 0) {
    throw new Fut23PlanError(
      (result.stderr || 'Could not read the workbook.').trim(),
      'WORKBOOK_READ',
      { file }
    );
  }
  return JSON.parse(result.stdout);
}

export function readCsvRecords(csvPath) {
  const { headers, records } = rowsToObjects(fs.readFileSync(csvPath, 'utf8'));
  const required = ['Name', 'RAT', 'POS', 'VER', 'PAC', 'SHO', 'PAS', 'DRI', 'DEF', 'PHY'];
  const missing = required.filter((column) => !headers.includes(column));
  if (missing.length) {
    throw new Fut23PlanError(`FIFA 23 CSV is missing columns: ${missing.join(', ')}.`, 'MISSING_COLUMNS', { columns: missing });
  }
  // The workbook counts the header as row 1, so the first player is source row 2.
  return records.map((record, index) => ({ ...record, rowNumber: index + 2 }));
}

export function listLocalCardImages(directory) {
  const root = path.resolve(directory);
  if (!fs.existsSync(root)) {
    throw new Fut23PlanError(`Card image directory not found: ${root}`, 'MISSING_IMAGES');
  }
  const realRoot = fs.realpathSync(root);
  const names = [];
  for (const entry of fs.readdirSync(root)) {
    if (!IMAGE_FILE.test(entry)) continue;
    const candidate = path.resolve(root, entry);
    let realFile;
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile()) continue;
      realFile = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    const fromRoot = path.relative(realRoot, realFile);
    if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) continue;
    names.push(entry);
  }
  return names.sort();
}

export async function loadFut23Sources(paths) {
  for (const [key, file] of Object.entries(paths)) {
    if (key === 'images') continue;
    if (!fs.existsSync(file)) {
      throw new Fut23PlanError(`Required source is missing: ${file}`, 'MISSING_SOURCE', { key, file });
    }
  }
  const masterBook = await readWorkbook(paths.workbook, ['Master Players', 'All FUT Cards']);
  const reconciliationBook = await readWorkbook(paths.reconciliation, ['Missing From Live', 'Already In Live']);
  const masterRows = masterBook['Master Players'];
  const workbookCards = masterBook['All FUT Cards'];
  const missing = reconciliationBook['Missing From Live'];
  const already = reconciliationBook['Already In Live'];
  const liveCards = JSON.parse(fs.readFileSync(paths.liveCards, 'utf8'));
  const legacyCards = JSON.parse(fs.readFileSync(paths.legacyCards, 'utf8'));
  if (!Array.isArray(liveCards) || !Array.isArray(legacyCards)) {
    throw new Fut23PlanError('Card catalogues must be JSON arrays.', 'BAD_CATALOG');
  }
  return {
    csvRecords: readCsvRecords(paths.csv),
    masterRows,
    workbookCards,
    liveCards,
    legacyCards,
    imageFiles: listLocalCardImages(paths.images),
    reconciliation: {
      safeIds: missing
        .filter((row) => String(row.Disposition || '') === 'safe to insert later')
        .map((row) => String(row['Master player id'])),
      reviewIds: missing
        .filter((row) => String(row.Disposition || '') === 'ambiguous identity')
        .map((row) => String(row['Master player id'])),
      liveMasterIds: already.map((row) => String(row['Master player id']))
    }
  };
}
