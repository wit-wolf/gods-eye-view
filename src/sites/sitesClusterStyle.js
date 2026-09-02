/**
 * Sites cluster bubble styling — pure size tiers + canvas disc with count.
 * Cesium-free so tiers are unit-testable; canvas builder is browser-only.
 */

/** @typedef {'small'|'medium'|'large'} SitesClusterTier */

/**
 * Light size tiers for cluster discs (not giant floating numerals).
 * @param {number} count
 * @returns {{tier:SitesClusterTier, diameter:number, fontPx:number}}
 */
export function sitesClusterBubbleSize(count) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  if (n < 25) return { tier: 'small', diameter: 34, fontPx: 13 };
  if (n < 120) return { tier: 'medium', diameter: 42, fontPx: 14 };
  return { tier: 'large', diameter: 52, fontPx: n >= 1000 ? 12 : 15 };
}

/**
 * Compact label for the bubble (full count; locale grouping for 1000+).
 * @param {number} count
 * @returns {string}
 */
export function sitesClusterBubbleLabel(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n >= 1000) {
    try {
      return n.toLocaleString('en-ZA');
    } catch {
      return String(n);
    }
  }
  return String(n);
}

/** @type {Map<string, string>} */
const _bubbleCache = new Map();
const BUBBLE_CACHE_MAX = 96;

/**
 * Cache key for a bubble image.
 * @param {number} count
 * @param {string} fill
 * @param {string} outline
 * @param {string} text
 * @returns {string}
 */
export function sitesClusterBubbleCacheKey(count, fill, outline, text) {
  const size = sitesClusterBubbleSize(count);
  return `${size.tier}:${count}:${fill}:${outline}:${text}`;
}

/**
 * Draw a circular Sites cluster bubble as a data URL (browser).
 * @param {number} count
 * @param {object} [opts]
 * @param {string} [opts.fill='#145c56'] Dark teal disc
 * @param {string} [opts.outline='#3dd6c6'] Sites accent outline
 * @param {string} [opts.text='#f2fffc'] Readable light label
 * @returns {string|null} data URL, or null when canvas is unavailable
 */
export function buildSitesClusterBubbleDataUrl(count, {
  fill = '#145c56',
  outline = '#3dd6c6',
  text = '#f2fffc',
} = {}) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const key = sitesClusterBubbleCacheKey(n, fill, outline, text);
  const cached = _bubbleCache.get(key);
  if (cached) return cached;

  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null;
  }

  const { diameter, fontPx } = sitesClusterBubbleSize(n);
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(diameter * dpr);
  canvas.height = Math.ceil(diameter * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.scale(dpr, dpr);
  const r = diameter / 2;
  const cx = r;
  const cy = r;

  ctx.beginPath();
  ctx.arc(cx, cy, r - 1.25, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = outline;
  ctx.stroke();

  const label = sitesClusterBubbleLabel(n);
  ctx.fillStyle = text;
  ctx.font = `600 ${fontPx}px "IBM Plex Mono", "Share Tech Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Optical vertical nudge — monospace mid-line sits slightly high on discs.
  ctx.fillText(label, cx, cy + 0.5);

  const dataUrl = canvas.toDataURL('image/png');
  if (!_bubbleCache.has(key) && _bubbleCache.size >= BUBBLE_CACHE_MAX) {
    const oldest = _bubbleCache.keys().next().value;
    _bubbleCache.delete(oldest);
  }
  _bubbleCache.set(key, dataUrl);
  return dataUrl;
}

/** Clear bubble image cache (tests / teardown). */
export function resetSitesClusterBubbleCache() {
  _bubbleCache.clear();
}
