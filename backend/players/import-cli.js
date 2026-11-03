#!/usr/bin/env node

/**
 * Import data/imports/fifa.csv into cards.json.
 * MongoDB is updated only with --seed, and only by upsert. This command
 * never deletes cards. Destructive replacement stays on `npm run seed -- --replace`,
 * which writes a backup first.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importFifaCsv, FifaImportError } from './fifa-import.js';
import { findLocalPhoto, readApprovals } from './images.js';

const backendRoot = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const repoRoot = path.resolve(backendRoot, '..');

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
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

async function main() {
  if (process.argv.includes('--replace')) {
    throw new FifaImportError(
      'import:players does not delete cards. Run npm run seed -- --replace only when you intend to clear the collection. That command writes a backup first.',
      'REPLACE_REFUSED'
    );
  }

  const csvPath = path.resolve(repoRoot, typeof option('csv') === 'string' ? option('csv') : 'data/imports/fifa.csv');
  const outPath = path.resolve(repoRoot, typeof option('out') === 'string' ? option('out') : 'cards.json');
  const imageDir = path.resolve(
    repoRoot,
    typeof option('images') === 'string' ? option('images') : 'frontend/public/player-images'
  );
  const approvalsPath = path.resolve(
    repoRoot,
    typeof option('approvals') === 'string' ? option('approvals') : 'data/player-image-approvals.json'
  );
  if (!fs.existsSync(csvPath)) {
    throw new FifaImportError(
      `FIFA CSV not found at ${csvPath}. Place the supplied fifa.csv there and run the import again.`,
      'MISSING_CSV'
    );
  }

  const importedAt = typeof option('imported-at') === 'string'
    ? option('imported-at')
    : new Date().toISOString();
  const approvals = readApprovals(approvalsPath);
  const result = importFifaCsv(fs.readFileSync(csvPath, 'utf8'), {
    importedAt,
    approvals,
    imageFor: (sofifaId) => findLocalPhoto(imageDir, sofifaId)
  });

  writeJson(outPath, result.cards);
  const report = {
    ...result.report,
    csv: path.relative(repoRoot, csvPath).replaceAll('\\', '/'),
    catalog: path.relative(repoRoot, outPath).replaceAll('\\', '/'),
    seeded: false
  };

  if (process.argv.includes('--seed')) {
    const { upsertCards } = await import('../seed.js');
    const seeded = await upsertCards(result.cards, { replace: false });
    const { disconnectDatabase } = await import('../db.js');
    await disconnectDatabase();
    report.seeded = true;
    report.upserted = seeded.upserted;
    report.skipped = seeded.skipped;
    report.mongoCards = seeded.total;
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  const payload = {
    ok: false,
    error: err.message,
    code: err.code || 'IMPORT_FAILED'
  };
  if (err.details) payload.details = err.details;
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
