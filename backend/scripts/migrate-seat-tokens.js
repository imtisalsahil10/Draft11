/**
 * Replace raw liveroom seat tokens with SHA-256 hashes.
 *
 * Refuses to run until CONFIRM_SEAT_TOKEN_MIGRATION=1 is set.
 * Stop the game server first. A running server can write the old raw token
 * back on its next save. The script backs up the matched rooms, checks that
 * backup, then updates only state.seats. It skips a room whose stateVersion
 * changed after the backup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { LiveRoom } from '../models.js';
import { migrateRoomDocument, verifySeatTokenBackup } from '../security/migrate-seat-tokens.js';

dotenv.config();

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.env.CONFIRM_SEAT_TOKEN_MIGRATION !== '1') {
  fail('Refusing to migrate live rooms. Review the backup plan, then set CONFIRM_SEAT_TOKEN_MIGRATION=1.');
}

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || 'football-auction';
if (!uri) fail('MONGODB_URI is not set.');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(repoRoot, 'data', 'backups', `seat-token-migration-${stamp}`);
const backupFile = path.join(backupDir, 'liverooms.json');

await mongoose.connect(uri, {
  dbName,
  serverSelectionTimeoutMS: 8000,
  connectTimeoutMS: 8000
});

try {
  const docs = await LiveRoom.find({ 'state.seats.seatToken': { $exists: true } }).lean();
  const plain = JSON.parse(JSON.stringify(docs));
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(backupFile, JSON.stringify(plain));
  const readBack = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  if (!verifySeatTokenBackup(plain, readBack)) {
    fail('Backup verification failed. No rooms were modified.');
  }

  let updated = 0;
  let skipped = 0;
  let unchanged = 0;
  for (const doc of plain) {
    const migrated = migrateRoomDocument(doc);
    if (!migrated.changed) {
      unchanged += 1;
      continue;
    }
    const result = await LiveRoom.updateOne(
      { _id: doc._id, stateVersion: doc.stateVersion },
      { $set: { 'state.seats': migrated.doc.state.seats } }
    );
    if (result.modifiedCount === 1) updated += 1;
    else skipped += 1;
  }

  console.log(JSON.stringify({
    backup: path.relative(repoRoot, backupFile),
    matched: plain.length,
    updated,
    unchanged,
    skipped
  }));
} finally {
  await mongoose.disconnect();
}
