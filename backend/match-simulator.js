/**
 * Match Simulator Module
 * Simulates matches between teams based on their overall ratings and tactics
 */

import { GAME_CONFIG } from './constants.js';

function assertPlayableSquad(side) {
  const players = side?.team;
  if (!Array.isArray(players) || players.length === 0) return;
  if (players.length !== GAME_CONFIG.REQUIRED_TEAM_SIZE) {
    throw new Error(`Match squad must have exactly ${GAME_CONFIG.REQUIRED_TEAM_SIZE} players`);
  }
}

/**
 * Calculate match result between two teams
 * @param {Object} team1 - { playerId, username, team: Array, overall: Number }
 * @param {Object} team2 - { playerId, username, team: Array, overall: Number }
 * @returns {Object} Match result with score, winner, events
 */
function simulateMatch(team1, team2, random = Math.random) {
  if (!team1 || !team2) {
    throw new Error('Both teams required for match simulation');
  }
  if (typeof random !== 'function') {
    throw new Error('Match random source must be a function');
  }
  assertPlayableSquad(team1);
  assertPlayableSquad(team2);

  // A missing overall still uses 75 so existing live-room matches keep their
  // behavior. Zero is a real rating and must not be replaced.
  const overall1 = Number.isFinite(team1.overall) ? team1.overall : 75;
  const overall2 = Number.isFinite(team2.overall) ? team2.overall : 75;

  // Calculate win probability (sigmoid function for smoother distribution)
  const ratingDiff = overall1 - overall2;
  const team1WinProb = 1 / (1 + Math.exp(-ratingDiff / 10));

  // Base goals on team quality
  const baseGoals1 = Math.max(0, Math.floor((overall1 - 50) / 10));
  const baseGoals2 = Math.max(0, Math.floor((overall2 - 50) / 10));

  // Add randomness
  let goals1 = baseGoals1 + Math.floor(random() * 3);
  let goals2 = baseGoals2 + Math.floor(random() * 3);

  // Adjust based on win probability
  if (random() < team1WinProb) {
    goals1 += Math.floor(random() * 2);
  } else {
    goals2 += Math.floor(random() * 2);
  }

  // Ensure some score variation
  if (goals1 === goals2 && random() < 0.7) {
    if (random() < team1WinProb) {
      goals1++;
    } else {
      goals2++;
    }
  }

  // Generate match events (goals, assists)
  const events = generateMatchEvents(team1, team2, goals1, goals2, random);

  // Determine winner
  let winner = null;
  let winnerTeam = null;
  if (goals1 > goals2) {
    winner = team1.playerId;
    winnerTeam = team1;
  } else if (goals2 > goals1) {
    winner = team2.playerId;
    winnerTeam = team2;
  }

  return {
    team1: {
      playerId: team1.playerId,
      username: team1.username,
      goals: goals1,
      overall: overall1
    },
    team2: {
      playerId: team2.playerId,
      username: team2.username,
      goals: goals2,
      overall: overall2
    },
    winner,
    winnerUsername: winnerTeam?.username || null,
    isDraw: goals1 === goals2,
    events,
    matchStats: {
      possession: calculatePossession(overall1, overall2),
      shots: {
        team1: goals1 * 3 + Math.floor(random() * 5),
        team2: goals2 * 3 + Math.floor(random() * 5)
      },
      fouls: {
        team1: Math.floor(random() * 15) + 5,
        team2: Math.floor(random() * 15) + 5
      }
    }
  };
}

/**
 * Generate match events (goals, assists)
 * @param {Object} team1 
 * @param {Object} team2 
 * @param {Number} goals1 
 * @param {Number} goals2 
 * @returns {Array} Match events
 */
function generateMatchEvents(team1, team2, goals1, goals2, random = Math.random) {
  const events = [];

  // Generate goals for team1
  for (let i = 0; i < goals1; i++) {
    const scorer = getRandomAttacker(team1.team, random);
    const assister = random() < 0.7 ? getRandomMidfielder(team1.team, random) : null;
    
    events.push({
      minute: Math.floor(random() * 90) + 1,
      team: team1.username,
      type: 'goal',
      player: scorer?.name || 'Unknown',
      assist: assister?.name || null
    });
  }

  // Generate goals for team2
  for (let i = 0; i < goals2; i++) {
    const scorer = getRandomAttacker(team2.team, random);
    const assister = random() < 0.7 ? getRandomMidfielder(team2.team, random) : null;
    
    events.push({
      minute: Math.floor(random() * 90) + 1,
      team: team2.username,
      type: 'goal',
      player: scorer?.name || 'Unknown',
      assist: assister?.name || null
    });
  }

  // Sort by minute
  return events.sort((a, b) => a.minute - b.minute);
}

/**
 * Get random attacker from team
 */
