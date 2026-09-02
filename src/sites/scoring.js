/**
 * Site scoring utilities (ported from Property Genius scoring.ts).
 * Weighted Accessibility / Competition / Demand / Visibility / Infrastructure (0–10)
 * → overall score 0–100.
 */

/** @typedef {'lead'|'screening'|'shortlisted'|'rejected'} SiteStatus */

/** Default equal-ish Genius weights. */
export const DEFAULT_SCORING_WEIGHTS = Object.freeze({
  accessibility: 0.25,
  competition: 0.2,
  demand: 0.25,
  visibility: 0.15,
  infrastructure: 0.15,
});

export const SITE_STATUSES = Object.freeze(['lead', 'screening', 'shortlisted', 'rejected']);

export const SITE_STATUS_LABELS = Object.freeze({
  lead: 'Lead',
  screening: 'Screening',
  shortlisted: 'Shortlisted',
  rejected: 'Rejected',
});

export const SCORE_DIMENSIONS = Object.freeze([
  'accessibility',
  'competition',
  'demand',
  'visibility',
  'infrastructure',
]);

/**
 * Clamp a score input to the 0–10 integer range.
 * @param {unknown} value
 * @param {number} [fallback=5]
 * @returns {number}
 */
export function clampScoreInput(value, fallback = 5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, Math.round(n)));
}

/**
 * @returns {{accessibility:number,competition:number,demand:number,visibility:number,infrastructure:number}}
 */
export function getDefaultScoreInputs() {
  return {
    accessibility: 5,
    competition: 5,
    demand: 5,
    visibility: 5,
    infrastructure: 5,
  };
}

/**
 * Normalize partial inputs into a complete DevScoreInputs object.
 * @param {object} [inputs]
 * @returns {ReturnType<typeof getDefaultScoreInputs>}
 */
export function normalizeScoreInputs(inputs = {}) {
  const defaults = getDefaultScoreInputs();
  const out = { ...defaults };
  for (const key of SCORE_DIMENSIONS) {
    out[key] = clampScoreInput(inputs?.[key], defaults[key]);
  }
  return out;
}

/**
 * Weighted score → 0–100.
 * @param {object} inputs Dimension scores 0–10.
 * @param {object} [weights] Relative weights (need not sum to 1).
 * @returns {number}
 */
export function calculateScore(inputs, weights = DEFAULT_SCORING_WEIGHTS) {
  const normalized = normalizeScoreInputs(inputs);
  const w = { ...DEFAULT_SCORING_WEIGHTS, ...(weights || {}) };
  const weightedSum = SCORE_DIMENSIONS.reduce(
    (sum, key) => sum + (normalized[key] * (Number(w[key]) || 0)),
    0,
  );
  const totalWeight = SCORE_DIMENSIONS.reduce((sum, key) => sum + (Number(w[key]) || 0), 0);
  if (totalWeight === 0) return 0;
  return Math.round((weightedSum / totalWeight) * 10);
}

/**
 * @param {string} status
 * @returns {SiteStatus}
 */
export function normalizeSiteStatus(status) {
  const value = String(status || '').toLowerCase();
  return SITE_STATUSES.includes(value) ? value : 'lead';
}

/**
 * Build a scored site summary for lists / cards.
 * @param {object} options
 * @param {string} options.uid
 * @param {string} options.name
 * @param {string} options.layerId
 * @param {object} [options.metadata]
 * @param {object} [options.weights]
 * @returns {object}
 */
export function createScoredSite({
  uid,
  name,
  layerId,
  metadata,
  weights = DEFAULT_SCORING_WEIGHTS,
}) {
  const inputs = metadata?.dev_score_inputs
    ? normalizeScoreInputs(metadata.dev_score_inputs)
    : getDefaultScoreInputs();
  return {
    uid,
    name,
    layerId,
    score: calculateScore(inputs, weights),
    status: normalizeSiteStatus(metadata?.status),
    metadata: metadata || null,
  };
}

/**
 * @param {object[]} sites
 * @param {'asc'|'desc'} [direction]
 * @returns {object[]}
 */
export function sortSitesByScore(sites, direction = 'desc') {
  return [...(sites || [])].sort((a, b) => {
    const diff = (b.score || 0) - (a.score || 0);
    return direction === 'desc' ? diff : -diff;
  });
}

/**
 * @param {object[]} sites
 * @param {string[]} statuses
 * @returns {object[]}
 */
export function filterSitesByStatus(sites, statuses) {
  if (!statuses?.length) return sites || [];
  const allowed = new Set(statuses.map((s) => String(s).toLowerCase()));
  return (sites || []).filter((s) => allowed.has(String(s.status || '').toLowerCase()));
}
