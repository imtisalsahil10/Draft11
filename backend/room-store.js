/**
 * LIVE ROOM STORE
 * Serializes writes per room so a burst of mutations becomes one snapshot,
 * and a stale stateVersion cannot overwrite a newer document.
 */

import fs from 'fs';
import path from 'path';
import { LiveRoom } from './models.js';
import { ROOM_SCHEMA_VERSION } from './constants.js';
import { captureLiveRoom, materializeLiveRoom, shouldRecover } from './room-snapshot.js';
import { logWithTime } from './utils.js';

function clone(doc) {
  return JSON.parse(JSON.stringify(doc));
}

export class MemoryRoomWriter {
  constructor() {
    this.docs = new Map();
  }

  async save(doc, previousVersion) {
    const current = this.docs.get(doc.code);
    if (!current) {
      if (previousVersion !== 0) return false;
      this.docs.set(doc.code, clone(doc));
      return true;
    }
    if (current.stateVersion !== previousVersion) return false;
    this.docs.set(doc.code, clone(doc));
    return true;
  }

  async remove(code) {
    this.docs.delete(code);
  }

  async list() {
    return [...this.docs.values()].map((doc) => clone(doc));
  }
}

/**
 * Local test rooms only. Live rooms never go through this writer.
 */
export class FileRoomWriter {
  constructor(file) {
    this.file = file;
    this.docs = new Map();
    this.chain = Promise.resolve();
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : [];
    for (const doc of list) {
      if (doc?.code) this.docs.set(doc.code, doc);
    }
  }

  _flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify([...this.docs.values()]));
    fs.rmSync(this.file, { force: true });
    fs.renameSync(temp, this.file);
  }

  knows(code) {
    return this.docs.has(code);
  }

  _enqueue(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  async save(doc, previousVersion) {
    return this._enqueue(async () => {
      const current = this.docs.get(doc.code);
      if (!current) {
        if (previousVersion !== 0) return false;
      } else if (current.stateVersion !== previousVersion) return false;
      this.docs.set(doc.code, clone(doc));
      this._flush();
      return true;
    });
  }

  async remove(code) {
    return this._enqueue(async () => {
      this.docs.delete(code);
      if (this.file) this._flush();
    });
  }

  async list() {
    return this._enqueue(async () => [...this.docs.values()].map((doc) => clone(doc)));
  }
}

export class MongoRoomWriter {
  async save(doc, previousVersion) {
    if (!previousVersion) {
      const existing = await LiveRoom.findOne({ code: doc.code }).select('stateVersion').lean();
      if (!existing) {
        try {
          await LiveRoom.create(doc);
          return true;
        } catch (err) {
          if (err?.code !== 11000) throw err;
          return false;
        }
      }
      if (existing.stateVersion !== 0) return false;
    }

    const result = await LiveRoom.updateOne(
      { code: doc.code, stateVersion: previousVersion },
      { $set: doc }
    );
    return result.matchedCount === 1;
  }

  async remove(code) {
    await LiveRoom.deleteOne({ code });
  }

  async list() {
    return LiveRoom.find({ schemaVersion: ROOM_SCHEMA_VERSION }).lean();
  }
}

export function createRoomStore({
  roomExists,
  capture,
  applyVersion,
  enabled = () => true,
  writer
}) {
  const tails = new Map();
  const generation = new Map();
  const removed = new Set();

  function bump(code) {
    const next = (generation.get(code) || 0) + 1;
    generation.set(code, next);
    return next;
  }

  function enqueue(code, task) {
    const prev = tails.get(code) || Promise.resolve();
    const run = prev.then(task).catch((err) => {
      logWithTime(`Room store failed for ${code}: ${err.message}`, 'ERROR');
    });
    tails.set(code, run);
    return run;
  }

  async function write(code) {
    const draft = capture(code);
    if (!draft) {
      await writer.remove(code);
      return;
    }
    const previous = draft.stateVersion || 0;
    const doc = {
      ...draft,
      stateVersion: previous + 1,
      updatedAt: new Date()
    };
    const saved = await writer.save(doc, previous);
    if (!saved) {
      logWithTime(`Skipped stale room snapshot for ${code}`, 'WARN');
      return;
    }
    applyVersion?.(code, previous, doc.stateVersion);
  }

  function touch(code) {
    if (!enabled(code)) return Promise.resolve();
    if (!roomExists(code)) return forget(code);
    removed.delete(code);
    const gen = bump(code);
    return enqueue(code, async () => {
      if (removed.has(code)) return;
      if (generation.get(code) !== gen) return;
      if (!roomExists(code)) {
        await writer.remove(code);
        return;
      }
      await write(code);
    });
  }

  function forget(code) {
    if (!enabled(code)) return Promise.resolve();
    removed.add(code);
    const gen = bump(code);
    return enqueue(code, async () => {
      if (generation.get(code) !== gen) return;
      await writer.remove(code);
      removed.delete(code);
    });
  }

  function flush(code) {
    return tails.get(code) || Promise.resolve();
  }

  async function flushAll() {
    const pending = [...tails.values()];
    await Promise.all(pending);
  }

  return { touch, forget, flush, flushAll };
}

/**
 * Load rooms that have not expired. Each seat is offline: the sockets that
 * owned these seats died with the previous process.
 */
export async function restoreDurableRooms({
  writer,
  roomManager,
  auctionEngine,
  deckManager,
  catalog,
  now = Date.now()
}) {
  const docs = await writer.list();
  let restored = 0;
  for (const doc of docs) {
    if (!shouldRecover(doc, now)) {
      await writer.remove(doc.code);
      continue;
    }
    try {
      const live = materializeLiveRoom(doc, { catalog, socketsDead: true });
      roomManager.restoreRoom(live.room);
      if (live.auction) auctionEngine.restoreAuction(live.auction);
      if (live.auction) deckManager?.restoreRoomDeck(live.room.code, live.deck);
      restored += 1;
    } catch (err) {
      logWithTime(`Could not restore room ${doc.code}: ${err.message}`, 'ERROR');
    }
  }
  return restored;
}

export function captureFromManagers(roomManager, auctionEngine, code) {
  return captureLiveRoom(roomManager.getRoom(code), auctionEngine.getAuction(code));
}
