/** @typedef {'found' | 'empty' | 'blocked' | 'unknown'} OfferStatus */

/**
 * What one page told us about a dining discount.
 * - found: a discount string
 * - empty: the page loaded and showed no dining discount (safe to store null)
 * - blocked: bot check, captcha, 403/429, or a failed fetch (keep the database value)
 * - unknown: the page loaded but did not include an offer block (keep the database value)
 *
 * @typedef {{ status: OfferStatus, value: string | null }} OfferRead
 */

/** @param {string} value @returns {OfferRead} */
export const found = (value) => ({ status: 'found', value });

/** @returns {OfferRead} */
export const emptyOffer = () => ({ status: 'empty', value: null });

/** @returns {OfferRead} */
export const blockedOffer = () => ({ status: 'blocked', value: null });

/** @returns {OfferRead} */
export const unknownOffer = () => ({ status: 'unknown', value: null });

export const keepsExistingOffer = (read) => read.status === 'blocked' || read.status === 'unknown';
