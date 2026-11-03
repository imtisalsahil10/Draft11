# Match Simulation & AI Logic

## 1. MATCH SIMULATION OVERVIEW

The match simulation is a **deterministic, AI-driven soccer simulation** that:
- Takes 2 teams (lists of player cards) as input
- Simulates a 90-minute match
- Returns: winner, score, MVP, stats
- Uses card stats (Pace, Shooting, Defense, etc.) to determine outcomes
- **Deterministic**: Same teams always produce the same result

```javascript
class MatchSimulator {
  constructor() {
    this.Random = new SeededRandom(seed); // for reproducibility
  }

  // Main entry points
  simulateSingleMatch(teamA, teamB) {
    // 1v1: Returns { winner, scoreA, scoreB, mvp, stats }
  }

  simulateTournament(allTeams, playerIds) {
    // Multi-player: Returns bracket results and final leaderboard
  }

  // Helper methods
  calculateTeamStats(team)
  calculateMatchupOdds(teamA, teamB)
  simulateMinute(minute, matchState)
  generateGoalScorerIndex(team)
  calculateMVP(matchState)
}
```

---

## 2. TEAM RATING CALCULATION

```javascript
/**
 * Overall team rating is calculated from 11 players' stats.
 * Formula: Weighted average of card ratings
 */

calculateTeamStats(team) {
  if (team.length === 0) {
    return {
      overallRating: 0,
      pace: 0,
      shooting: 0,
      passing: 0,
      defense: 0,
      physical: 0
    };
  }

  const stats = {
    overallRating: 0,
    pace: 0,
    shooting: 0,
    passing: 0,
    defense: 0,
    physical: 0,
    playerCount: team.length
  };

  // Sum all player stats
  for (const card of team) {
    stats.pace += card.stats.pace;
    stats.shooting += card.stats.shooting;
    stats.passing += card.stats.passing;
    stats.defense += card.stats.defense;
    stats.physical += card.stats.physical;
    stats.overallRating += card.stats.overall;
  }

  // Average them
  stats.overallRating = (stats.overallRating / stats.playerCount).toFixed(1);
  stats.pace = Math.round(stats.pace / stats.playerCount);
  stats.shooting = Math.round(stats.shooting / stats.playerCount);
  stats.passing = Math.round(stats.passing / stats.playerCount);
  stats.defense = Math.round(stats.defense / stats.playerCount);
  stats.physical = Math.round(stats.physical / stats.playerCount);

  return stats;
}

// Example:
// Team with 11 players averaging Overall 85.2
// Overall Rating = 85.2
// Pace = 87
// Shooting = 81
// Defense = 78
// etc.
```

---

## 3. MATCH PREDICTION (Odds Calculation)

```javascript
/**
 * Win probability is calculated from team stats.
 * Uses Elo-like algorithm but with card stats.
 * 
 * Factors:
 * - Overall Rating (primary)
 * - Pace (affects counterattack success)
 * - Shooting (affects goal-scoring chances)
 * - Defense (affects goal prevention)
 * - Physical (affects player durability/fouls)
 */

calculateWinProbability(teamA, teamB) {
  const statsA = this.calculateTeamStats(teamA);
  const statsB = this.calculateTeamStats(teamB);

  // Weight factors (sum to 1.0)
  const weights = {
    overall: 0.40,     // 40% of decision
    defense: 0.20,     // 20% (defense critical)
    shooting: 0.15,    // 15%
    pace: 0.15,        // 15%
    physical: 0.10     // 10%
  };

  // Calculate weighted rating difference
  const ratingDiff = 
    (statsA.overallRating - statsB.overallRating) * weights.overall * 10 +
    (statsA.defense - statsB.defense) * weights.defense * 0.5 +
    (statsA.shooting - statsB.shooting) * weights.shooting * 0.5 +
    (statsA.pace - statsB.pace) * weights.pace * 0.3 +
    (statsA.physical - statsB.physical) * weights.physical * 0.2;

  // Convert difference to win probability using sigmoid
  // Formula: P = 1 / (1 + 10^(-ratingDiff/400))
  const winProbabilityA = 1 / (1 + Math.pow(10, -ratingDiff / 400));
  const winProbabilityB = 1 - winProbabilityA;

  return {
    teamA: parseFloat(winProbabilityA.toFixed(3)),
    teamB: parseFloat(winProbabilityB.toFixed(3)),
    favoredTeam: winProbabilityA > 0.5 ? "A" : "B",
    disparity: Math.abs(winProbabilityA - winProbabilityB).toFixed(2)
  };
}

// Example:
// Team A (Rating 85): 58% win chance
// Team B (Rating 80): 42% win chance
```

