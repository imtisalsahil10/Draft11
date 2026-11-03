/**
 * Build the identity verification layer beside the image catalogue.
 * Does not modify player-catalogue.json, MongoDB, or auction eligibility.
 */

import { spawn } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildIdentityCatalogue, wikidataQueryNames } from './identity-verify.js';
import { writeIdentityWorkbook } from './identity-report.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const dataDir = path.join(repoRoot, 'data', 'image-catalogue');
const backupDir = path.join(dataDir, 'backup-phase3');

function backupOnce(fileName, fromDir) {
  const from = path.join(fromDir, fileName);
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, fileName);
  if (!fs.existsSync(dest)) fs.copyFileSync(from, dest);
}

function runPython(names, cachePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [
      path.join(repoRoot, 'backend', 'players', 'wikidata_fut23.py'),
      cachePath
    ], { cwd: repoRoot, windowsHide: true });
    child.stdin.end(JSON.stringify(names));
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `wikidata fetch exited ${code}`));
      else resolve();
    });
  });
}

export async function generateIdentityVerification({ skipWikidata = false } = {}) {
  for (const name of [
    'player-catalogue.json',
    'alternative-cards.json',
    'manual-review.json',
    'excluded-cards.json',
    'review-reports.json'
  ]) backupOnce(name, dataDir);
  backupOnce('Draft11_Image_Based_Player_Database.xlsx', repoRoot);

  const catalogue = JSON.parse(fs.readFileSync(path.join(dataDir, 'player-catalogue.json'), 'utf8'));
  const alternatives = JSON.parse(fs.readFileSync(path.join(dataDir, 'alternative-cards.json'), 'utf8'));
  const cachePath = path.join(dataDir, 'wikidata-cache.json');
  const queryNames = wikidataQueryNames(catalogue.players);
  fs.writeFileSync(path.join(dataDir, 'wikidata-query-names.json'), JSON.stringify(queryNames, null, 2));
  if (!skipWikidata) await runPython(queryNames, cachePath);
  const wikidata = fs.existsSync(cachePath)
    ? JSON.parse(fs.readFileSync(cachePath, 'utf8')).players || {}
    : {};
  const result = buildIdentityCatalogue(catalogue.players, alternatives, wikidata);
  const stored = {
    generatedAt: new Date().toISOString(),
    sourceCatalogue: 'data/image-catalogue/player-catalogue.json',
    backup: 'data/image-catalogue/backup-phase3',
    liveAuctionActivated: false,
    cardArtApproved: false,
    imageRightsStatus: 'unverified',
    referenceDate: result.summary.referenceDate,
    wikidataSource: result.summary.source,
    summary: result.summary,
    records: result.records,
    duplicates: result.duplicates
  };
  fs.writeFileSync(path.join(dataDir, 'player-identity-verification.json'), JSON.stringify(stored, null, 2));
  fs.writeFileSync(path.join(dataDir, 'identity-duplicates.json'), JSON.stringify(result.duplicates, null, 2));
  const thumbDir = path.join(dataDir, 'thumbs');
  const publicThumbs = path.join(repoRoot, 'frontend', 'public', 'identity-thumbs');
  fs.mkdirSync(publicThumbs, { recursive: true });
  const reviewRows = result.records.map((record) => {
    let reviewImage = record.imagePath || null;
    const thumbName = record.sourceImage ? `${path.parse(record.sourceImage).name}.jpg` : null;
    const thumb = thumbName ? path.join(thumbDir, thumbName) : null;
    if (thumb && fs.existsSync(thumb)) {
      const dest = path.join(publicThumbs, thumbName);
      if (!fs.existsSync(dest)) fs.copyFileSync(thumb, dest);
      reviewImage = `/identity-thumbs/${thumbName}`;
    }
    return {
    playerId: record.playerId,
    extractedName: record.extractedName,
    ocrName: record.ocrName,
    proposedCanonicalName: record.identity.proposedCanonicalName,
    proposedPlayerId: record.identity.proposedPlayerId,
    status: record.verificationStatus,
    matchConfidence: record.identity.matchConfidence,
    reason: record.identity.reason,
    evidence: record.identity.evidence,
    overall: record.overall,
    position: record.position,
    imagePath: record.imagePath,
    sourceImage: record.sourceImage,
    nationality: record.enriched.nationality,
    club: record.enriched.club,
    league: record.enriched.league,
    fullName: record.enriched.fullName,
    reviewImage,
    auctionEligible: false
  };
  });
  fs.writeFileSync(path.join(repoRoot, 'frontend', 'public', 'identity-review.json'), JSON.stringify({
    liveAuctionActivated: false,
    summary: result.summary,
    records: reviewRows
  }));
  const workbook = path.join(repoRoot, 'Draft11_Player_Identity_Verification.xlsx');
  await writeIdentityWorkbook(workbook, result, path.join(dataDir, 'thumbs'));
  return { workbook, summary: result.summary, dataDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateIdentityVerification({
    skipWikidata: process.argv.includes('--skip-wikidata')
  }).then((result) => {
    console.log(JSON.stringify(result.summary, null, 2));
    console.log(result.workbook);
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
