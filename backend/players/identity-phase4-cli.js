/**
 * Persist nothing into the live game. Back up the catalogue, attach dated
 * league evidence, and republish the local review file.
 */

import { spawn } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyLeagueEvidence } from './league-enrichment.js';
import { writeIdentityWorkbook } from './identity-report.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const dataDir = path.join(repoRoot, 'data', 'image-catalogue');
const backupDir = path.join(dataDir, 'backup-phase4');

function copyOnce(fileName, fromDir) {
  const from = path.join(fromDir, fileName);
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, fileName);
  if (!fs.existsSync(dest)) fs.copyFileSync(from, dest);
}

function verifiedClubNames(records) {
  return [...new Set(records
    .filter((record) => record.verificationStatus === 'verified' && record.enriched?.club?.status === 'verified')
    .map((record) => record.enriched.club.value)
    .filter(Boolean))].sort();
}

function fetchLeagues(names, output) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [
      path.join(repoRoot, 'backend', 'players', 'wikidata_leagues.py'),
      output
    ], { cwd: repoRoot, windowsHide: true });
    child.stdin.end(JSON.stringify(names));
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `league lookup exited ${code}`));
      else resolve();
    });
  });
}

function publishReview(stored, duplicates) {
  const byId = new Map(stored.records.map((record) => [record.playerId, record]));
  const records = stored.records.map((record) => ({
    playerId: record.playerId,
    extractedName: record.extractedName,
    ocrName: record.ocrName,
    proposedCanonicalName: record.identity?.proposedCanonicalName || null,
    proposedPlayerId: record.identity?.proposedPlayerId || null,
    status: record.verificationStatus,
    matchConfidence: record.identity?.matchConfidence ?? null,
    reason: record.identity?.reason || '',
    evidence: record.identity?.evidence || [],
    overall: record.overall ?? null,
    position: record.position ?? null,
    imagePath: record.imagePath || null,
    reviewImage: record.imagePath || null,
    sourceImage: record.sourceImage,
    nationality: record.enriched?.nationality || null,
    club: record.enriched?.club || null,
    league: record.enriched?.league || null,
    fullName: record.enriched?.fullName || null,
    auctionEligible: false
  }));
  const thumbDir = path.join(dataDir, 'thumbs');
  const publicThumbs = path.join(repoRoot, 'frontend', 'public', 'identity-thumbs');
  fs.mkdirSync(publicThumbs, { recursive: true });
  for (const record of records) {
    if (!record.sourceImage) continue;
    const thumbName = `${path.parse(record.sourceImage).name}.jpg`;
    const thumb = path.join(thumbDir, thumbName);
    if (!fs.existsSync(thumb)) continue;
    const dest = path.join(publicThumbs, thumbName);
    if (!fs.existsSync(dest)) fs.copyFileSync(thumb, dest);
    record.reviewImage = `/identity-thumbs/${thumbName}`;
  }
  const pairs = (duplicates || []).map((pair) => ({
    ...pair,
    reviewDecision: 'unresolved',
    left: byId.get(pair.playerId) ? records.find((record) => record.playerId === pair.playerId) : null,
    right: records.find((record) => record.playerId === pair.otherPlayerId) || null
  }));
  fs.writeFileSync(path.join(repoRoot, 'frontend', 'public', 'identity-review.json'), JSON.stringify({
    liveAuctionActivated: false,
    authenticated: false,
    summary: stored.summary,
    records,
    duplicates: pairs
  }));
}

export async function runPhase4({ skipLeagues = false } = {}) {
  for (const name of [
    'player-catalogue.json',
    'alternative-cards.json',
    'manual-review.json',
    'excluded-cards.json',
    'review-reports.json',
    'player-identity-verification.json',
    'identity-duplicates.json',
    'wikidata-cache.json'
  ]) copyOnce(name, dataDir);
  copyOnce('Draft11_Player_Identity_Verification.xlsx', repoRoot);
  copyOnce('identity-review.json', path.join(repoRoot, 'frontend', 'public'));

  const verificationPath = path.join(dataDir, 'player-identity-verification.json');
  const stored = JSON.parse(fs.readFileSync(verificationPath, 'utf8'));
  const duplicates = JSON.parse(fs.readFileSync(path.join(dataDir, 'identity-duplicates.json'), 'utf8'));
  const beforeIds = stored.records.map((record) => record.playerId);
  const leaguePath = path.join(dataDir, 'wikidata-leagues.json');
  const names = verifiedClubNames(stored.records);
  if (!skipLeagues) {
    try {
      await fetchLeagues(names, leaguePath);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
    }
  }
  const clubs = fs.existsSync(leaguePath)
    ? JSON.parse(fs.readFileSync(leaguePath, 'utf8')).clubs || {}
    : {};
  stored.records = applyLeagueEvidence(stored.records, clubs);
  const afterIds = stored.records.map((record) => record.playerId);
  if (beforeIds.join('\n') !== afterIds.join('\n')) {
    throw new Error('Player ids changed during league enrichment.');
  }
  stored.summary = {
    ...stored.summary,
    verifiedLeague: stored.records.filter((record) => record.enriched.league.status === 'verified').length,
    verifiedClub: stored.records.filter((record) => record.enriched.club.status === 'verified').length,
    verifiedNationality: stored.records.filter((record) => record.enriched.nationality.status === 'verified').length,
    liveAuctionActivated: false
  };
  stored.leagueSource = 'https://query.wikidata.org/sparql';
  stored.generatedAt = new Date().toISOString();
  fs.writeFileSync(verificationPath, JSON.stringify(stored, null, 2));
  publishReview(stored, duplicates);
  const workbook = path.join(repoRoot, 'Draft11_Player_Identity_Verification.xlsx');
  await writeIdentityWorkbook(workbook, {
    summary: stored.summary,
    records: stored.records,
    duplicates
  }, path.join(dataDir, 'thumbs'));
  return stored.summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase4({ skipLeagues: process.argv.includes('--skip-leagues') }).then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
