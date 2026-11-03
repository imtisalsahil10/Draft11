/**
 * MONGODB WRITER FOR FIFA 23
 * Writes catalogue_players and player_cards only. Auction cards, users,
 * rooms, leagues, fixtures, and handoffs are fingerprinted and never modified.
 * A failed transaction is aborted. This file does not import seed.js.
 */

import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { EJSON } from 'bson';
import mongoose from 'mongoose';
import { CataloguePlayer, PlayerCard } from '../models.js';

export const PROTECTED_COLLECTIONS = [
  'cards',
  'players',
  'games',
  'liverooms',
  'leagues',
  'fixtures',
  'auctionhandoffs'
];

export async function assertTransactionsAvailable() {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    const error = new Error('Refusing to write without a replica-set transaction. No catalogue records were written.');
    error.code = 'NO_TRANSACTION';
    throw error;
  }
}

export async function fingerprintProtected() {
  const db = mongoose.connection.db;
  const out = [];
  for (const name of PROTECTED_COLLECTIONS) {
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    const hash = createHash('sha256');
    for (const doc of docs) hash.update(EJSON.stringify(doc));
    out.push({ name, count: docs.length, sha256: hash.digest('hex') });
  }
  return out;
}

export async function countStored(playerIds, cardIds) {
  const [players, cards] = await Promise.all([
    CataloguePlayer.countDocuments({ playerId: { $in: playerIds } }),
    PlayerCard.countDocuments({ cardId: { $in: cardIds } })
  ]);
  return { players, cards };
}

export async function auctionCardIds() {
  const ids = await mongoose.connection.db.collection('cards').distinct('id');
  return ids.map((id) => String(id));
}

export async function backupCatalogue(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const players = await CataloguePlayer.find().lean();
  const cards = await PlayerCard.find().lean();
  const protectedCounts = await fingerprintProtected();
  const payload = { players, cards, protected: protectedCounts, createdAt: new Date().toISOString() };
  const file = path.join(directory, 'catalogue-backup.json');
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, EJSON.stringify(payload, undefined, 2));
  fs.renameSync(temp, file);
  return { file, players: players.length, cards: cards.length };
}

function withoutMongoId(doc) {
  const copy = { ...doc };
  delete copy._id;
  delete copy.__v;
  return copy;
}

export function createMongoCatalogue() {
  return {
    async readPlayers() {
      const rows = await CataloguePlayer.find().lean();
      return rows.map(withoutMongoId);
    },
    async readCards() {
      const rows = await PlayerCard.find().lean();
      return rows.map(withoutMongoId);
    },
    async backup() {
      return { players: await this.readPlayers(), cards: await this.readCards() };
    },
    async transaction(work) {
      await CataloguePlayer.createIndexes();
      await PlayerCard.createIndexes();
      const players = CataloguePlayer.collection;
      const cards = PlayerCard.collection;
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        await work({
          async insertPlayers(docs) {
            await players.insertMany(docs, { session, ordered: true });
          },
          async updatePlayers(docs) {
            await players.bulkWrite(docs.map((doc) => ({
              updateOne: { filter: { playerId: doc.playerId }, update: { $set: doc } }
            })), { session, ordered: true });
          },
          async insertCards(docs) {
            await cards.insertMany(docs, { session, ordered: true });
          },
          async updateCards(docs) {
            await cards.bulkWrite(docs.map((doc) => ({
              updateOne: { filter: { cardId: doc.cardId }, update: { $set: doc } }
            })), { session, ordered: true });
          }
        });
        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction().catch(() => {});
        throw err;
      } finally {
        await session.endSession();
      }
    }
  };
}
