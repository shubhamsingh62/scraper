/** First-page cap. The area crawl stops once this many cards are in hand. */
export const CARD_LIMIT = 30;

const MIN_RATING = 4;
const MIN_REVIEWS = 500;
const MIN_COST_FOR_TWO = 800;

/** "11.4K" -> 11400, "1,754" -> 1754. Missing text stays null so the row is discarded. */
export function parseReviewCount(value) {
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!text) return null;
  const thousands = text.match(/(\d+(?:\.\d+)?)\s*k/i);
  const plain = text.match(/(\d+(?:\.\d+)?)/);
  const match = thousands || plain;
  if (!match) return null;
  const count = Number.parseFloat(match[1]) * (thousands ? 1000 : 1);
  return Number.isFinite(count) ? Math.round(count) : null;
}

/** "₹2,900 for two" -> 2900. Missing text stays null so the row is discarded. */
export function parseCostInr(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const cost = Number.parseFloat(match[1]);
  return Number.isFinite(cost) ? cost : null;
}

/**
 * @returns {string | null} A short reason to discard the card, or null when it qualifies.
 * Rating, review count, and cost are all required.
 */
export function qualityFailure(row) {
  const rating = Number(row?.rating);
  const reviews = parseReviewCount(row?.review_count);
  const cost = parseCostInr(row?.cost_for_two);
  if (!Number.isFinite(rating)) return 'rating missing';
  if (rating < MIN_RATING) return `rating ${rating} < ${MIN_RATING}`;
  if (reviews == null) return 'review count missing';
  if (reviews < MIN_REVIEWS) return `reviews ${reviews} < ${MIN_REVIEWS}`;
  if (cost == null) return 'cost for two missing';
  if (cost < MIN_COST_FOR_TWO) return `cost ₹${cost} < ${MIN_COST_FOR_TWO}`;
  return null;
}