function getRandomAttacker(team, random = Math.random) {
  if (!team || team.length === 0) return null;
  
  const attackers = team.filter(p => {
    const pos = (p.assignedPosition || p.position || '').split(/[\s,]/)[0];
    return ['ST', 'CF', 'LW', 'RW', 'CAM'].includes(pos);
  });

  return attackers.length > 0 
    ? attackers[Math.floor(random() * attackers.length)]
    : team[Math.floor(random() * team.length)];
}

/**
 * Get random midfielder from team
 */
function getRandomMidfielder(team, random = Math.random) {
  if (!team || team.length === 0) return null;
  
  const midfielders = team.filter(p => {
    const pos = (p.assignedPosition || p.position || '').split(/[\s,]/)[0];
    return ['CM', 'CAM', 'CDM', 'LM', 'RM'].includes(pos);
  });

  return midfielders.length > 0 
    ? midfielders[Math.floor(random() * midfielders.length)]
    : null;
}

/**
 * Calculate possession percentage
 */
function calculatePossession(overall1, overall2) {
  const left = Number.isFinite(overall1) ? overall1 : 0;
  const right = Number.isFinite(overall2) ? overall2 : 0;
  const total = left + right;
  if (total <= 0) return { team1: 50, team2: 50 };
  const team1Possession = Math.round((left / total) * 100);
  
  return {
    team1: team1Possession,
    team2: 100 - team1Possession
  };
}

/**
 * Simulate tournament (round-robin or knockout)
 * @param {Array} teams - Array of team objects
 * @param {String} format - 'round-robin' or 'knockout'
 * @returns {Object} Tournament results
 */
function simulateTournament(teams, format = 'round-robin') {
  if (!teams || teams.length < 2) {
    throw new Error('Need at least 2 teams for tournament');
  }

  if (format === 'round-robin') {
    return simulateRoundRobin(teams);
  } else {
    return simulateKnockout(teams);
  }
}

/**
 * Round-robin tournament (everyone plays everyone)
 */
function simulateRoundRobin(teams) {
  const standings = teams.map(t => ({
    playerId: t.playerId,
    username: t.username,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
    points: 0
  }));

  const matches = [];

  // Generate all possible matchups
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const result = simulateMatch(teams[i], teams[j]);
      matches.push(result);

      // Update standings
      const team1Standing = standings.find(s => s.playerId === teams[i].playerId);
      const team2Standing = standings.find(s => s.playerId === teams[j].playerId);

      team1Standing.played++;
      team2Standing.played++;
      team1Standing.goalsFor += result.team1.goals;
      team1Standing.goalsAgainst += result.team2.goals;
      team2Standing.goalsFor += result.team2.goals;
      team2Standing.goalsAgainst += result.team1.goals;

      if (result.isDraw) {
        team1Standing.drawn++;
        team2Standing.drawn++;
        team1Standing.points++;
        team2Standing.points++;
      } else if (result.winner === teams[i].playerId) {
        team1Standing.won++;
        team2Standing.lost++;
        team1Standing.points += 3;
      } else {
        team2Standing.won++;
        team1Standing.lost++;
        team2Standing.points += 3;
      }

      team1Standing.goalDifference = team1Standing.goalsFor - team1Standing.goalsAgainst;
      team2Standing.goalDifference = team2Standing.goalsFor - team2Standing.goalsAgainst;
    }
  }

  // Sort standings
  standings.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
    return b.goalsFor - a.goalsFor;
  });

  return {
    format: 'round-robin',
    standings,
    matches,
    winner: standings[0]
  };
}

/**
 * Knockout tournament (single elimination)
 */
function simulateKnockout(teams) {
  const rounds = [];
  let currentTeams = [...teams];

  while (currentTeams.length > 1) {
    const roundMatches = [];
    const winners = [];

    for (let i = 0; i < currentTeams.length; i += 2) {
      if (i + 1 < currentTeams.length) {
        const result = simulateMatch(currentTeams[i], currentTeams[i + 1]);
        roundMatches.push(result);

        // If draw, use overall as tiebreaker. A missing winner id falls back the same way.
        const higher = currentTeams[i].overall >= currentTeams[i + 1].overall
          ? currentTeams[i]
          : currentTeams[i + 1];
        const winnerTeam = result.isDraw
          ? higher
          : (currentTeams.find(t => t.playerId === result.winner) || higher);

        winners.push(winnerTeam);
      } else {
        // Bye
        winners.push(currentTeams[i]);
      }
    }

    rounds.push(roundMatches);
    currentTeams = winners;
  }

  return {
    format: 'knockout',
    rounds,
    winner: currentTeams[0],
    finalMatch: rounds[rounds.length - 1][0]
  };
}

export { simulateMatch, simulateTournament, generateMatchEvents, calculatePossession };
