/**
 * Shared review vocabulary. Reviewer ids are not authenticated.
 */

export const REVIEW_DECISIONS = ['confirm', 'correct', 'reject', 'unresolved'];
export const DUPLICATE_DECISIONS = ['same', 'different', 'unresolved'];

export function duplicatePairId(left, right) {
  return [String(left || ''), String(right || '')].sort().join('|');
}
