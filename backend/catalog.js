/**
 * AUCTION CATALOG
 * New auctions use the validated image catalogue. Cards already stored for
 * older rooms, including the original FIFA ids, stay available for recovery
 * and are not shuffled into a new auction.
 */

export function isFifaCatalogCard(card) {
  return typeof card?.id === 'string' && /^fifa_\d+$/.test(card.id);
}

export function isLiveImageCard(card) {
  return card?.imageCatalogue === true
    && typeof card?.id === 'string'
    && /^fut23_[a-z0-9_]+$/.test(card.id)
    && typeof card.cardArtUrl === 'string'
    && card.cardArtUrl.length > 0;
}

export function chooseCatalog({ mongoCards = null, fileCards = [], imageCards = [] } = {}) {
  const seen = new Set();
  const auction = [];
  for (const card of imageCards || []) {
    if (!isLiveImageCard(card) || seen.has(card.id)) continue;
    seen.add(card.id);
    auction.push(card);
  }
  const recovery = new Map();
  const add = (card) => {
    if (card?.id == null || card.id === '') return;
    const key = String(card.id);
    if (!recovery.has(key)) recovery.set(key, card);
  };
  for (const card of Array.isArray(mongoCards) ? mongoCards : []) add(card);
  for (const card of fileCards || []) add(card);
  for (const card of auction) recovery.set(String(card.id), card);
  return {
    auction,
    recovery: [...recovery.values()],
    source: 'image-catalogue'
  };
}
