/**
 * COMPLETE CARD ART
 * A published card is a root-relative WebP or PNG under /player-cards/, named
 * with the canonical Draft11 player id. Remote URLs and local disk paths are
 * rejected. Discovery and the image library never set the approval flags.
 */

const CARD_ART = /^\/player-cards\/fut23_[a-z0-9_]+_(?:primary|card_\d{2})\.(?:webp|png)$/;

const SPECIAL = {
  ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', ð: 'd', Ð: 'd',
  þ: 'th', Þ: 'th', ß: 'ss', ı: 'i', ŋ: 'n', Ŋ: 'n'
};

export function cardArtNameKey(value) {
  if (value == null) return '';
  let text = String(value).trim();
  if (!text) return '';
  text = text.replace(/[øØæÆœŒłŁđĐðÐþÞßıŋŊ]/g, (ch) => SPECIAL[ch] ?? ch);
  text = text.normalize('NFD').replace(/\p{M}+/gu, '');
  text = text.replace(/['’‘ʼ`]/g, '');
  text = text.toLowerCase();
  text = text.replace(/[^a-z0-9]+/g, ' ');
  return text.trim().replace(/\s+/g, ' ');
}

export function isAllowedPlayerCardArt(url) {
  if (typeof url !== 'string' || url.length > 200) return false;
  if (url.includes('\\') || url.includes('..') || url.includes('//')) return false;
  if (/^[a-z]+:/i.test(url)) return false;
  return CARD_ART.test(url);
}

export function shouldShowCardArt(url, failedUrl) {
  return Boolean(url) && failedUrl !== url;
}

/**
 * The composed card, including its silhouette, stays in place unless every
 * approval gate is open and the file was checked.
 */
export function playerCardArtUrl(card, { cardArtEnabled = false, fileExists = null } = {}) {
  if (cardArtEnabled !== true) return '';
  if (card?.cardArtApproved !== true) return '';
  if (card?.cardArtApprovalStatus !== 'approved_for_use') return '';
  const testing = card?.cardArtTesting === true;
  const rights = card?.cardArtRightsStatus;
  if (!testing && rights !== 'licence_verified' && rights !== 'approved_for_use') return '';
  const url = card.cardArtUrl || card.cardArtRef;
  if (!isAllowedPlayerCardArt(url)) return '';
  if (typeof fileExists === 'function') {
    if (!fileExists(url)) return '';
  } else if (card.cardArtValidated !== true && !testing) {
    return '';
  }
  return url;
}
