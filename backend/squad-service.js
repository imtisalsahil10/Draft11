/**
 * TEAM BUILD BRIDGE
 * team:build and team:auto-build select an XI. The rating is the shared
 * squad formula, not a second average and not a default of 75.
 *
 * Formations the pitch understands (4-3-3, 4-2-3-1, 3-5-2) are stored as a
 * confirmed lineup, so the builder, the saved XI, and the match rating agree.
 * Older formation strings such as 4-4-2 still use the legacy shape check.
 * They do not keep a second confirmed lineup beside that XI.
 */

import { ERROR_CODES } from './constants.js';
import { deepCopy } from './utils.js';
import { autoSelectTeam, calculateTeamOverall, suggestFormation, validateFormation } from './team-builder.js';
import { lineupView } from './lineup-service.js';
import {
  FORMATIONS,
  applyLineupChange,
  presentLineup
} from '../shared/squad-evaluation.js';

function fail(error, message) {
  return { ok: false, error, message: message || error };
}

function roleOf(card) {
  if (typeof card?.assignedPosition === 'string' && card.assignedPosition.trim()) {
    return card.assignedPosition.trim().toUpperCase();
  }
  const token = String(card?.position || '').toUpperCase().split(/[^A-Z]+/).find(Boolean);
  return token || '';
}

/**
 * Place a built XI onto formation slots. Exact roles fill first.
 * Leftover players fill the open places in slot order, each player once.
 */
export function slotsForTeam(formationId, team) {
  const formation = FORMATIONS[formationId];
  if (!formation || !Array.isArray(team) || team.length !== formation.slots.length) return null;

  const pool = team.map((card) => ({ id: card.id, role: roleOf(card) }));
  const used = new Set();
  const chosen = new Map();

  for (const slot of formation.slots) {
    const match = pool.find((card) => !used.has(String(card.id)) && card.role === slot.role);
    if (!match) continue;
    used.add(String(match.id));
    chosen.set(slot.id, match.id);
  }

  for (const slot of formation.slots) {
    if (chosen.has(slot.id)) continue;
    const next = pool.find((card) => !used.has(String(card.id)));
    if (!next) return null;
    used.add(String(next.id));
    chosen.set(slot.id, next.id);
  }

  return formation.slots.map((slot) => ({
    slotId: slot.id,
    cardId: chosen.get(slot.id)
  }));
}

function resolveSelected(owned, selectedCards) {
  const seen = new Set();
  const team = [];
  for (const entry of selectedCards) {
    const id = entry?.id ?? entry?.cardId;
    const card = (owned || []).find((item) => item?.id != null && String(item.id) === String(id));
    if (!card) {
      return fail(ERROR_CODES.CARD_NOT_OWNED, 'You can only place players this room bought.');
    }
    if (seen.has(String(card.id))) {
      return fail(ERROR_CODES.DUPLICATE_PLAYER, 'A player can only take one place.');
    }
    seen.add(String(card.id));
    const copy = deepCopy(card);
    if (typeof entry?.assignedPosition === 'string' && entry.assignedPosition) {
      copy.assignedPosition = entry.assignedPosition;
    }
    team.push(copy);
  }
  return { ok: true, team };
}

function finish(roomManager, roomCode, playerId) {
  const updated = roomManager.getPlayer(roomCode, playerId);
  return {
    ok: true,
    team: updated?.builtTeam || null,
    overall: updated?.teamOverall ?? null,
    formation: updated?.formation || null,
    lineup: updated?.lineup ? lineupView(updated) : null
  };
}

/**
 * Build or auto-build one seat. Ratings in the request are ignored.
 * `source` is 'build' or 'auto' and only changes the short-squad message.
 */
export function commitBuiltTeam(roomManager, roomCode, playerId, options = {}) {
  const room = roomManager.getRoom(roomCode);
  if (!room) return fail('Room not found');
  const player = room.players.get(playerId);
  if (!player) return fail('Player not found');

  const source = options.source === 'auto' ? 'auto' : 'build';
  const selectedCards = Array.isArray(options.selectedCards) ? options.selectedCards : [];
  const auto = source === 'auto' || selectedCards.length === 0;
  let team;
  let formation;

  if (auto) {
    if ((player.team || []).length < 11) {
      return fail(source === 'auto' ? 'Need at least 11 cards' : 'Need at least 11 cards to build team');
    }
    formation = options.formation || suggestFormation(player.team);
    try {
      team = autoSelectTeam(player.team, formation);
    } catch (err) {
      return fail(err.message);
    }
  } else {
    formation = options.formation || '4-4-2';
    const resolved = resolveSelected(player.team, selectedCards);
    if (!resolved.ok) return resolved;
    team = resolved.team;
  }

  if (!Array.isArray(team) || team.length !== 11) {
    return fail('Team must have exactly 11 players');
  }

  if (FORMATIONS[formation]) {
    const assignments = slotsForTeam(formation, team);
    if (!assignments) return fail('Team must have exactly 11 players');
    const current = presentLineup(player.team || [], player.lineup || null);
    const applied = applyLineupChange({
      ownedCards: player.team || [],
      lineup: player.lineup || null,
      formation,
      assignments,
      expectedRevision: current.revision,
      confirm: true
    });
    if (!applied.ok) return fail(applied.error, applied.message);
    roomManager.setLineup(roomCode, playerId, applied.stored);
    return finish(roomManager, roomCode, playerId);
  }

  const validation = validateFormation(team, formation);
  if (!validation.valid) return fail(validation.errors.join(', '));
  let overall = null;
  try {
    overall = calculateTeamOverall(team);
  } catch (err) {
    if (err.message !== 'Team rating is unavailable') return fail(err.message);
  }
  player.lineup = null;
  roomManager.recordBuiltTeam(roomCode, playerId, team, overall, formation);
  return finish(roomManager, roomCode, playerId);
}
