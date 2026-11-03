/**
 * Team Builder Module
 * Handles team creation, validation, and overall calculation
 */

import { assignedStrength } from '../shared/squad-evaluation.js';

/**
 * Squad strength for a built XI. This is the shared lineup formula:
 * position fit, overall, and role stats, with missing numbers left out.
 * An overall of 0 stays 0. Nothing is replaced with 75.
 * @param {Array} team - Array of 11 cards with position assignments
 * @returns {Number} Squad strength
 */
function calculateTeamOverall(team) {
  if (!team || team.length !== 11) {
    throw new Error('Team must have exactly 11 players');
  }

  const strength = assignedStrength(team.map((player) => {
    const card = player.card || player;
    const role = player.assignedPosition
      || String(card.position || '').toUpperCase().split(/[^A-Z]+/).find(Boolean)
      || '';
    return { card, role };
  }));
  if (strength == null) {
    throw new Error('Team rating is unavailable');
  }
  return strength;
}

/**
 * Validate formation (e.g., "4-4-2", "4-3-3")
 * @param {Array} team - Array of 11 cards with assigned positions
 * @param {String} formation - Formation string (e.g., "4-4-2")
 * @returns {Object} { valid: Boolean, errors: Array }
 */
function validateFormation(team, formation = '4-4-2') {
  const errors = [];
  
  if (!team || team.length !== 11) {
    errors.push('Team must have exactly 11 players');
    return { valid: false, errors };
  }

  // Count positions
  const positions = {
    GK: 0,
    defenders: 0,
    midfielders: 0,
    forwards: 0
  };

  team.forEach(player => {
    const pos = (player.assignedPosition || player.position || 'ST').split(/[\s,]/)[0];
    
    if (pos === 'GK') {
      positions.GK++;
    } else if (['LB', 'CB', 'RB', 'LWB', 'RWB'].includes(pos)) {
      positions.defenders++;
    } else if (['CDM', 'CM', 'CAM', 'LM', 'RM'].includes(pos)) {
      positions.midfielders++;
    } else if (['LW', 'RW', 'CF', 'ST'].includes(pos)) {
      positions.forwards++;
    }
  });

  // Must have exactly 1 GK
  if (positions.GK !== 1) {
    errors.push(`Must have exactly 1 goalkeeper (found ${positions.GK})`);
  }

  // Parse formation (e.g., "4-4-2" -> [4, 4, 2])
  const formationParts = formation.split('-').map(Number);
  if (formationParts.length === 3) {
    const [def, mid, fwd] = formationParts;
    
    if (positions.defenders !== def) {
      errors.push(`Formation requires ${def} defenders (found ${positions.defenders})`);
    }
    if (positions.midfielders !== mid) {
      errors.push(`Formation requires ${mid} midfielders (found ${positions.midfielders})`);
    }
    if (positions.forwards !== fwd) {
      errors.push(`Formation requires ${fwd} forwards (found ${positions.forwards})`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    positions
  };
}

/**
 * Suggest optimal formation based on available cards
 * @param {Array} cards - Player's won cards
 * @returns {String} Suggested formation (e.g., "4-3-3")
 */
function suggestFormation(cards) {
  if (!cards || cards.length < 11) {
    return '4-4-2'; // Default
  }

  // Count available positions
  const counts = {
    GK: 0,
    defenders: 0,
    midfielders: 0,
    forwards: 0
  };

  cards.forEach(card => {
    const pos = (card.position || 'ST').split(/[\s,]/)[0];
    
    if (pos === 'GK') {
      counts.GK++;
    } else if (['LB', 'CB', 'RB', 'LWB', 'RWB'].includes(pos)) {
      counts.defenders++;
    } else if (['CDM', 'CM', 'CAM', 'LM', 'RM'].includes(pos)) {
      counts.midfielders++;
    } else if (['LW', 'RW', 'CF', 'ST'].includes(pos)) {
      counts.forwards++;
    }
  });

  // Suggest formation based on available players
  const defCount = Math.min(Math.max(counts.defenders, 3), 5);
  const fwdCount = Math.min(Math.max(counts.forwards, 1), 3);
  const midCount = 10 - defCount - fwdCount;

  return `${defCount}-${midCount}-${fwdCount}`;
}

function overallForSort(card) {
  const value = card?.stats?.overall ?? card?.overall;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/**
 * Auto-select best 11 players from won cards
 * @param {Array} cards - All cards won by player
 * @param {String} formation - Desired formation (optional)
 * @returns {Array} Best 11 cards with assigned positions
 */
function autoSelectTeam(cards, formation = '4-4-2') {
  if (!cards || cards.length < 11) {
    throw new Error('Need at least 11 cards to build a team');
  }

  // Sort by the printed overall. Zero stays zero. A missing number sorts last.
  const sortedCards = [...cards].sort((a, b) => overallForSort(b) - overallForSort(a));

  // Parse formation
  const [def, mid, fwd] = formation.split('-').map(Number);

  const team = [];
  const used = new Set();

  // Helper to find best card for position
  const findBest = (positions, count) => {
    const available = sortedCards.filter(card => {
      if (used.has(card.id)) return false;
      const pos = (card.position || '').split(/[\s,]/)[0];
      return positions.includes(pos);
    });

    for (let i = 0; i < count && i < available.length; i++) {
      const card = available[i];
      team.push({
        ...card,
        assignedPosition: (card.position || 'ST').split(/[\s,]/)[0]
      });
      used.add(card.id);
    }

    // Fill remaining with best available
    while (team.filter(p => positions.includes(p.assignedPosition)).length < count) {
      const fallback = sortedCards.find(c => !used.has(c.id));
      if (!fallback) break;
      team.push({
        ...fallback,
        assignedPosition: positions[0]
      });
      used.add(fallback.id);
    }
  };

  // 1. GK
  findBest(['GK'], 1);

  // 2. Defenders
  findBest(['LB', 'CB', 'RB', 'LWB', 'RWB'], def);

  // 3. Midfielders
  findBest(['CDM', 'CM', 'CAM', 'LM', 'RM'], mid);

  // 4. Forwards
  findBest(['LW', 'RW', 'CF', 'ST'], fwd);

  return team.slice(0, 11);
}

export { calculateTeamOverall, validateFormation, suggestFormation, autoSelectTeam };
