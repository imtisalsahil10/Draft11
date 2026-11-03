/**
 * GAME VALIDATORS
 * Input validation and rule enforcement
 */

import { GAME_CONFIG, ERROR_CODES, PLAYER_STATS } from './constants.js';

export class Validator {
  /**
   * Validate player join request
   */
  static validatePlayerJoin(username, roomCode) {
    if (!username || typeof username !== 'string') {
      return { valid: false, error: ERROR_CODES.INVALID_PARAMETERS, message: 'Username required' };
    }
    
    if (username.length < 2 || username.length > 20 || /[\u0000-\u001F\u007F]/.test(username)) {
      return { valid: false, error: ERROR_CODES.INVALID_PARAMETERS, message: 'Username must be 2-20 characters' };
    }
    
    if (!roomCode || typeof roomCode !== 'string') {
      return { valid: false, error: ERROR_CODES.INVALID_PARAMETERS, message: 'Room code required' };
    }
    
    if (!/^[A-Za-z0-9]{6}$/.test(roomCode)) {
      return { valid: false, error: ERROR_CODES.INVALID_PARAMETERS, message: 'Room code must be 6 characters' };
    }
    
    return { valid: true };
  }
  
  /**
   * Pounds that must be added to the current bid.
   * Below the threshold the step is £5. At or above it, the step is £10.
   */
  static bidStep(currentBid) {
    const amount = Number(currentBid);
    const base = Number.isFinite(amount) ? amount : 0;
    return base < GAME_CONFIG.BID_INCREMENT_THRESHOLD
      ? GAME_CONFIG.MIN_BID_INCREMENT
      : GAME_CONFIG.BID_INCREMENT_HIGH;
  }

  static nextMinimumBid(currentBid) {
    const amount = Number(currentBid);
    const base = Number.isFinite(amount) ? amount : 0;
    return base + Validator.bidStep(base);
  }

  /**
   * Validate a whole-pound bid against the shared increment rule.
   */
  static validateBidIncrement(currentBid, newBid) {
    const minimumBid = Validator.nextMinimumBid(currentBid);
    const requiredIncrement = Validator.bidStep(currentBid);

    if (!Number.isInteger(newBid) || newBid <= 0) {
      return {
        valid: false,
        error: ERROR_CODES.INVALID_BID,
        message: 'Bid must be a whole number of pounds',
        minimumBid,
        requiredIncrement
      };
    }

    if (newBid < minimumBid) {
      return {
        valid: false,
        error: ERROR_CODES.INVALID_BID_INCREMENT,
        message: `Minimum bid is £${minimumBid}`,
        minimumBid,
        requiredIncrement
      };
    }

    return { valid: true, minimumBid, requiredIncrement };
  }
  
  /**
   * Validate player balance
   */
  static validatePlayerBalance(playerBalance, bidAmount) {
    if (playerBalance < bidAmount) {
      return {
        valid: false,
        error: ERROR_CODES.INSUFFICIENT_BALANCE,
        message: `Insufficient balance. Have £${playerBalance}, need £${bidAmount}`
      };
    }
    
    return { valid: true };
  }
  
  /**
   * Validate team composition
   */
  static validateTeamComposition(team) {
    if (!Array.isArray(team)) {
      return { valid: false, error: ERROR_CODES.INVALID_PARAMETERS, message: 'Team must be an array' };
    }
    
    if (team.length !== GAME_CONFIG.REQUIRED_TEAM_SIZE) {
      return {
        valid: false,
        error: ERROR_CODES.TEAM_INCOMPLETE,
        message: `Team must have exactly ${GAME_CONFIG.REQUIRED_TEAM_SIZE} players`
      };
    }
    
    // Check positions
    const positions = team.map(card => card.position);
    
    // Check for valid positions
    for (const pos of positions) {
      if (!GAME_CONFIG.POSITIONS.includes(pos)) {
        return {
          valid: false,
          error: ERROR_CODES.INVALID_POSITION,
          message: `Invalid position: ${pos}`
        };
      }
    }
    
    // Count GK
    const gkCount = positions.filter(pos => pos === 'GK').length;
    if (gkCount !== 1) {
      return {
        valid: false,
        error: ERROR_CODES.DUPLICATE_POSITION,
        message: 'Team must have exactly 1 goalkeeper'
      };
    }
    
    return { valid: true };
  }
  
  /**
   * Validate card data
   */
  static validateCard(card) {
    if (!card.id) return { valid: false, message: 'Card ID required' };
    if (!card.name) return { valid: false, message: 'Card name required' };
    if (!card.position) return { valid: false, message: 'Card position required' };
    if (!card.stats) return { valid: false, message: 'Card stats required' };
    if (!card.category) return { valid: false, message: 'Card category required' };
    if (card.basePrice === undefined) return { valid: false, message: 'Card basePrice required' };
    
    // Validate stats
    for (const stat of PLAYER_STATS) {
      if (card.stats[stat] === undefined) {
        return { valid: false, message: `Stat ${stat} required` };
      }
      if (card.stats[stat] < 0 || card.stats[stat] > 99) {
        return { valid: false, message: `Stat ${stat} must be 0-99` };
      }
    }
    
    return { valid: true };
  }
}
