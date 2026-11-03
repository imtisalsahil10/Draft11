/**
 * MONGOOSE SCHEMAS & MODELS
 * Database schemas for all game entities
 */

import mongoose from 'mongoose';
import { LEAGUE_SCHEMA_VERSION, ROOM_SCHEMA_VERSION } from './constants.js';

// ============================================================================
// PLAYER SCHEMA
// ============================================================================

const playerSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      minlength: 2,
      maxlength: 20,
      trim: true
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true
    },
    stats: {
      gamesPlayed: { type: Number, default: 0 },
      gamesWon: { type: Number, default: 0 },
      gamesDrawn: { type: Number, default: 0 },
      gamesLost: { type: Number, default: 0 },
      totalSpent: { type: Number, default: 0 },
      cardsOwned: { type: Number, default: 0 }
    },
    preferences: {
      publicProfile: { type: Boolean, default: true },
      notifications: { type: Boolean, default: true }
    },
    createdAt: { type: Date, default: Date.now },
    lastLogin: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// username is already indexed by unique: true. A second schema.index() on the
// same key makes Mongoose log "Duplicate schema index" at startup. Keeping the
// field option leaves the existing MongoDB unique index in place, so no
// dropIndex and no data migration is required.
playerSchema.index({ createdAt: -1 });

// ============================================================================
// GAME SCHEMA
// ============================================================================

const gameSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      length: 6
    },
    status: {
      type: String,
      enum: ['waiting', 'auction', 'match', 'finished'],
      default: 'waiting'
    },
    gameType: {
      type: String,
      enum: ['single', 'tournament'],
      default: 'single'
    },
    players: [
      {
        playerId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Player'
        },
        username: String,
        team: [
          {
            cardId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'Card'
            },
            name: String,
            position: String,
            stats: {
              overall: Number
            }
          }
        ],
        finalBalance: { type: Number, default: 1000 },
        placement: { type: Number, default: null },
        cardsWon: { type: Number, default: 0 },
        totalSpent: { type: Number, default: 0 }
      }
    ],
    auctionSummary: {
      totalCardsAuctioned: { type: Number, default: 0 },
      totalCardsSkipped: { type: Number, default: 0 },
      totalMoneySpent: { type: Number, default: 0 },
      highestBid: { type: Number, default: 0 }
    },
    matchSummary: {
      winner: {
        playerId: mongoose.Schema.Types.ObjectId,
        username: String,
        teamOverall: Number
      },
      goals: {
        team1: { type: Number, default: 0 },
        team2: { type: Number, default: 0 }
      },
      duration: { type: Number, default: 90 },
      highlights: [String]
    },
    createdAt: { type: Date, default: Date.now },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// code is already unique, which creates its index. Do not declare it again.
gameSchema.index({ status: 1 });
gameSchema.index({ createdAt: -1 });
gameSchema.index({ 'players.playerId': 1 });

// ============================================================================
// CARD SCHEMA
// ============================================================================

const cardSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true
    },
    name: {
      type: String,
      required: true,
      index: true
    },
    position: {
      type: String,
      required: false,
      default: 'ST'
    },
    nationality: {
      type: String,
      default: 'Unknown'
    },
    club: {
      type: String,
      default: 'Unknown'
    },
    stats: {
      pace: { type: Number, min: 0, max: 99 },
      shooting: { type: Number, min: 0, max: 99 },
      passing: { type: Number, min: 0, max: 99 },
      dribbling: { type: Number, min: 0, max: 99 },
      defense: { type: Number, min: 0, max: 99 },
      physical: { type: Number, min: 0, max: 99 },
      overall: { type: Number, min: 0, max: 99, required: true }
    },
    category: {
      type: String,
      required: true,
      default: 'BASIC',
      set: (v) => v ? v.toUpperCase() : 'BASIC',
      enum: ['LEGENDARY', 'RARE', 'BASIC']
    },
    basePrice: {
      type: Number,
      required: true,
      enum: [10, 15, 25]
    },
    league: { type: String },
    age: { type: Number, min: 1, max: 99 },
    potential: { type: Number, min: 1, max: 99 },
    longName: { type: String },
    goalkeeping: {
      diving: { type: Number, min: 1, max: 99 },
      handling: { type: Number, min: 1, max: 99 },
      kicking: { type: Number, min: 1, max: 99 },
      reflexes: { type: Number, min: 1, max: 99 },
      speed: { type: Number, min: 1, max: 99 },
      positioning: { type: Number, min: 1, max: 99 }
    },
    // FIFA import provenance. Older cards omit this and keep their own ids.
    source: {
      dataset: { type: String },
      version: { type: String },
      sofifaId: { type: Number },
      importedAt: { type: Date }
    },
    // Unused legacy field. The importer does not write it. Leave it in place
    // so existing documents do not need a migration.
    provider: {
      name: { type: String },
      playerId: { type: Number }
    },
    photoRef: { type: String },
    photoApproved: { type: Boolean },
    alternatePositions: { type: [String] },
    ratingModel: {
      version: { type: String },
      approvedAt: { type: Date }
    },
    timesAuctioned: { type: Number, default: 0 },
    timesSoldFor: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// name already has index: true. Do not declare that index again.
