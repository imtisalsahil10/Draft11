/**
 * UTILITIES & HELPERS
 * Reusable utility functions
 */

import fs from 'fs';
import { randomInt } from 'node:crypto';

/**
 * Load cards from JSON file
 */
export function loadCards(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error loading cards: ${err.message}`);
    return [];
  }
}

/**
 * Generate random room code (6 uppercase alphanumeric)
 */
export function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += chars.charAt(randomInt(chars.length));
  }
  return code;
}

export function redactSecrets(message) {
  return String(message).replace(/mongodb(?:\+srv)?:\/\/[^\s'")]+/gi, 'mongodb://[redacted]');
}

/**
 * Format currency for display
 */
export function formatCurrency(amount) {
  return `£${amount.toFixed(2)}`;
}

/**
 * Calculate win probability between two teams (Elo-like)
 */
export function calculateWinProbability(team1Overall, team2Overall) {
  // Based on overall rating difference
  const diff = team1Overall - team2Overall;
  const probability = 1 / (1 + Math.pow(10, -diff / 400));
  return Math.round(probability * 100);
}

/**
 * Seeded random number generator (for deterministic match simulation)
 */
export class SeededRandom {
  constructor(seed) {
    this.seed = seed;
  }
  
  next() {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }
  
  nextInt(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

/**
 * Shuffle array using Fisher-Yates
 */
export function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Deep copy object
 */
export function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Log with timestamp
 */
export function logWithTime(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${redactSecrets(message)}`);
}

/**
 * Sleep (promise-based delay)
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
