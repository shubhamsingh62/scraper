import { slugify } from './locations.js';

const STOP_WORDS = new Set(['the', 'and', 'by', 'of', 'a']);

/** Lowercase, drop punctuation and "since 1984", keep the words that identify the place. */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/\bsince\s+\d{4}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(name) {
  return normalizeName(name)
    .split(' ')
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/** "HSR" matches "HSR Layout"; "Koramangala" matches "Koramangala 5th Block"; "btm" does not match "abtm". */
export function areasOverlap(left, right) {
  const a = slugify(left);
  const b = slugify(right);
  if (!a || !b) return false;
  return `-${a}-`.includes(`-${b}-`) || `-${b}-`.includes(`-${a}-`);
}

/**
 * How confident we are that a Zomato restaurant and a Swiggy restaurant are the same outlet.
 * 0 means "don't match". Area is required, because "KFC" in HSR is not "KFC" in Koramangala.
 */
export function matchScore(zomato, swiggy) {
  const swiggyAreas = [swiggy.areaName, swiggy.locality, swiggy.area].filter(Boolean);
  if (!swiggyAreas.some((area) => areasOverlap(zomato.area, area))) return 0;

  const a = normalizeName(zomato.name);
  const b = normalizeName(swiggy.name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // A one-word name inside a longer name ("Namaste" vs "Namaste Cafe") is not the same outlet.
  const aWords = a.split(' ').length;
  const bWords = b.split(' ').length;
  if (aWords === bWords && Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a))) return 0.92;
  if (aWords !== bWords && Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a))) return 0.9;

  const left = new Set(tokens(zomato.name));
  const right = new Set(tokens(swiggy.name));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  const jaccard = shared / (left.size + right.size - shared);
  const shorter = left.size <= right.size ? left : right;
  const shorterCovered = [...shorter].every((word) => left.has(word) && right.has(word));
  if (shorterCovered && shorter.size >= 2 && jaccard >= 0.5) return 0.8 + jaccard * 0.1;
  return jaccard >= 0.75 ? jaccard : 0;
}

/** Best Swiggy candidate for one Zomato restaurant, or null when nothing clears the bar. */
export function bestMatch(zomato, candidates, minScore = 0.75) {
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = matchScore(zomato, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= minScore ? { ...best, matchScore: bestScore } : null;
}