cardSchema.index({ position: 1 });
cardSchema.index({ category: 1 });
cardSchema.index({ 'stats.overall': -1 });
cardSchema.index({ 'provider.playerId': 1 }, { unique: true, sparse: true });
cardSchema.index({ 'source.sofifaId': 1 }, { unique: true, sparse: true });

// ============================================================================
// LEADERBOARD SCHEMA
// ============================================================================

const leaderboardSchema = new mongoose.Schema(
  {
    playerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Player',
      required: true,
      unique: true
    },
    username: {
      type: String,
      required: true
    },
    rank: {
      type: Number,
      default: 0
    },
    stats: {
      gamesPlayed: { type: Number, default: 0 },
      gamesWon: { type: Number, default: 0 },
      winRate: { type: Number, default: 0 },
      averageBalance: { type: Number, default: 0 },
      totalSpent: { type: Number, default: 0 },
      averageTeamOverall: { type: Number, default: 0 }
    },
    rating: {
      type: Number,
      default: 1000
    },
    lastUpdated: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

leaderboardSchema.index({ rank: 1 });
leaderboardSchema.index({ rating: -1 });
leaderboardSchema.index({ 'stats.winRate': -1 });
leaderboardSchema.index({ lastUpdated: -1 });

// ============================================================================
// LIVE ROOM SCHEMA
// Recoverable in-progress rooms. Saved Game documents stay the historical
// record written when a match is stored. The deck is a list of card ids;
// card bodies come from the catalog, with a small cache for cards in play.
// ============================================================================

const liveRoomSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true
    },
    code: {
      type: String,
      required: true,
      unique: true
    },
    schemaVersion: {
      type: Number,
      required: true,
      default: ROOM_SCHEMA_VERSION
    },
    stateVersion: {
      type: Number,
      required: true,
      default: 0
    },
    status: {
      type: String,
      enum: ['waiting', 'auction', 'match', 'finished'],
      default: 'waiting'
    },
    phase: {
      type: String,
      default: 'not-started'
    },
    hostSeatId: {
      type: String,
      default: null
    },
    hostUsername: {
      type: String,
      default: null
    },
    createdAt: {
      type: Date,
      required: true
    },
    updatedAt: {
      type: Date,
      required: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    state: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    }
  },
  { timestamps: false }
);

// roomId and code are already unique. Do not declare those indexes again.
liveRoomSchema.index({ expiresAt: 1 });
liveRoomSchema.index({ status: 1 });

// ============================================================================
// LEAGUE SCHEMA
// Separate from LiveRoom. Membership is a server-issued token, not a seat
// and not a Player login. Invite codes and member tokens are secrets.
// Standings are not stored here; they are rebuilt from Fixture results.
// The invite code is stored so an administrator can read it again. Joining
// compares inviteCodeHash. Member tokens are stored only as tokenHash.
// ============================================================================

const leagueMemberSchema = new mongoose.Schema(
  {
    memberId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    displayName: { type: String, required: true },
    role: { type: String, enum: ['admin', 'member'], required: true },
    status: { type: String, enum: ['active', 'removed'], default: 'active' },
    joinedAt: { type: Date, required: true },
    squad: { type: mongoose.Schema.Types.Mixed, default: null },
    // Hash of the live-room seat token, plus the server seat id. Optional.
    // The raw seat token is never stored. Older members omit this.
    auctionSeat: {
      type: new mongoose.Schema({
        tokenHash: { type: String },
        roomId: { type: String },
        seatId: { type: String }
      }, { _id: false })
    }
  },
  { _id: false }
);

const leagueSchema = new mongoose.Schema(
  {
    leagueId: { type: String, required: true, unique: true },
    schemaVersion: { type: Number, required: true, default: LEAGUE_SCHEMA_VERSION },
    version: { type: Number, required: true, default: 0 },
    name: { type: String, required: true },
    creatorId: { type: String, required: true },
    inviteCode: { type: String, required: true },
    inviteCodeHash: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['forming', 'active', 'completed'],
      default: 'forming'
    },
    season: {
      name: { type: String, default: 'Season 1' },
      format: { type: String, default: 'round-robin' }
    },
    scoring: {
      win: { type: Number, default: 3 },
      draw: { type: Number, default: 1 },
      loss: { type: Number, default: 0 },
      tieBreak: { type: [String], default: undefined },
      summary: { type: String }
    },
    currentRound: { type: Number, default: 0 },
    members: { type: [leagueMemberSchema], default: [] },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  },
  { timestamps: false }
);

