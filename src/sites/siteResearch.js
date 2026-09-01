/**
 * Sites research helpers — reverse locality + Places competitors (free / existing keys).
 * No invented Stats SA numbers or Genius scores.
 */
import { fetchRegionalBrief } from '../data/regionalBrief.js';
import {
  placesNearbyRetailSearch,
} from '../search/googlePlacesSearch.js';
import { formatDistanceM } from './nearbySites.js';

/**
 * Reverse-geocode via the existing regional-brief Nominatim path (free).
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
 * @returns {Promise<{
 *   status:'ok'|'unavailable',
 *   label:string|null,
 *   locality:string|null,
 *   region:string|null,
 *   country:string|null,
 *   message?:string
 * }>}
 */
export async function loadSiteLocality(latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    return {
      status: 'unavailable',
      label: null,
      locality: null,
      region: null,
      country: null,
      message: 'Pin has no coordinates.',
    };
  }
  try {
    const payload = await fetchRegionalBrief(latitude, longitude, { signal });
    const place = payload?.place;
    if (!place?.label) {
      return {
        status: 'unavailable',
        label: null,
        locality: null,
        region: null,
        country: null,
        message: 'Locality unavailable for this pin.',
      };
    }
    return {
      status: 'ok',
      label: place.label,
      locality: place.locality || null,
      region: place.region || null,
      country: place.country || null,
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      status: 'unavailable',
      label: null,
      locality: null,
      region: null,
      country: null,
      message: err?.message || 'Locality lookup failed.',
    };
  }
}

/**
 * Retail competitors within 2 km and 5 km via browser Places Nearby.
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function loadSiteCompetitors(latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    return {
      status: 'unavailable',
      within2km: [],
      within5km: [],
      message: 'Pin has no coordinates.',
    };
  }

  // One 5 km nearby call, then split by distance — saves Places quota.
  const result = await placesNearbyRetailSearch(latitude, longitude, 5000, {
    signal,
    maxResultCount: 16,
  });

  if (result.status !== 'ok' && result.status !== 'empty') {
    return {
      status: result.status,
      within2km: [],
      within5km: [],
      message: result.message || 'Competitor search unavailable.',
    };
  }

  const within5km = result.places || [];
  const within2km = within5km.filter((p) => p.distanceM <= 2000);
  return {
    status: within5km.length ? 'ok' : 'empty',
    within2km,
    within5km,
    message: within5km.length
      ? undefined
      : 'No retail anchors found within 5 km (Places).',
  };
}

/**
 * @param {Array<{name:string,distanceM:number,primaryType?:string|null}>} places
 * @param {number} limit
 * @returns {string} HTML list items (caller escapes via this helper)
 */
export function formatCompetitorListHtml(places, limit = 8, escapeHtml) {
  const esc = typeof escapeHtml === 'function'
    ? escapeHtml
    : (v) => String(v ?? '');
  const list = Array.isArray(places) ? places.slice(0, limit) : [];
  if (!list.length) return '';
  return list.map((place) => {
    const type = place.primaryType ? ` · ${place.primaryType}` : '';
    return `<li>
      <span>${esc(place.name)}${esc(type)}</span>
      <span class="site-card-dist">${esc(formatDistanceM(place.distanceM))}</span>
    </li>`;
  }).join('');
}
