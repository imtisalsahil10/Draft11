#!/usr/bin/env node

/**
 * FIFA 23 IMPORT
 * Builds the eligible catalogue and, only with --confirm, inserts it.
 * Dry-run is the default. This command never deletes a collection and never
 * calls seed --replace.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { buildFut23Plan, Fut23PlanError } from './fut23-plan.js';
import { loadFut23Sources, defaultFut23Paths } from './fut23-sources.js';
import { applyFut23Import, diffFut23Import } from './fut23-apply.js';
import { auctionCardIds, assertTransactionsAvailable, backupCatalogue, countStored, createMongoCatalogue, fingerprintProtected } from './fut23-mongo.js';
import { writeFut23Report } from './fut23-report.js';

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(backendRoot, '..');
dotenv.config({ path: path.join(backendRoot, '.env') });

function option(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function commands() {
  return [
    ['npm run import:fut23', 'Read MongoDB, build the plan, and write nothing.'],
    ['npm run import:fut23:confirm', 'Back up the catalogue collections, then insert eligible records in a transaction.'],
    ['npm --prefix backend test', 'Backend test suite, including the FIFA 23 plan tests.'],
    ['npm --prefix frontend run lint', 'Frontend lint.'],
    ['npm --prefix frontend run build', 'Frontend production build.']
  ];
}

function reviewDocument(plan) {
  const flaggedLive = plan.alreadyLive.filter((player) => player.identityStatus !== 'name_group_consistent');
  return {
    generatedAt: new Date().toISOString(),
    excludedFromAutomaticImport: plan.excludedReview.length,
    note: 'These identities were not imported. Confirm each one before any later insert. Live fifa_ cards were not modified.',
    players: plan.excludedReview,
    flaggedButAlreadyInLiveCatalogue: flaggedLive
  };
}

function publicResult(plan, applied, extra = {}) {
  return {
    ok: applied ? applied.ok : true,
    written: Boolean(applied?.written),
    importedPlayers: applied?.written ? applied.insertPlayers.length + applied.updatePlayers.length : 0,
    importedCards: applied?.written ? applied.insertCards.length + applied.updateCards.length : 0,
    insertedPlayers: applied?.insertPlayers.length || 0,
    updatedPlayers: applied?.updatePlayers.length || 0,
    skippedPlayers: applied?.skipPlayers.length || 0,
    insertedCards: applied?.insertCards.length || 0,
    updatedCards: applied?.updateCards.length || 0,
    skippedCards: applied?.skipCards.length || 0,
    rejectedReview: plan.excludedReview.length,
    rejectedAlreadyLive: plan.alreadyLive.length,
    conflicts: applied?.conflicts.length || 0,
    failed: applied && applied.ok === false ? 1 : 0,
    failure: applied?.error || applied?.code || '',
    rolledBack: Boolean(applied?.rolledBack),
    ...extra
  };
}

async function main() {
  if (process.argv.includes('--replace')) {
    throw new Fut23PlanError(
      'import:fut23 does not delete or replace collections, and it does not call seed --replace.',
      'REPLACE_REFUSED'
    );
  }
  const confirm = process.argv.includes('--confirm');
  const dryRun = !confirm || process.argv.includes('--dry-run');
  const paths = defaultFut23Paths(repoRoot);
  if (typeof option('csv') === 'string') paths.csv = path.resolve(option('csv'));
  if (typeof option('workbook') === 'string') paths.workbook = path.resolve(option('workbook'));
  if (typeof option('images') === 'string') paths.images = path.resolve(option('images'));

  const loaded = await loadFut23Sources(paths);
  const plan = buildFut23Plan({ ...loaded, now: option('imported-at') || new Date().toISOString() });
  const reviewPath = path.join(repoRoot, 'data', 'imports', 'fut23-identity-review.json');
  writeJson(reviewPath, reviewDocument(plan));

  let applied = null;
  let backupFile = null;
  const mongo = { connected: false };
  await connectDatabase();
  mongo.connected = true;
  const before = await fingerprintProtected();
  const protectedIds = await auctionCardIds();
  const catalogue = createMongoCatalogue();
  const diff = diffFut23Import(
    await catalogue.readPlayers(),
    await catalogue.readCards(),
    plan,
    protectedIds
  );
  if (diff.conflicts.length) {
    applied = { ok: false, written: false, code: 'IDENTITY_CONFLICT', ...diff };
  } else if (!dryRun) {
    const writes = diff.insertPlayers.length + diff.updatePlayers.length + diff.insertCards.length + diff.updateCards.length;
    if (writes) {
      await assertTransactionsAvailable();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = await backupCatalogue(path.join(repoRoot, 'data', 'backups', `fut23-${stamp}`));
      backupFile = backup.file;
      applied = await applyFut23Import(catalogue, plan, { protectedIds });
    } else {
      applied = { ok: true, written: false, ...diff };
    }
    const afterWrite = await fingerprintProtected();
    const changed = afterWrite.filter((item) => {
      const prior = before.find((row) => row.name === item.name);
      return !prior || prior.count !== item.count || prior.sha256 !== item.sha256;
    });
    if (changed.length) {
      applied = {
        ...applied,
        ok: false,
        code: 'PROTECTED_CHANGED',
        error: `Protected collections changed during the import: ${changed.map((item) => item.name).join(', ')}. Existing auction, league, and user documents were not modified by this command.`
      };
    }
  } else {
    applied = { ok: true, written: false, ...diff };
  }

  const after = dryRun ? before : await fingerprintProtected();
  const stored = await countStored(plan.players.map((player) => player.playerId), plan.cards.map((card) => card.cardId));
  const result = publicResult(plan, applied, {
    mode: dryRun ? 'dry-run' : 'confirm',
    importedPlayers: dryRun ? 0 : stored.players,
    importedCards: dryRun ? 0 : stored.cards,
    cataloguePlayers: stored.players,
    catalogueCards: stored.cards,
    backup: backupFile ? path.relative(repoRoot, backupFile).replaceAll('\\', '/') : null,
    reviewFile: 'data/imports/fut23-identity-review.json',
    protectedUnchanged: JSON.stringify(before) === JSON.stringify(after),
    mongo
  });
  const reportPath = path.join(repoRoot, 'Draft11_FUT23_Migration_Report.xlsx');
  await writeFut23Report(reportPath, {
    summary: plan.summary,
    result,
    players: plan.players,
    cards: plan.cards,
    excludedReview: plan.excludedReview,
    alreadyLive: plan.alreadyLive,
    commands: commands(),
    tests: { status: 'not recorded', detail: 'Run the backend and frontend checks, then record them on this sheet.' }
  });
  writeJson(path.join(repoRoot, 'data', 'imports', 'fut23-last-run.json'), {
    summary: plan.summary,
    result,
    excludedReview: plan.excludedReview,
    alreadyLive: plan.alreadyLive
  });
  console.log(JSON.stringify({ ...result, summary: plan.summary }, null, 2));
  if (!applied.ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    const payload = { ok: false, error: err.message, code: err.code || 'IMPORT_FAILED' };
    if (err.details) payload.details = err.details;
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase().catch(() => {});
  });