leagueSchema.index({ status: 1 });
leagueSchema.index({ creatorId: 1 });

// ============================================================================
// FIXTURE SCHEMA
// One document is the only result for that pairing. Completion updates the
// same document while it is not yet completed.
// ============================================================================

const fixtureSchema = new mongoose.Schema(
  {
    fixtureId: { type: String, required: true, unique: true },
    schemaVersion: { type: Number, required: true, default: LEAGUE_SCHEMA_VERSION },
    leagueId: { type: String, required: true },
    round: { type: Number, required: true },
    homeMemberId: { type: String, required: true },
    awayMemberId: { type: String, required: true },
    pairKey: { type: String, required: true },
    participants: { type: [String], default: undefined },
    status: {
      type: String,
      enum: ['scheduled', 'in_progress', 'simulating', 'completed'],
      default: 'scheduled'
    },
    roomCode: { type: String, default: null },
    savedGameId: { type: String, default: null },
    confirmations: { type: [mongoose.Schema.Types.Mixed], default: [] },
    claimToken: { type: String, default: null },
    claimFromStatus: { type: String, default: null },
    claimStartedAt: { type: Date, default: null },
    simulationSeed: { type: Number, default: null },
    claimedHome: { type: mongoose.Schema.Types.Mixed, default: null },
    claimedAway: { type: mongoose.Schema.Types.Mixed, default: null },
    pendingResult: { type: mongoose.Schema.Types.Mixed, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    completedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  },
  { timestamps: false }
);

fixtureSchema.path('homeMemberId').validate(function homeIsNotAway(value) {
  return value !== this.awayMemberId;
}, 'A manager cannot play themselves');
fixtureSchema.index({ leagueId: 1, pairKey: 1 }, { unique: true });
fixtureSchema.index({ leagueId: 1, round: 1, homeMemberId: 1 }, { unique: true });
fixtureSchema.index({ leagueId: 1, round: 1, awayMemberId: 1 }, { unique: true });
fixtureSchema.index({ leagueId: 1, round: 1, participants: 1 }, { unique: true });
fixtureSchema.index({ leagueId: 1, status: 1 });

// ============================================================================
// AUCTION HANDOFF
// A finished seat, not the live room. The seat token is stored only as a
// hash. Socket ids are not part of this document.
// ============================================================================

const auctionHandoffSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    roomId: { type: String, default: null },
    seatId: { type: String, default: null },
    cardIds: { type: [String], required: true },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    claim: {
      type: new mongoose.Schema({
        leagueId: { type: String, required: true },
        memberId: { type: String, required: true }
      }, { _id: false }),
      default: null
    }
  },
  { timestamps: false }
);

auctionHandoffSchema.index({ expiresAt: 1 });

function ratingOrEmpty(value) {
  return value == null || (typeof value === 'number' && value >= 1 && value <= 99);
}

// ============================================================================
// CATALOGUE PLAYER
// One footballer. This is not the user account model above, which already
// owns the `players` collection. Auction cards stay in `cards`. These
// collections are additive and are not read by the auction dealer.
// An image-catalogue card may omit overall and position when the card image
// does not show them. Those fields stay null.
// ============================================================================