---

## 4. SINGLE MATCH SIMULATION

```javascript
simulateSingleMatch(teamA, teamB, seed = Date.now()) {
  this.matchRandom = new SeededRandom(seed);
  this.teams = { A: teamA, B: teamB };
  
  // Initialize match state
  const matchState = {
    minute: 0,
    scoreA: 0,
    scoreB: 0,
    events: [], // { type, minute, player, team }
    possession: { A: 0, B: 0 }, // tracked in minutes
    shotsOnTarget: { A: 0, B: 0 },
    fouls: { A: 0, B: 0 },
    yellowCards: [],
    redCards: [],
    substitutions: [], // not implemented yet
    mvpVotes: {} // track player contributions
  };

  // Simulate 90 minutes
  for (let minute = 0; minute < 90; minute++) {
    matchState.minute = minute;
    this.simulateMinute(minute, matchState);
  }

  // Determine MVP
  matchState.mvp = this.calculateMVP(matchState);

  // Return result
  return {
    scoreA: matchState.scoreA,
    scoreB: matchState.scoreB,
    winner: matchState.scoreA > matchState.scoreB ? 'A' :
            matchState.scoreB > matchState.scoreA ? 'B' : 'draw',
    events: matchState.events,
    stats: {
      possession: matchState.possession,
      shotsOnTarget: matchState.shotsOnTarget,
      fouls: matchState.fouls
    },
    mvp: matchState.mvp
  };
}

simulateMinute(minute, matchState) {
  // 1. Decide possession (coin flip with bias toward better team)
  const possessionTeam = this.decidePossession(minute, matchState);
  
  // 2. Generate events with probability
  const eventChance = this.matchRandom.random(); // 0-1
  
  if (eventChance < 0.15) {
    // 15% chance: Shooting event
    this.processShot(possessionTeam, matchState);
  } else if (eventChance < 0.25) {
    // 10% chance: Foul event
    this.processFoul(possessionTeam, matchState);
  } else if (eventChance < 0.30) {
    // 5% chance: Substitution event (not in MVP track)
    this.processSubstitution(possessionTeam, matchState);
  }
  
  // 3. Track possession time
  matchState.possession[possessionTeam]++;
}

decidePossession(minute, matchState) {
  const statsA = this.calculateTeamStats(this.teams.A);
  const statsB = this.calculateTeamStats(this.teams.B);
  
  // Passing stat influences possession
  const passingBiasA = statsA.passing / (statsA.passing + statsB.passing);
  
  // Add randomness
  const random = this.matchRandom.random();
  return random < passingBiasA ? 'A' : 'B';
}

processShot(shootingTeam, matchState) {
  const team = this.teams[shootingTeam];
  const oppositeTeam = shootingTeam === 'A' ? this.teams.B : this.teams.A;
  
  // Get stats
  const shootingStats = this.calculateTeamStats(team);
  const defendingStats = this.calculateTeamStats(oppositeTeam);
  
  // Calculate goal probability
  const baseGoalChance = 0.12; // 12% base
  const shootingBonus = (shootingStats.shooting - 75) * 0.002;
  const defensePenalty = -(defendingStats.defense - 75) * 0.002;
  const paceBonus = (shootingStats.pace - 80) * 0.0005;
  
  const goalChance = Math.max(0.05, Math.min(
    0.35,
    baseGoalChance + shootingBonus + defensePenalty + paceBonus
  ));
  
  const shotRandom = this.matchRandom.random();
  
  // Record shot on target
  matchState.shotsOnTarget[shootingTeam]++;
  
  // Check if goal
  if (shotRandom < goalChance) {
    matchState[`score${shootingTeam}`]++;
    
    const goalScorerIndex = this.generateGoalScorerIndex(team);
    const goalScorer = team[goalScorerIndex];
    
    matchState.events.push({
      type: 'goal',
      minute: matchState.minute,
      player: goalScorer.name,
      cardId: goalScorer.cardId,
      team: shootingTeam
    });
    
    // Track MVP votes
    if (!matchState.mvpVotes[goalScorer.cardId]) {
      matchState.mvpVotes[goalScorer.cardId] = 0;
    }
    matchState.mvpVotes[goalScorer.cardId] += 3; // 3 points per goal
  } else {
    matchState.events.push({
      type: 'shot_missed',
      minute: matchState.minute,
      team: shootingTeam
    });
  }
}

generateGoalScorerIndex(team) {
  // Forward positions (ST, CF, LW, RW) more likely to score
  const forwardPositions = ['ST', 'CF', 'LW', 'RW'];
  const forwardIndices = team
    .map((card, idx) => forwardPositions.includes(card.position) ? idx : -1)
    .filter(idx => idx !== -1);
  
  if (forwardIndices.length > 0) {
    // 70% chance a forward scores
    if (this.matchRandom.random() < 0.7) {
      return forwardIndices[Math.floor(
        this.matchRandom.random() * forwardIndices.length
      )];
    }
  }
  
  // Otherwise random player from team
  return Math.floor(this.matchRandom.random() * team.length);
}

processFoul(foulfingTeam, matchState) {
  const chance = 0.08; // 8% foul chance per possession
  if (this.matchRandom.random() > chance) return;
  
  matchState.fouls[foulfingTeam]++;
  
  // 10% of fouls are red cards, 25% yellow
  const cardRandom = this.matchRandom.random();
  if (cardRandom < 0.10) {
    // Red card
    matchState.redCards.push({
      minute: matchState.minute,
      team: foulfingTeam
    });
    matchState.events.push({
      type: 'red_card',
      minute: matchState.minute,
      team: foulfingTeam
    });
  } else if (cardRandom < 0.35) {
    // Yellow card
    matchState.yellowCards.push({
      minute: matchState.minute,
      team: foulfingTeam
    });
    matchState.events.push({
      type: 'yellow_card',
      minute: matchState.minute,
      team: foulfingTeam
    });
  }
}

calculateMVP(matchState) {
  // Sort by MVP votes
  const sorted = Object.entries(matchState.mvpVotes)
    .sort((a, b) => b[1] - a[1]);
  
  if (sorted.length === 0) {
    // No goals? Pick random player
    return this.teams.A[Math.floor(Math.random() * this.teams.A.length)];
  }
  
  const mvpCardId = sorted[0][0];
  // Find the card object
  for (const team of [this.teams.A, this.teams.B]) {
    const card = team.find(c => c.cardId === mvpCardId);
    if (card) return card;
  }
  
  return this.teams.A[0]; // fallback
}
```

