/**
 * Temporary room files for tests. A test server must not read or write
 * data/local-test-rooms, which is the developer's local test auction store.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const developerStore = path.resolve(fileURLToPath(new URL('../../../data/local-test-rooms', import.meta.url)));

export function developerRoomFile() {
  return path.join(developerStore, 'rooms.json');
}

export function assertNotDeveloperStore(file) {
  const resolved = path.resolve(file);
  const relative = path.relative(developerStore, resolved);
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (inside) {
    throw new Error(`Refusing to use developer local-test storage: ${resolved}`);
  }
  return resolved;
}

export function createIsolatedRoomFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft11-test-rooms-'));
  const file = path.join(dir, 'rooms.json');
  return {
    dir,
    file,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function roomCodes(file) {
  if (!file || !fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : [];
  return list.map((doc) => doc?.code).filter(Boolean);
}
