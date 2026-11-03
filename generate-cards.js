#!/usr/bin/env node

/**
 * FOOTBALL AUCTION GAME - CARD GENERATION SCRIPT
 * 
 * Purpose: Generate cards.json from CSV dataset
 * - Filters players by overall >= 90
 * - Removes duplicate/similar players (keeps better rating)
 * - Assigns rarity based on percentile distribution
 * - Ensures position variety in deck order
 * 
 * Usage: node generate-cards.js <input.csv> <output.json>
 */

const fs = require('fs');
const path = require('path');
const { createReadStream } = require('fs');
const { createInterface } = require('readline');

// ============================================================================
// CONSTANTS
// ============================================================================

const MIN_OVERALL = 90;
const RARITY_THRESHOLDS = {
  LEGENDARY: 0.10,  // Top 10%
  RARE: 0.40,       // Next 30% (10-40%)
  BASIC: 1.00       // Remaining 60% (40-100%)
};

const RARITY_PRICES = {
  LEGENDARY: 25,
  RARE: 15,
  BASIC: 10
};

const POSITION_MAP = {
  'GK': 'GK',
  'CB': 'CB',
  'LB': 'LB',
  'RB': 'RB',
  'LWB': 'LWB',
  'RWB': 'RWB',
  'CM': 'CM',
  'CDM': 'CDM',
  'CAM': 'CAM',
  'LM': 'LM',
  'RM': 'RM',
  'ST': 'ST',
  'CF': 'CF',
  'LW': 'LW',
  'RW': 'RW'
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Parse position string (handle multiple formats)
 * @param {string} positionStr - Raw position string from CSV
 * @returns {string} - Primary position (GK, CB, LB, etc.)
 */
function extractPrimaryPosition(positionStr) {
  if (!positionStr) return 'ST';
  
  const cleaned = positionStr.trim().split(/[\s,]/)[0].toUpperCase();
  return POSITION_MAP[cleaned] || 'ST';
}

/**
 * Normalize player name (remove duplicates)
 * @param {string} name - Player name
 * @returns {string} - Normalized name
 */
function normalizePlayerName(name) {
  return name.trim().toLowerCase();
}

/**
 * Create unique identifier from player data
 * Used to detect similar/duplicate players
 * @param {object} player - Player object
 * @returns {string} - Unique key
 */
function createPlayerKey(player) {
  const name = normalizePlayerName(player.name);
  const position = extractPrimaryPosition(player.position);
  const club = String(player.club || '').trim();
  
  // Key: "name_position_club"
  // This allows same player in different clubs but removes exact duplicates
  return `${name}_${position}_${club}`;
}

/**
 * Determine rarity category based on percentile
 * @param {number} percentile - Value 0-1 (0 = top 0%, 1 = bottom 100%)
 * @returns {string} - LEGENDARY | RARE | BASIC
 */
function assignRarity(percentile) {
  if (percentile < RARITY_THRESHOLDS.LEGENDARY) return 'LEGENDARY';
  if (percentile < RARITY_THRESHOLDS.RARE) return 'RARE';
  return 'BASIC';
}

/**
 * Parse CSV line into object
 * @param {string} line - CSV line
 * @param {array} headers - CSV headers
 * @returns {object} - Parsed player object
 */
function parseCsvLine(line, headers) {
  // Simple CSV parser (handles basic cases)
  const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
  const player = {};
  
  headers.forEach((header, index) => {
    const value = values[index];
    
    // Type conversion
    if (['overall', 'pace', 'shooting', 'passing', 'defending', 'physical'].includes(header)) {
      player[header] = parseInt(value) || 0;
    } else {
      player[header] = value || '';
    }
  });
  
  return player;
}

/**
 * Build final card object
 * @param {object} player - Player data
 * @param {number} id - Card ID
 * @param {string} rarity - Rarity category
 * @returns {object} - Card object
 */
function createCard(player, id, rarity) {
  return {
    id: `card_${String(id).padStart(5, '0')}`,
    name: player.player_name || player.name || 'Unknown',
    position: extractPrimaryPosition(player.position),
    nationality: player.nationality || 'Unknown',
    club: String(player.club || 'Unknown'),
    stats: {
      pace: Math.min(99, Math.max(0, player.pace || 0)),
      shooting: Math.min(99, Math.max(0, player.shooting || 0)),
      passing: Math.min(99, Math.max(0, player.passing || 0)),
      defense: Math.min(99, Math.max(0, player.defending || player.defense || 0)),
      physical: Math.min(99, Math.max(0, player.physical || 0)),
      overall: Math.min(99, Math.max(0, player.overall || 0))
    },
    category: rarity,
    basePrice: RARITY_PRICES[rarity]
  };
}

/**
 * Remove duplicate players, keeping the one with better overall rating
 * @param {array} players - All filtered players
 * @returns {array} - Deduplicated players
 */
function deduplicatePlayers(players) {
  const playerMap = {};
  
  // Sort by overall descending (highest rating wins)
  players.sort((a, b) => (b.overall || 0) - (a.overall || 0));
  
  for (const player of players) {
    const key = createPlayerKey(player);
    
    // Keep first occurrence (highest rating)
    if (!playerMap[key]) {
      playerMap[key] = player;
    }
  }
  
  return Object.values(playerMap);
}

/**
 * Ensure position variety in deck order
 * No more than 2 consecutive cards with same position
 * @param {array} cards - Card array
 * @returns {array} - Reordered cards
 */
function ensurePositionVariety(cards) {
  const reordered = [];
  const remaining = [...cards];
  
  while (remaining.length > 0) {
    const lastPosition = reordered.length > 0 
      ? reordered[reordered.length - 1].position 
      : null;
    
    const secondLastPosition = reordered.length > 1
      ? reordered[reordered.length - 2].position
      : null;
    
    // Try to find a card with different position
    let nextCard = null;
    let nextIndex = -1;
    
    if (lastPosition === secondLastPosition) {
      // Must pick different position
      nextIndex = remaining.findIndex(card => card.position !== lastPosition);
    } else if (lastPosition) {
      // Prefer different position, but allow same
      nextIndex = remaining.findIndex(card => card.position !== lastPosition);
      if (nextIndex === -1) {
        nextIndex = 0; // Fallback to first available
      }
    } else {
      nextIndex = 0; // First card
    }
    
    if (nextIndex >= 0) {
      nextCard = remaining.splice(nextIndex, 1)[0];
      reordered.push(nextCard);
    }
  }
  
  return reordered;
}

// ============================================================================
// MAIN PROCESSING
// ============================================================================

/**
 * Read CSV file and generate cards.json
 * @param {string} csvPath - Input CSV file path
 * @param {string} jsonPath - Output JSON file path
 */
async function generateCards(csvPath, jsonPath) {
  return new Promise((resolve, reject) => {
    const players = [];
    let headers = [];
    let lineCount = 0;
    
    const rl = createInterface({
      input: createReadStream(csvPath),
      crlfDelay: Infinity
    });
    
    console.log(`📖 Reading CSV: ${csvPath}`);
    
    rl.on('line', (line) => {
      if (!headers.length) {
        // First line = headers
        headers = line.split(',').map(h => 
          h.trim().toLowerCase().replace(/["\s]/g, '')
        );
        console.log(`📋 Headers detected: ${headers.join(', ')}`);
        return;
      }
      
      try {
        const player = parseCsvLine(line, headers);
        
        // Filter: overall >= 90
        if ((player.overall || 0) >= MIN_OVERALL) {
          players.push(player);
        }
        
        lineCount++;
        if (lineCount % 1000 === 0) {
          console.log(`⏳ Processed ${lineCount} lines...`);
        }
      } catch (err) {
        console.warn(`⚠️  Error parsing line: ${line.substring(0, 80)}...`);
      }
    });
    
    rl.on('close', () => {
      console.log(`\n✅ CSV read complete: ${lineCount} total lines, ${players.length} players with overall >= ${MIN_OVERALL}`);
      
      // STEP 1: Remove duplicates (keep better rating)
      console.log(`\n🔄 Removing duplicate players...`);
      const uniquePlayers = deduplicatePlayers(players);
      const duplicatesRemoved = players.length - uniquePlayers.length;
      console.log(`✅ Removed ${duplicatesRemoved} duplicate players (kept ${uniquePlayers.length} unique)`);
      
      // STEP 2: Sort by overall (descending)
      console.log(`\n📊 Assigning rarity based on percentile...`);
      uniquePlayers.sort((a, b) => (b.overall || 0) - (a.overall || 0));
      
      // STEP 3: Assign rarity and create cards
      const cards = uniquePlayers.map((player, index) => {
        const percentile = index / uniquePlayers.length;
        const rarity = assignRarity(percentile);
        return createCard(player, index + 1, rarity);
      });
      
      // Count by rarity
      const rarityCounts = {
        LEGENDARY: 0,
        RARE: 0,
        BASIC: 0
      };
      cards.forEach(card => rarityCounts[card.category]++);
      
      console.log(`  📍 Legendary (Top 10%): ${rarityCounts.LEGENDARY}`);
      console.log(`  📍 Rare (Next 30%): ${rarityCounts.RARE}`);
      console.log(`  📍 Basic (Remaining 60%): ${rarityCounts.BASIC}`);
      
      // STEP 4: Ensure position variety
      console.log(`\n🎯 Ensuring position variety in deck order...`);
      const finalCards = ensurePositionVariety(cards);
      
      // Count positions
      const positionCounts = {};
      finalCards.forEach(card => {
        positionCounts[card.position] = (positionCounts[card.position] || 0) + 1;
      });
      console.log(`✅ Position distribution: ${Object.entries(positionCounts)
        .map(([pos, count]) => `${pos}(${count})`)
        .join(', ')}`);
      
      // STEP 5: Write JSON
      console.log(`\n📝 Writing JSON output: ${jsonPath}`);
      try {
        fs.writeFileSync(jsonPath, JSON.stringify(finalCards, null, 2));
        console.log(`✅ Successfully created ${jsonPath}`);
        console.log(`   📦 Total cards: ${finalCards.length}`);
        console.log(`   💰 Total value: £${finalCards.reduce((sum, card) => sum + card.basePrice, 0)}`);
        
        resolve(finalCards);
      } catch (err) {
        reject(new Error(`Failed to write JSON: ${err.message}`));
      }
    });
    
    rl.on('error', reject);
  });
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
  console.error('The auction catalog is built by npm run import:players from data/imports/fifa.csv.');
  console.error('This older generator is not used.');
  process.exit(1);
}

main();
