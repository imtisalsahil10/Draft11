/**
 * PLAYER PHOTO AND CLUB DISPLAY
 * A photo must be a root-relative file under /player-images/.
 * Names are a numeric SoFIFA id or a Draft11 id such as fut23_lionel_messi.
 * Remote URLs, including profile pages, are rejected.
 *
 * A Creative Commons licence does not clear personality or publicity rights.
 * Elite fut23 files also need manifest approval, completed rights review,
 * and file validation. Those flags are never set by image discovery.
 */

const LOCAL_PHOTO = /^\/player-images\/(?:\d{1,12}|fut23_[a-z0-9_]+)\.(png|jpe?g|webp)$/i;
const ELITE_PHOTO = /^\/player-images\/fut23_[a-z0-9_]+\.(png|jpe?g|webp)$/i;

export function isAllowedPlayerPhoto(url) {
  if (typeof url !== 'string' || url.length > 96) return false;
  if (url.includes('\\') || url.includes('..') || url.includes('//')) return false;
  if (/^[a-z]+:/i.test(url)) return false;
  return LOCAL_PHOTO.test(url);
}

export function playerPhotoUrl(card, { photosEnabled = false } = {}) {
  if (photosEnabled !== true || card?.photoApproved !== true) return '';
  const photo = card.photoUrl || card.photoRef;
  if (!isAllowedPlayerPhoto(photo)) return '';
  if (ELITE_PHOTO.test(photo)) {
    if (card.photoManifestApproved !== true) return '';
    if (card.rightsReviewed !== true) return '';
    if (card.imageValidated !== true) return '';
  }
  return photo;
}

/**
 * Existing catalog clubs are often numeric ids. Those are not names.
 * A blank or "Unknown" club is not shown.
 */
export function displayClub(club) {
  if (typeof club !== 'string') return '';
  const value = club.trim().replace(/\s+/g, ' ');
  if (!value || value.toLowerCase() === 'unknown') return '';
  if (/^\d+$/.test(value)) return '';
  return value;
}