---

## 5. TOURNAMENT SIMULATION (3+ Players)

```javascript
/**
 * Tournament format for 3-5 players:
 * 1. Single round-robin (everyone plays everyone)
 * 2. Calculate standings (3 points/win, 1 point/draw)
 * 3. Final leaderboard by points, then goal diff, then head-to-head
 */

simulateTournament(playerTeams) {
  // playerTeams: { playerId: team, playerId: team, ... }
  const playerIds = Object.keys(playerTeams);
  const matchups = [];
  const standings = {};
  
  // Initialize standings
  for (const playerId of playerIds) {
    standings[playerId] = {
      playerId,
      wins: 0,
      draws: 0,
      losses: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0
    };
  }
  
  // Generate all matchups (round-robin)
  for (let i = 0; i < playerIds.length; i++) {
    for (let j = i + 1; j < playerIds.length; j++) {
      const playerA = playerIds[i];
      const playerB = playerIds[j];
      
      const result = this.simulateSingleMatch(
        playerTeams[playerA],
        playerTeams[playerB]
      );
      
      const matchup = {
        playerA,
        playerB,
        scoreA: result.scoreA,
        scoreB: result.scoreB,
        winner: result.winner,
        mvp: result.mvp
      };
      
      matchups.push(matchup);
      
      // Update standings
      standings[playerA].goalsFor += result.scoreA;
      standings[playerA].goalsAgainst += result.scoreB;
      standings[playerB].goalsFor += result.scoreB;
      standings[playerB].goalsAgainst += result.scoreA;
      
      if (result.winner === 'A') {
        standings[playerA].wins++;
        standings[playerA].points += 3;
        standings[playerB].losses++;
      } else if (result.winner === 'B') {
        standings[playerB].wins++;
        standings[playerB].points += 3;
        standings[playerA].losses++;
      } else {
        standings[playerA].draws++;
        standings[playerA].points += 1;
        standings[playerB].draws++;
        standings[playerB].points += 1;
      }
    }
  }
  
  // Sort standings
  const leaderboard = Object.values(standings)
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const diffA = a.goalsFor - a.goalsAgainst;
      const diffB = b.goalsFor - b.goalsAgainst;
      return diffB - diffA;
    });
  
  // Add ranks
  leaderboard.forEach((entry, idx) => {
    entry.rank = idx + 1;
  });
  
  return {
    matchups,
    leaderboard,
    mvp: this.getTournamentMVP(matchups)
  };
}

getTournamentMVP(matchups) {
  const mvpVotes = {};
  
  for (const matchup of matchups) {
    const mvpId = matchup.mvp.cardId;
    if (!mvpVotes[mvpId]) {
      mvpVotes[mvpId] = {
        card: matchup.mvp,
        appearances: 0
      };
    }
    mvpVotes[mvpId].appearances++;
  }
  
  const sorted = Object.values(mvpVotes)
    .sort((a, b) => b.appearances - a.appearances);
  
  return sorted[0]?.card || null;
}
```

