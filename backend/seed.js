#!/usr/bin/env node

/**
 * SEED MONGODB WITH CARDS
 * Upserts cards.json by catalog id. Existing rows that are not in the file
 * stay in place. Pass --replace to delete the collection first. That path
 * writes a backup of the current collection before it deletes anything.
 */

import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from './db.js';
import { Card } from './models.js';
import { isAllowedPlayerPhoto } from '../shared/player-photo.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Load environment variables
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load cards from JSON file
 */
function loadCardsFromFile(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`❌ Error reading cards file: ${err.message}`);
    process.exit(1);
  }
}

const STAT_KEYS = ['pace', 'shooting', 'passing', 'dribbling', 'defense', 'physical'];

function validStat(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 99;
}

function backupCards(cards) {
  const backupDir = path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `cards-${stamp}.json`);
  fs.writeFileSync(backupPath, `${JSON.stringify(cards, null, 2)}\n`, 'utf8');
  return backupPath;
}

function cardDocument(cardData) {
  const stats = { overall: Math.round(cardData.stats.overall) };
  for (const key of STAT_KEYS) {
    if (validStat(cardData.stats[key])) stats[key] = Math.round(cardData.stats[key]);
  }
  const document = {
    id: String(cardData.id),
    name: String(cardData.name),
    position: String(cardData.position || ''),
    nationality: String(cardData.nationality || 'Unknown'),
    club: String(cardData.club || 'Unknown'),
    stats,
    category: String(cardData.category || 'BASIC'),
    basePrice: parseInt(cardData.basePrice, 10) || 10
  };
  if (cardData.league) document.league = String(cardData.league);
  if (Number.isInteger(cardData.age)) document.age = cardData.age;
  if (Number.isInteger(cardData.potential)) document.potential = cardData.potential;
  if (cardData.longName) document.longName = String(cardData.longName);
  if (Array.isArray(cardData.alternatePositions)) {
    document.alternatePositions = cardData.alternatePositions.filter((item) => typeof item === 'string');
  }
  if (cardData.goalkeeping && typeof cardData.goalkeeping === 'object') {
    const goalkeeping = {};
    for (const [key, value] of Object.entries(cardData.goalkeeping)) {
      if (validStat(value) && value > 0) goalkeeping[key] = Math.round(value);
    }
    if (Object.keys(goalkeeping).length) document.goalkeeping = goalkeeping;
  }
  if (cardData.source?.sofifaId) {
    document.source = {
      dataset: 'fifa',
      version: String(cardData.source.version || 'fifa-csv'),
      sofifaId: Number(cardData.source.sofifaId),
      importedAt: cardData.source.importedAt ? new Date(cardData.source.importedAt) : new Date()
    };
  }
  if (isAllowedPlayerPhoto(cardData.photoRef)) {
    document.photoRef = cardData.photoRef;
    document.photoApproved = cardData.photoApproved === true;
  }
  return document;
}

/**
 * Upsert catalog cards by id. Cards that are not in this list stay in MongoDB.
 * replace deletes the collection only after a backup file is written.
 */
export async function upsertCards(cards, { replace = false } = {}) {
  await connectDatabase();
  try {
    const existingCount = await Card.countDocuments();
    console.log(`📊 Existing cards in database: ${existingCount}`);
    if (replace && existingCount > 0) {
      const existing = await Card.find().lean();
      const backupPath = backupCards(existing);
      console.log(`Backup written to ${backupPath}`);
      console.log('⚠️  --replace was passed. Clearing the card collection...');
      await Card.deleteMany({});
      console.log('🗑️  Cleared old cards');
    } else if (existingCount > 0) {
      console.log('Upserting by card id. Cards that are not in the catalog file are left in place.');
      console.log('Pass --replace only when you intend to delete the card collection.');
    }

    const startTime = Date.now();
    let upserted = 0;
    let skipped = 0;
    for (let index = 0; index < cards.length; index += 1) {
      const cardData = cards[index];
      if (!cardData.id || !cardData.name || !cardData.stats || !validStat(cardData.stats.overall)) {
        console.warn(`⚠️  Skipping invalid card: ${cardData.name || cardData.id}`);
        skipped += 1;
        continue;
      }
      const invalid = STAT_KEYS.find((key) => cardData.stats[key] != null && !validStat(cardData.stats[key]));
      if (invalid) {
        console.warn(`⚠️  Invalid ${invalid} stat for ${cardData.name}: ${cardData.stats[invalid]}`);
        skipped += 1;
        continue;
      }
      try {
        await Card.updateOne(
          { id: String(cardData.id) },
          { $set: cardDocument(cardData) },
          { upsert: true, runValidators: true }
        );
        upserted += 1;
        if ((index + 1) % 1000 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`⏳ Upserted ${index + 1}/${cards.length} in ${elapsed}s`);
        }
      } catch (err) {
        console.error(`❌ Error saving card ${cardData.name}: ${err.message}`);
        skipped += 1;
      }
    }
    const total = await Card.countDocuments();
    return { upserted, skipped, total };
  } catch (err) {
    await disconnectDatabase();
    throw err;
  }
}

/**
 * Seed cards to MongoDB
 */
async function seedCards() {
  try {
    // Load cards from file
    const cardsPath = path.join(__dirname, '..', 'cards.json');
    console.log(`📖 Reading cards from: ${cardsPath}`);
    
    const cards = loadCardsFromFile(cardsPath);
    console.log(`✅ Loaded ${cards.length} cards from JSON`);

    const replace = process.argv.includes('--replace');
    const started = Date.now();
    const result = await upsertCards(cards, { replace });
    const totalTime = ((Date.now() - started) / 1000).toFixed(1);

    console.log('\n✅ SEEDING COMPLETE');
    console.log(`   📦 Total cards in file: ${cards.length}`);
    console.log(`   ✔️  Upserted: ${result.upserted}`);
    console.log(`   ⏭️  Skipped: ${result.skipped}`);
    console.log(`   ⏱️  Time: ${totalTime}s`);

    console.log(`\n📊 Cards in MongoDB: ${result.total}`);

    // Show distribution
    const distribution = await Card.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    console.log('\n📈 Card Distribution:');
    for (const item of distribution) {
      console.log(`   ${item._id}: ${item.count}`);
    }

    // Show position distribution
    const positions = await Card.aggregate([
      { $group: { _id: '$position', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    console.log('\n🎯 Position Distribution:');
    for (const item of positions) {
      console.log(`   ${item._id}: ${item.count}`);
    }

    console.log('\n✨ Database seeding successful!');

  } catch (err) {
    console.error(`\n❌ Seeding failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  console.log('🎮 FOOTBALL AUCTION GAME - CARD SEEDING');
  console.log('========================================\n');
  seedCards();
}
