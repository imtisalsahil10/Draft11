/**
 * COMPATIBILITY ADAPTER
 * Existing fifa_ and card_ documents stay the identity for those records.
 * New FIFA 23 footballers live in catalogue_players and are not auction cards.
 * This module does not rename ids or rewrite stored cards.
 */

import { isFifaCatalogCard } from '../catalog.js';

const LEGACY_ID = /^(?:fifa_\d+|card_\d+)$/;

export function isLegacyCatalogId(id) {
  return typeof id === 'string' && LEGACY_ID.test(id);
}

/**
 * The stored card id remains the player id for a live or legacy card.
 * A FIFA 23 card version points at its catalogue playerId.
 */
export function playerIdForRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (isLegacyCatalogId(record.id) && record.playerId == null) return record.id;
  if (typeof record.playerId === 'string' && record.playerId) return record.playerId;
  if (isLegacyCatalogId(record.id)) return record.id;
  return null;
}

export function auctionEligible(card) {
  return isFifaCatalogCard(card) || card?.imageCatalogue === true;
}
