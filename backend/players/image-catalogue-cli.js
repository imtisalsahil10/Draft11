/**
 * BUILD THE IMAGE CATALOGUE
 * Reads the local card images, writes a standalone JSON catalogue and the
 * audit workbook, and does not touch MongoDB or the live auction cards.
 */

import { spawn } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyOcr, buildImageCatalogue } from './image-catalogue.js';
import { writeImageCatalogueReport } from './image-catalogue-report.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const outDir = path.join(repoRoot, 'data', 'image-catalogue');
const cardDir = path.join(repoRoot, 'frontend', 'public', 'player-cards');
const datasetDir = path.join(repoRoot, '..', 'Draft11 dataset', 'images');

function run(command, args, options = {}) {
  const { input, quiet, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, windowsHide: true, ...spawnOptions });
    if (input != null) child.stdin.end(input);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!quiet) process.stderr.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `${command} exited ${code}`));
      else resolve(stdout);
    });
  });
}

function readOcr(file) {
  const byFile = new Map();
  if (!fs.existsSync(file)) return byFile;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    byFile.set(row.file, row.text || '');
  }
  return byFile;
}

export async function generateImageCatalogue({ skipRead = false, skipOcr = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const readingsFile = path.join(outDir, 'image-readings.json');
  const ocrFile = path.join(outDir, 'ocr.jsonl');
  if (!skipRead) {
    await run('python', [
      path.join(repoRoot, 'backend', 'players', 'image_card_read.py'),
      cardDir,
      datasetDir
    ]);
  }
  if (!skipOcr) {
    await run('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(repoRoot, 'backend', 'players', 'ocr-card-crops.ps1'),
      '-CropDir', path.join(outDir, 'crops'),
      '-OutFile', ocrFile
    ]);
  }
  const readings = JSON.parse(fs.readFileSync(readingsFile, 'utf8'));
  const ocr = readOcr(ocrFile);
  const cards = readings.map((reading) => applyOcr(
    reading,
    ocr.get(`${reading.cropId}_name.png`) || '',
    ocr.get(`${reading.cropId}_stats.png`) || ''
  ));
  const catalogue = buildImageCatalogue(cards);
  const previewPaths = [
    ...catalogue.selected,
    ...catalogue.alternatives,
    ...catalogue.review,
    ...catalogue.excluded
  ].map((card) => card.sourcePath).filter(Boolean);
  const uniquePaths = [...new Set(previewPaths)];
  const thumbJson = await run('python', [
    path.join(repoRoot, 'backend', 'players', 'image_thumbs.py'),
    path.join(outDir, 'thumbs')
  ], { input: JSON.stringify(uniquePaths), quiet: true });
  const thumbs = new Map(Object.entries(JSON.parse(thumbJson.trim())));
  const workbook = path.join(repoRoot, 'Draft11_Image_Based_Player_Database.xlsx');
  await writeImageCatalogueReport(workbook, catalogue, thumbs);
  const stored = {
    generatedAt: new Date().toISOString(),
    source: 'card-images',
    auctionEligible: false,
    cardArtApproved: false,
    imageRoots: {
      playerCards: '/player-cards/',
      datasetImages: datasetDir
    },
    summary: catalogue.summary,
    liveAuctionActivated: false,
    imageRightsStatus: 'unverified',
    players: catalogue.records,
    auctionCandidates: catalogue.auctionCandidates,
    reviewReports: catalogue.reviewReports
  };
  fs.writeFileSync(path.join(outDir, 'player-catalogue.json'), JSON.stringify(stored, null, 2));
  fs.writeFileSync(path.join(outDir, 'alternative-cards.json'), JSON.stringify(catalogue.alternatives, null, 2));
  fs.writeFileSync(path.join(outDir, 'manual-review.json'), JSON.stringify(catalogue.review, null, 2));
  fs.writeFileSync(path.join(outDir, 'review-reports.json'), JSON.stringify(catalogue.reviewReports, null, 2));
  fs.writeFileSync(path.join(outDir, 'excluded-cards.json'), JSON.stringify(catalogue.excluded, null, 2));
  return { workbook, catalogue: stored, outDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateImageCatalogue({
    skipRead: process.argv.includes('--skip-read'),
    skipOcr: process.argv.includes('--skip-ocr')
  }).then((result) => {
    console.log(JSON.stringify(result.catalogue.summary, null, 2));
    console.log(result.workbook);
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