const cataloguePlayerSchema = new mongoose.Schema(
  {
    playerId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    normalizedName: { type: String, required: true, unique: true },
    source: { type: String, required: true },
    sourcePlayerId: { type: String, default: null },
    identityStatus: { type: String, required: true },
    imageStatus: { type: String, required: true },
    primaryCardId: { type: String, required: true },
    nationality: { type: String, default: null },
    club: { type: String, default: null },
    league: { type: String, default: null },
    age: { type: Number, default: null },
    sofifaId: { type: Number, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  },
  { collection: 'catalogue_players', timestamps: false }
);

const playerCardSchema = new mongoose.Schema(
  {
    cardId: { type: String, required: true, unique: true },
    playerId: { type: String, required: true },
    source: { type: String, required: true },
    sourceVersion: { type: String, default: null },
    sourceRowNumber: { type: Number, required: true },
    sourceCardId: { type: String, required: true },
    overallRating: {
      type: Number,
      default: null,
      validate: {
        validator: ratingOrEmpty,
        message: 'Overall rating must be empty or from 1 to 99.'
      }
    },
    position: { type: String, default: null },
    alternatePositions: { type: [String], default: undefined },
    pace: { type: Number, default: null },
    shooting: { type: Number, default: null },
    passing: { type: Number, default: null },
    dribbling: { type: Number, default: null },
    defending: { type: Number, default: null },
    physical: { type: Number, default: null },
    goalkeeperAttributes: { type: mongoose.Schema.Types.Mixed, default: null },
    cardType: { type: String, default: null },
    imagePath: { type: String, default: null },
    imageAssociation: { type: String, default: null },
    ocrName: { type: String, default: null },
    sourceImage: { type: String, default: null },
    sourceImageHash: { type: String, default: null },
    sourcePath: { type: String, default: null },
    selectionReason: { type: String, default: null },
    auctionEligible: { type: Boolean, default: false },
    isPrimary: { type: Boolean, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  },
  { collection: 'player_cards', timestamps: false }
);

playerCardSchema.index({ playerId: 1 });
playerCardSchema.index({ sourceRowNumber: 1 }, { unique: true });

// ============================================================================
// CREATE MODELS
// ============================================================================

export const Player = mongoose.model('Player', playerSchema);
export const Game = mongoose.model('Game', gameSchema);
export const Card = mongoose.model('Card', cardSchema);
export const Leaderboard = mongoose.model('Leaderboard', leaderboardSchema);
export const LiveRoom = mongoose.model('LiveRoom', liveRoomSchema);
export const League = mongoose.model('League', leagueSchema);
export const Fixture = mongoose.model('Fixture', fixtureSchema);
export const AuctionHandoff = mongoose.model('AuctionHandoff', auctionHandoffSchema);
export const CataloguePlayer = mongoose.model('CataloguePlayer', cataloguePlayerSchema);
export const PlayerCard = mongoose.model('PlayerCard', playerCardSchema);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create or get player
 */
export async function getOrCreatePlayer(username) {
  let player = await Player.findOne({ username });
  
  if (!player) {
    player = new Player({ username });
    await player.save();
  }
  
  return player;
}

/**
 * Create game
 */
export async function createGame(roomCode) {
  const game = new Game({
    code: roomCode,
    status: 'waiting'
  });
  await game.save();
  return game;
}

/**
 * Get game by code
 */
export async function getGameByCode(code) {
  return Game.findOne({ code }).populate('players.playerId');
}

/**
 * Update player stats
 */
export async function updatePlayerStats(username, updates) {
  const player = await Player.findOne({ username });
  if (!player) return null;
  
  // Update stats with increments
  if (updates.gamesPlayed) player.stats.gamesPlayed += updates.gamesPlayed;
  if (updates.wins) player.stats.gamesWon += updates.wins;
  if (updates.draws) player.stats.gamesDrawn += updates.draws;
  if (updates.losses) player.stats.gamesLost += updates.losses;
  if (updates.moneySpent) player.stats.totalSpent += updates.moneySpent;
  if (updates.cardsWon) player.stats.cardsOwned += updates.cardsWon;
  
  player.lastLogin = new Date();
  
  await player.save();
  
  // Update leaderboard
  await updateLeaderboard(player._id, player.stats);
  
  return player;
}

/**
 * Update leaderboard entry
 */
export async function updateLeaderboard(playerId, stats) {
  const winRate = stats.gamesPlayed > 0 
    ? (stats.gamesWon / stats.gamesPlayed) * 100 
    : 0;
    
  const avgSpending = stats.gamesPlayed > 0
    ? stats.totalSpent / stats.gamesPlayed
    : 0;
    
  // Calculate rating (simple ELO-style)
  const rating = Math.round(
    1000 + 
    (stats.gamesWon * 25) - 
    (stats.gamesLost * 15) +
    (stats.gamesDrawn * 5)
  );
  
  await Leaderboard.findOneAndUpdate(
    { playerId },
    {
      playerId,
      rating,
      'stats.gamesPlayed': stats.gamesPlayed,
      'stats.wins': stats.gamesWon,
      'stats.draws': stats.gamesDrawn,
      'stats.losses': stats.gamesLost,
      'stats.winRate': winRate,
      'stats.avgSpending': avgSpending,
      'stats.cardsOwned': stats.cardsOwned,
      lastUpdated: new Date()
    },
    { upsert: true, new: true }
  );
  
  // Recalculate ranks
  await recalculateLeaderboardRanks();
}

/**
 * Recalculate all leaderboard ranks
 */
export async function recalculateLeaderboardRanks() {
  const entries = await Leaderboard.find().sort({ rating: -1 });
  
  for (let i = 0; i < entries.length; i++) {
    entries[i].rank = i + 1;
    await entries[i].save();
  }
}

/**
 * Get leaderboard
 */
export async function getLeaderboard(limit = 100) {
  return Leaderboard.find()
    .sort({ rank: 1 })
    .limit(limit)
    .lean();
}

/**
 * Get player leaderboard position
 */
export async function getPlayerLeaderboardPosition(playerId) {
  return Leaderboard.findOne({ playerId }).lean();
}