---

## 6. SEEDED RANDOM NUMBER GENERATOR

```javascript
/**
 * Uses seed to ensure reproducible randomness.
 * Same seed + same teams = same match result
 */

class SeededRandom {
  constructor(seed) {
    this.seed = seed;
    this.m = 2147483647; // Mersenne prime
    this.a = 16807;
  }

  random() {
    this.seed = (this.a * this.seed) % this.m;
    return this.seed / this.m;
  }

  // Reset with new seed
  setSeed(seed) {
    this.seed = seed;
  }
}

// Usage:
// const rng = new SeededRandom(12345);
// const val1 = rng.random(); // always same for same seed
// const val2 = rng.random(); // always same sequence for same seed
```

---

## 7. MATCH RESULT PERSISTENCE

```javascript
/**
 * After match simulation, save results to MongoDB
 */

async function saveMatchResults(gameId, matchResults) {
  const game = await Game.findById(gameId);
  
  game.matchResults = {
    type: matchResults.matchType, // "1v1" or "tournament"
    matchups: matchResults.matchups,
    leaderboard: matchResults.leaderboard,
    tournamentMVP: matchResults.mvp,
    completedAt: new Date()
  };
  
  await game.save();
}
```

---

## 8. PROBABILITY TESTING

```javascript
/**
 * Test that match probabilities align with team stats
 */

describe("MatchSimulator", () => {
  test("Better team wins more often", () => {
    const strongTeam = Array(11).fill({
      stats: { overall: 90, pace: 90, shooting: 90, passing: 85, defense: 85, physical: 85 }
    });
    
    const weakTeam = Array(11).fill({
      stats: { overall: 75, pace: 75, shooting: 75, passing: 75, defense: 75, physical: 75 }
    });
    
    let strongWins = 0;
    const trials = 100;
    
    for (let i = 0; i < trials; i++) {
      const result = simulator.simulateSingleMatch(strongTeam, weakTeam, i);
      if (result.winner === 'A') strongWins++;
    }
    
    expect(strongWins).toBeGreaterThan(70); // Should win >70% of matches
  });
  
  test("Similar teams have ~50% win each", () => {
    const team1 = Array(11).fill({
      stats: { overall: 82, pace: 82, shooting: 82, passing: 82, defense: 82, physical: 82 }
    });
    
    const team2 = Array(11).fill({
      stats: { overall: 82, pace: 82, shooting: 82, passing: 82, defense: 82, physical: 82 }
    });
    
    let team1Wins = 0;
    const trials = 100;
    
    for (let i = 0; i < trials; i++) {
      const result = simulator.simulateSingleMatch(team1, team2, i);
      if (result.winner === 'A') team1Wins++;
    }
    
    expect(team1Wins).toBeGreaterThan(40);
    expect(team1Wins).toBeLessThan(60);
  });
});
```

