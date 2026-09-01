/**
 * Sites research helpers — TomTom-first reverse locality + retail POI ring
 * (server-side TOMTOM_API_KEY via /api/tomtom). Nominatim / Google Places are
 * fallbacks only. No invented Stats SA numbers or Genius scores.
 */
import { fetchRegionalBrief } from '../data/regionalBrief.js';
import {
  placesNearbyRetailSearch,
} from '../search/googlePlacesSearch.js';
import { formatDistanceM } from './nearbySites.js';

/**
 * Approximate ground distance (m) — same haversine used elsewhere when TomTom
 * omits `dist` on a cached/partial row.
 */
function approxDistanceM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * @param {Response} res
 * @returns {Promise<'no_key'|'budget'|'upstream'|null>}
 */
async function tomtomErrorKind(res) {
  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    return body?.error === 'no_key' ? 'no_key' : 'upstream';
  }
  if (res.status === 429) return 'budget';
  if (!res.ok) return 'upstream';
  return null;
}

/**
 * TomTom reverse geocode via same-origin proxy.
 * @returns {Promise<{
 *   status:'ok'|'empty'|'no_key'|'budget'|'error',
 *   label:string|null,
 *   locality:string|null,
 *   region:string|null,
 *   country:string|null,
 *   message?:string
 * }>}
 */
async function fetchTomTomLocality(latitude, longitude, signal) {
  const qs = new URLSearchParams({
    lat: String(latitude),
    lon: String(longitude),
  });
  let res;
  try {
    res = await fetch(`/api/tomtom/reverse-geocode?${qs}`, { signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      status: 'error',
      label: null,
      locality: null,
      region: null,
      country: null,
      message: 'TomTom reverse geocode request failed.',
    };
  }
  const kind = await tomtomErrorKind(res);
  if (kind === 'no_key') {
    return {
      status: 'no_key',
      label: null,
      locality: null,
      region: null,
      country: null,
      message: 'TomTom key not configured.',
    };
  }
  if (kind === 'budget') {
    return {
      status: 'budget',
      label: null,
      locality: null,
      region: null,
      country: null,
      message: 'TomTom Evaluation search budget reached — try again later.',
    };
  }
  if (kind) {
    return {
      status: 'error',
      label: null,
      locality: null,
      region: null,
      country: null,
      message: 'TomTom reverse geocode unavailable.',
    };
  }
  const data = await res.json().catch(() => ({}));
  if (!data?.label) {
    return {
      status: 'empty',
      label: null,
      locality: null,
      region: null,
      country: null,
      message: 'No reverse-geocode match for this pin.',
    };
  }
  return {
    status: 'ok',
    label: data.label,
    locality: data.locality || null,
    region: data.region || null,
    country: data.country || null,
  };
}

/**
 * Nominatim via regional-brief (free fallback).
 */
async function fetchNominatimLocality(latitude, longitude, signal) {
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
      source: 'nominatim',
    };
  }
  return {
    status: 'ok',
    label: place.label,
    locality: place.locality || null,
    region: place.region || null,
    country: place.country || null,
    source: 'nominatim',
  };
}

/**
 * Reverse-geocode: TomTom first, Nominatim fallback when keyless / budget /
 * empty / upstream error. Never invents an address.
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
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
      source: null,
    };
  }

  const tomtom = await fetchTomTomLocality(latitude, longitude, signal);
  if (tomtom.status === 'ok') {
    return { ...tomtom, source: 'tomtom' };
  }

  // Prefer a free Nominatim answer over a hard fail when Evaluation quota
  // is exhausted or the key is missing — still label the source honestly.
  try {
    const nominatim = await fetchNominatimLocality(latitude, longitude, signal);
    if (nominatim.status === 'ok') {
      const note = tomtom.status === 'budget'
        ? ' (TomTom search budget reached — using Nominatim)'
        : tomtom.status === 'no_key'
          ? ' (TomTom key missing — using Nominatim)'
          : '';
      return {
        ...nominatim,
        fallbackNote: note || undefined,
      };
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
  }

  if (tomtom.status === 'budget') {
    return {
      status: 'unavailable',
      label: null,
      locality: null,
      region: null,
      country: null,
      message: tomtom.message,
      source: 'tomtom',
    };
  }
  if (tomtom.status === 'no_key') {
    return {
      status: 'unavailable',
      label: null,
      locality: null,
      region: null,
      country: null,
      message: 'Locality unavailable (no TomTom key; Nominatim also failed).',
      source: null,
    };
  }
  return {
    status: 'unavailable',
    label: null,
    locality: null,
    region: null,
    country: null,
    message: tomtom.message || 'Locality unavailable for this pin.',
    source: null,
  };
}

/**
 * TomTom nearby retail POI via same-origin proxy.
 * @returns {Promise<{
 *   status:'ok'|'empty'|'no_key'|'budget'|'error',
 *   places:Array,
 *   message?:string
 * }>}
 */
