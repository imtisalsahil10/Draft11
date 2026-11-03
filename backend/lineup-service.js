/**
 * Seat lineup updates. Ownership, duplicates, and revision checks happen
 * before anything is stored. Client ratings are ignored.
 */

import { ERROR_CODES } from './constants.js';
import {
  LINEUP_ERRORS,
  applyLineupChange,
  presentLineup
} from '../shared/squad-evaluation.js';

export function lineupView(player) {
  return presentLineup(player?.team || [], player?.lineup || null);
}

export function updateSeatLineup(roomManager, roomCode, playerId, payload = {}, auctionPhase) {
  if (auctionPhase !== 'finished') {
    return {
      ok: false,
      error: LINEUP_ERRORS.AUCTION_NOT_FINISHED,
      message: 'Lineup changes open after the auction finishes.'
    };
  }

  const player = roomManager.getPlayer(roomCode, playerId);
  if (!player) {
    return {
      ok: false,
      error: ERROR_CODES.ROOM_NOT_FOUND,
      message: 'Room not found.'
    };
  }

  const result = applyLineupChange({
    ownedCards: player.team || [],
    lineup: player.lineup || null,
    formation: payload.formation,
    assignments: payload.assignments,
    expectedRevision: payload.expectedRevision,
    confirm: payload.confirm === true
  });

  if (!result.ok || result.unchanged) return result;

  roomManager.setLineup(roomCode, playerId, result.stored);
  return {
    ok: true,
    lineup: lineupView(roomManager.getPlayer(roomCode, playerId))
  };
}
