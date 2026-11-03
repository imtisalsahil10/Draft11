/**
 * CLIENT CARD PAYLOADS
 * Auction, squad, and match events can carry catalog cards. Source ids,
 * photo references, and approval flags stay off the payload unless a local
 * image is approved and photo display is switched on.
 */

import fs from 'fs';
import path from 'path';
import { cardArtNameKey, playerCardArtUrl } from '../shared/player-card-art.js';
import { playerPhotoUrl } from '../shared/player-photo.js';

const GAME_FIELDS = ['id', 'name', 'position', 'nationality', 'club', 'league', 'category', 'basePrice'];
const GOALKEEPING_KEYS = ['diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning'];

export function photosRequested(env = process.env) {
  return env?.DRAFT11_PLAYER_PHOTOS === '1';
}

export function cardArtRequested(env = process.env) {
  return env?.DRAFT11_PLAYER_CARD_ART === '1';
}

export function cardArtFileExistsIn(directory) {
  return (url) => {
    if (typeof url !== 'string') return false;
    const filename = url.slice('/player-cards/'.length);
    if (!/^fut23_[a-z0-9_]+_(?:primary|card_\d{2})\.(?:webp|png)$/.test(filename)) return false;
    const root = path.resolve(directory || '');
    const target = path.resolve(root, filename);
    if (path.relative(root, target) !== filename) return false;
    try {
      return fs.statSync(target).isFile();
    } catch {
      return false;
    }
  };
}

function isCatalogCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.id == null || !value.stats || typeof value.stats !== 'object') return false;
  return typeof value.name === 'string' || value.basePrice != null || typeof value.position === 'string';
}

export function presentCard(card, options = {}) {
  if (!card || typeof card !== 'object') return card;
  const copy = {};
  for (const key of GAME_FIELDS) {
    if (card[key] !== undefined) copy[key] = card[key];
  }
  if (card.stats && typeof card.stats === 'object') copy.stats = { ...card.stats };
  if (Array.isArray(card.alternatePositions)) {
    copy.alternatePositions = card.alternatePositions.filter((item) => typeof item === 'string');
  }
  const goalkeeping = {};
  for (const key of GOALKEEPING_KEYS) {
    const value = card.goalkeeping?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) goalkeeping[key] = value;
  }
  if (Object.keys(goalkeeping).length) copy.goalkeeping = goalkeeping;
  if (card.dataset === 'fifa' || card.source?.dataset === 'fifa') copy.dataset = 'fifa';
  const enabled = options.photosEnabled === true;
  const photo = playerPhotoUrl(card, { photosEnabled: enabled });
  if (photo) {
    copy.photoUrl = photo;
    copy.photoApproved = true;
    if (/\/player-images\/fut23_[a-z0-9_]+\./i.test(photo)) {
      copy.photoManifestApproved = true;
      copy.rightsReviewed = true;
      copy.imageValidated = true;
    }
  }
  if (options.cardArtEnabled === true || card.imageCatalogue === true || card.testAuction === true) {
    let source = card;
    if (!card.cardArtUrl && options.testingArt && typeof card.name === 'string') {
      const url = options.testingArt.get(cardArtNameKey(card.name));
      if (url) {
        source = {
          ...card,
          cardArtUrl: url,
          cardArtApproved: true,
          cardArtApprovalStatus: 'approved_for_use',
          cardArtTesting: true,
          cardArtValidated: true
        };
      }
    }
    const art = playerCardArtUrl(source, {
      cardArtEnabled: true,
      fileExists: options.cardArtFileExists || null
    });
    if (art) {
      copy.cardArtUrl = art;
      copy.cardArtApproved = true;
      copy.cardArtApprovalStatus = 'approved_for_use';
      copy.cardArtRightsStatus = source.cardArtRightsStatus === 'licence_verified'
        ? 'licence_verified'
        : 'approved_for_use';
      copy.cardArtTesting = source.cardArtTesting === true;
      copy.cardArtValidated = true;
    }
  }
  if (card.imageCatalogue === true) {
    copy.imageCatalogue = true;
    copy.auctionEligible = true;
    copy.basePriceSource = card.basePriceSource === 'overall-band' ? 'overall-band' : 'unrated-opening';
    if (typeof card.catalogueCardId === 'string') copy.catalogueCardId = card.catalogueCardId;
    copy.cardArtExpected = true;
    copy.cardArtStatus = copy.cardArtUrl ? 'ready' : 'missing';
  }
  if (card.localCatalogue === true || card.testAuction === true) {
    copy.localCatalogue = true;
    copy.auctionEligible = false;
    if (card.testAuction === true) {
      copy.testAuction = true;
      copy.basePriceSource = card.basePriceSource === 'overall-band' ? 'overall-band' : 'neutral-test';
      if (typeof card.catalogueCardId === 'string') copy.catalogueCardId = card.catalogueCardId;
    }
    copy.cardArtExpected = true;
    copy.cardArtStatus = copy.cardArtUrl ? 'ready' : 'missing';
    if (typeof card.ocrName === 'string' && card.ocrName) copy.ocrName = card.ocrName;
    if (card.crestOnCard === true) copy.crestOnCard = true;
    if (card.flagOnCard === true) copy.flagOnCard = true;
    if (Array.isArray(card.reviewReasons)) copy.reviewReasons = card.reviewReasons.filter((item) => typeof item === 'string');
  }
  return copy;
}

export function presentClientPayload(value, options = {}, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((item) => presentClientPayload(item, options, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  if (isCatalogCard(value)) return presentCard(value, options);
  seen.add(value);
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'photoRef' || key === 'cardArtUrl' || key === 'cardArtRef' || key === 'provider' || key === 'ratingModel') continue;
    copy[key] = presentClientPayload(child, options, seen);
  }
  return copy;
}