async function fetchTomTomNearbyPoi(latitude, longitude, radiusM, signal) {
  const qs = new URLSearchParams({
    lat: String(latitude),
    lon: String(longitude),
    radius: String(radiusM),
  });
  let res;
  try {
    res = await fetch(`/api/tomtom/nearby-poi?${qs}`, { signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      status: 'error',
      places: [],
      message: 'TomTom Places Search request failed.',
    };
  }
  const kind = await tomtomErrorKind(res);
  if (kind === 'no_key') {
    return {
      status: 'no_key',
      places: [],
      message: 'TomTom key not configured.',
    };
  }
  if (kind === 'budget') {
    return {
      status: 'budget',
      places: [],
      message: 'TomTom Evaluation search budget reached — try again later.',
    };
  }
  if (kind) {
    return {
      status: 'error',
      places: [],
      message: 'TomTom Places Search unavailable.',
    };
  }
  const data = await res.json().catch(() => ({}));
  const places = [];
  for (const row of Array.isArray(data?.places) ? data.places : []) {
    const lat = row?.lat;
    const lon = row?.lon;
    const name = row?.name;
    if (!name || ![lat, lon].every(Number.isFinite)) continue;
    places.push({
      id: row.id || null,
      name: String(name).slice(0, 160),
      distanceM: Number.isFinite(row.distanceM)
        ? row.distanceM
        : approxDistanceM(latitude, longitude, lat, lon),
      primaryType: row.primaryType || null,
      types: Array.isArray(row.types) ? row.types.slice(0, 8) : [],
      lat,
      lon,
    });
  }
  places.sort((a, b) => a.distanceM - b.distanceM);
  return {
    status: places.length ? 'ok' : 'empty',
    places,
    message: places.length
      ? undefined
      : 'No retail anchors found within 5 km (TomTom Places).',
  };
}

/**
 * Retail competitors within 2 km / 5 km: TomTom Places Search first, Google
 * Places Nearby as fallback when Maps key works.
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
      source: null,
    };
  }

  const tomtom = await fetchTomTomNearbyPoi(latitude, longitude, 5000, signal);
  if (tomtom.status === 'ok' || tomtom.status === 'empty') {
    const within5km = tomtom.places;
    const within2km = within5km.filter((p) => p.distanceM <= 2000);
    return {
      status: within5km.length ? 'ok' : 'empty',
      within2km,
      within5km,
      message: tomtom.message,
      source: 'tomtom',
    };
  }

  // Fallback: browser Google Places (ZA Maps key already used for search).
  const google = await placesNearbyRetailSearch(latitude, longitude, 5000, {
    signal,
    maxResultCount: 16,
  });

  if (google.status === 'ok' || google.status === 'empty') {
    const within5km = google.places || [];
    const within2km = within5km.filter((p) => p.distanceM <= 2000);
    const budgetNote = tomtom.status === 'budget'
      ? ' TomTom search budget reached — using Google Places.'
      : tomtom.status === 'no_key'
        ? ' TomTom key missing — using Google Places.'
        : ' TomTom Places unavailable — using Google Places.';
    return {
      status: within5km.length ? 'ok' : 'empty',
      within2km,
      within5km,
      message: within5km.length
        ? undefined
        : (google.message || 'No retail anchors found within 5 km (Places).'),
      source: 'google',
      fallbackNote: budgetNote,
    };
  }

  if (tomtom.status === 'budget') {
    return {
      status: 'budget',
      within2km: [],
      within5km: [],
      message: tomtom.message
        + (google.status === 'keyless'
          ? ' Google Places also unavailable (no Maps key).'
          : ''),
      source: 'tomtom',
    };
  }
  if (tomtom.status === 'no_key' && google.status === 'keyless') {
    return {
      status: 'keyless',
      within2km: [],
      within5km: [],
      message: 'No TomTom or Google Maps key — competitor nearby search unavailable.',
      source: null,
    };
  }
  return {
    status: google.status === 'denied' ? 'denied' : 'unavailable',
    within2km: [],
    within5km: [],
    message: google.message || tomtom.message || 'Competitor search unavailable.',
    source: null,
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
