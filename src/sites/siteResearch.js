/**
 * Sites research helpers — TomTom-first reverse locality + retail context
 * (server-side TOMTOM_API_KEY via /api/tomtom). Nominatim / Google Places are
 * fallbacks only. No invented Stats SA numbers or Genius scores.
 *
 * Retail context splits in-centre tenants from competing shopping centres so a
 * pin on a mall does not list the mall's own stores as competitors.
 */
import { fetchRegionalBrief } from '../data/regionalBrief.js';
import {
  placesNearbyRetailSearch,
} from '../search/googlePlacesSearch.js';
import { featureContainsPoint } from './geojsonJoin.js';
import { formatDistanceM, haversineMetres } from './nearbySites.js';
import {
  COMPETING_CENTRES_RADIUS_M,
  HOST_CENTRE_RADIUS_M,
  RETAIL_NEARBY_RADIUS_M,
  classifyRetailContext,
  isShoppingCentre,
} from './retailContext.js';

/**
 * Approximate ground distance (m) — same haversine used elsewhere when TomTom
 * omits `dist` on a cached/partial row.
 */
function approxDistanceM(lat1, lon1, lat2, lon2) {
  return Math.round(haversineMetres(lat1, lon1, lat2, lon2));
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
 * Normalize places from a /api/tomtom/nearby-poi JSON body.
 * @param {object} data
 * @param {number} latitude
 * @param {number} longitude
 */
function normalizeTomTomPlaces(data, latitude, longitude) {
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
      categoryIds: Array.isArray(row.categoryIds)
        ? row.categoryIds.map(Number).filter(Number.isFinite).slice(0, 4)
        : [],
      address: typeof row.address === 'string' ? row.address.slice(0, 200) : null,
      lat,
      lon,
    });
  }
  places.sort((a, b) => a.distanceM - b.distanceM);
  return places;
}

/**
 * TomTom nearby POI via same-origin proxy (allowlisted profile).
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} radiusM
 * @param {'retail'|'centres'|'stores'} profile
 * @param {AbortSignal} [signal]
 */
async function fetchTomTomNearbyPoi(latitude, longitude, radiusM, profile, signal) {
  const qs = new URLSearchParams({
    lat: String(latitude),
    lon: String(longitude),
    radius: String(radiusM),
    profile: String(profile || 'retail'),
  });
  let res;
  try {
    res = await fetch(`/api/tomtom/nearby-poi?${qs}`, { signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      status: 'error',
      places: [],
      totalResults: null,
      truncated: false,
      message: 'TomTom Places Search request failed.',
    };
  }
  const kind = await tomtomErrorKind(res);
  if (kind === 'no_key') {
    return {
      status: 'no_key',
      places: [],
      totalResults: null,
      truncated: false,
      message: 'TomTom key not configured.',
    };
  }
  if (kind === 'budget') {
    return {
      status: 'budget',
      places: [],
      totalResults: null,
      truncated: false,
      message: 'TomTom Evaluation search budget reached — try again later.',
    };
  }
  if (kind) {
    return {
      status: 'error',
      places: [],
      totalResults: null,
      truncated: false,
      message: 'TomTom Places Search unavailable.',
    };
  }
  const data = await res.json().catch(() => ({}));
  const places = normalizeTomTomPlaces(data, latitude, longitude);
  const totalResults = Number.isFinite(data?.totalResults) ? data.totalResults : null;
  const truncated = Boolean(data?.truncated)
    || (totalResults != null && places.length < totalResults);
  return {
    status: places.length ? 'ok' : 'empty',
    places,
    totalResults,
    truncated,
    returned: Number.isFinite(data?.returned) ? data.returned : places.length,
    message: places.length
      ? undefined
      : `No retail POIs found within ${Math.round(radiusM / 1000)} km (TomTom Places).`,
  };
}

/**
 * Optional OSM shop=mall footprint near the pin. Overpass is unreliable — never
 * required; failure simply falls back to the TomTom centre-point radius.
 * @param {number} latitude
 * @param {number} longitude
 * @param {AbortSignal} [signal]
 * @returns {Promise<{feature:object|null, source:string|null}>}
 */
export async function fetchOptionalMallPolygon(latitude, longitude, signal) {
  if (![latitude, longitude].every(Number.isFinite)) {
    return { feature: null, source: null };
  }
  const query = `[out:json][timeout:8];
(
  way(around:${HOST_CENTRE_RADIUS_M + 50},${latitude},${longitude})["shop"="mall"];
  relation(around:${HOST_CENTRE_RADIUS_M + 50},${latitude},${longitude})["shop"="mall"];
);
out tags geom;`;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) return { feature: null, source: null };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch('/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) return { feature: null, source: null };
    const data = await res.json().catch(() => null);
    const elements = Array.isArray(data?.elements) ? data.elements : [];
    const feature = osmMallElementToFeature(elements, latitude, longitude);
    return feature
      ? { feature, source: 'osm' }
      : { feature: null, source: null };
  } catch (err) {
    if (err?.name === 'AbortError' && signal?.aborted) throw err;
    return { feature: null, source: null };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Convert the nearest OSM shop=mall way/relation with geometry into a GeoJSON Feature.
 * @param {object[]} elements
 * @param {number} latitude
 * @param {number} longitude
 */
export function osmMallElementToFeature(elements, latitude, longitude) {
  const list = Array.isArray(elements) ? elements : [];
  /** @type {{feature:object, dist:number}[]} */
  const candidates = [];
  for (const el of list) {
    const tags = el?.tags || {};
    if (tags.shop !== 'mall') continue;
    const ring = osmGeometryToRing(el);
    if (!ring || ring.length < 4) continue;
    const feature = {
      type: 'Feature',
      properties: {
        name: tags.name || null,
        osmType: el.type || null,
        osmId: el.id ?? null,
        source: 'osm',
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    };
    // Prefer a polygon that contains the pin; else nearest centroid.
    const contains = featureContainsPoint(feature, longitude, latitude);
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const dist = contains
      ? 0
      : approxDistanceM(latitude, longitude, cy, cx);
    if (dist > HOST_CENTRE_RADIUS_M + 100 && !contains) continue;
    candidates.push({ feature, dist });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates[0]?.feature || null;
}

/**
 * @param {object} el Overpass element with geometry or members
 * @returns {number[][]|null} closed [lon,lat] ring
 */
function osmGeometryToRing(el) {
  if (Array.isArray(el?.geometry) && el.geometry.length >= 3) {
    const ring = el.geometry
      .map((p) => [Number(p.lon), Number(p.lat)])
      .filter((p) => p.every(Number.isFinite));
    if (ring.length < 3) return null;
    const [fLon, fLat] = ring[0];
    const [lLon, lLat] = ring[ring.length - 1];
    if (fLon !== lLon || fLat !== lLat) ring.push([fLon, fLat]);
    return ring;
  }
  // Relation: concatenate outer member geometries when present.
  if (el?.type === 'relation' && Array.isArray(el.members)) {
    const outers = el.members.filter((m) => m?.role === 'outer' && Array.isArray(m.geometry));
    if (!outers.length) return null;
    const ring = [];
    for (const m of outers) {
      for (const p of m.geometry) {
        const lon = Number(p.lon);
        const lat = Number(p.lat);
        if ([lon, lat].every(Number.isFinite)) ring.push([lon, lat]);
      }
    }
    if (ring.length < 3) return null;
    const [fLon, fLat] = ring[0];
    const [lLon, lLat] = ring[ring.length - 1];
    if (fLon !== lLon || fLat !== lLat) ring.push([fLon, fLat]);
    return ring;
  }
  return null;
}

/**
 * Build the public research payload from a classified retail context.
 * @param {ReturnType<typeof classifyRetailContext>} classified
 * @param {{source:string, osmUsed?:boolean, fallbackNote?:string, message?:string}} meta
 */
function packRetailContextResult(classified, meta) {
  const hasContent = classified.mode === 'in_centre'
    ? (classified.tenants.length > 0 || classified.competingCentres.length > 0)
    : (classified.retailNearby.length > 0 || classified.competingCentres.length > 0);

  // Legacy fields kept so older paint helpers / tests keep working.
  const within5km = classified.mode === 'in_centre'
    ? classified.tenants.filter((p) => p.distanceM <= 5000)
    : classified.retailWithin5km;
  const within2km = classified.mode === 'in_centre'
    ? classified.tenants.filter((p) => p.distanceM <= 2000)
    : classified.retailWithin2km;

  return {
    status: hasContent ? 'ok' : 'empty',
    mode: classified.mode,
    hostCentre: classified.hostCentre,
    tenants: classified.tenants,
    tenantGroups: classified.tenantGroups,
    competingCentres: classified.competingCentres,
    competingWithin5km: classified.competingWithin5km,
    competingWithin10km: classified.competingWithin10km,
    retailNearby: classified.retailNearby,
    retailWithin2km: classified.retailWithin2km,
    retailWithin5km: classified.retailWithin5km,
    standaloneAnchors: classified.standaloneAnchors,
    tenantRadiusM: classified.tenantRadiusM,
    usedMallPolygon: classified.usedMallPolygon,
    storesTruncated: classified.storesTruncated,
    storesTotalResults: classified.storesTotalResults,
    within2km,
    within5km,
    source: meta.source,
    osmUsed: Boolean(meta.osmUsed),
    fallbackNote: meta.fallbackNote,
    message: meta.message || (hasContent
      ? undefined
      : classified.mode === 'in_centre'
        ? 'No tenants or competing centres found near this pin.'
        : 'No retail anchors or competing centres found within 10 km.'),
  };
}

/**
 * Retail context for a pin: tenants-in-centre vs competing centres (or retail
 * nearby when the pin is not in a centre). TomTom Places first (≤2 profiled
 * calls + optional Overpass mall polygon); Google Places as labeled fallback.
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function loadSiteCompetitors(latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    return {
      status: 'unavailable',
      mode: 'open_site',
      within2km: [],
      within5km: [],
      tenants: [],
      tenantGroups: [],
      competingCentres: [],
      competingWithin5km: [],
      competingWithin10km: [],
      retailNearby: [],
      retailWithin2km: [],
      retailWithin5km: [],
      standaloneAnchors: [],
      hostCentre: null,
      message: 'Pin has no coordinates.',
      source: null,
    };
  }

  // Two TomTom profile calls in parallel (+ optional Overpass). Centres ring
  // covers host detection and competing malls; stores cover tenants / retail.
  const [centresRes, storesRes, mallRes] = await Promise.all([
    fetchTomTomNearbyPoi(
      latitude,
      longitude,
      COMPETING_CENTRES_RADIUS_M,
      'centres',
      signal,
    ),
    fetchTomTomNearbyPoi(
      latitude,
      longitude,
      COMPETING_CENTRES_RADIUS_M,
      'stores',
      signal,
    ),
    fetchOptionalMallPolygon(latitude, longitude, signal).catch((err) => {
      if (err?.name === 'AbortError') throw err;
      return { feature: null, source: null };
    }),
  ]);

  const tomtomUsable = (centresRes.status === 'ok' || centresRes.status === 'empty')
    && (storesRes.status === 'ok' || storesRes.status === 'empty');

  if (tomtomUsable) {
    const classified = classifyRetailContext({
      latitude,
      longitude,
      centres: centresRes.places,
      stores: storesRes.places,
      mallFeature: mallRes?.feature || null,
      storesMeta: {
        truncated: storesRes.truncated,
        totalResults: storesRes.totalResults,
      },
    });
    return packRetailContextResult(classified, {
      source: 'tomtom',
      osmUsed: Boolean(mallRes?.feature),
    });
  }

  // Fallback: browser Google Places (ZA Maps key already used for search).
  const google = await placesNearbyRetailSearch(latitude, longitude, RETAIL_NEARBY_RADIUS_M, {
    signal,
    maxResultCount: 20,
  });

  const tomtomStatus = centresRes.status !== 'ok' && centresRes.status !== 'empty'
    ? centresRes.status
    : storesRes.status;
  const tomtomMessage = centresRes.message || storesRes.message;

  if (google.status === 'ok' || google.status === 'empty') {
    const places = (google.places || []).map((p) => ({
      ...p,
      categoryIds: [],
      types: p.primaryType ? [p.primaryType, ...(p.types || [])] : (p.types || []),
      _forceCentre: /shopping_mall|shopping.?mall/i.test(
        `${p.primaryType || ''} ${(p.types || []).join(' ')}`,
      ),
    }));
    const centres = places.filter((p) => isShoppingCentre(p) || p._forceCentre);
    const stores = places.filter((p) => !isShoppingCentre(p) && !p._forceCentre);
    const classified = classifyRetailContext({
      latitude,
      longitude,
      centres,
      stores,
      mallFeature: null,
      storesMeta: {},
    });
    const budgetNote = tomtomStatus === 'budget'
      ? ' TomTom search budget reached — using Google Places.'
      : tomtomStatus === 'no_key'
        ? ' TomTom key missing — using Google Places.'
        : ' TomTom Places unavailable — using Google Places.';
    return packRetailContextResult(classified, {
      source: 'google',
      fallbackNote: budgetNote,
      message: classified.mode === 'open_site' && !classified.retailNearby.length
        && !classified.competingCentres.length
        ? (google.message || 'No retail anchors found within 5 km (Places).')
        : undefined,
    });
  }

  if (tomtomStatus === 'budget') {
    return {
      status: 'budget',
      mode: 'open_site',
      within2km: [],
      within5km: [],
      tenants: [],
      tenantGroups: [],
      competingCentres: [],
      competingWithin5km: [],
      competingWithin10km: [],
      retailNearby: [],
      retailWithin2km: [],
      retailWithin5km: [],
      standaloneAnchors: [],
      hostCentre: null,
      message: tomtomMessage
        + (google.status === 'keyless'
          ? ' Google Places also unavailable (no Maps key).'
          : ''),
      source: 'tomtom',
    };
  }
  if (tomtomStatus === 'no_key' && google.status === 'keyless') {
    return {
      status: 'keyless',
      mode: 'open_site',
      within2km: [],
      within5km: [],
      tenants: [],
      tenantGroups: [],
      competingCentres: [],
      competingWithin5km: [],
      competingWithin10km: [],
      retailNearby: [],
      retailWithin2km: [],
      retailWithin5km: [],
      standaloneAnchors: [],
      hostCentre: null,
      message: 'No TomTom or Google Maps key — retail nearby search unavailable.',
      source: null,
    };
  }
  return {
    status: google.status === 'denied' ? 'denied' : 'unavailable',
    mode: 'open_site',
    within2km: [],
    within5km: [],
    tenants: [],
    tenantGroups: [],
    competingCentres: [],
    competingWithin5km: [],
    competingWithin10km: [],
    retailNearby: [],
    retailWithin2km: [],
    retailWithin5km: [],
    standaloneAnchors: [],
    hostCentre: null,
    message: google.message || tomtomMessage || 'Retail context search unavailable.',
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

/**
 * Source attribution line for the retail-context card.
 * @param {object} competitors
 */
export function retailContextSourceLabel(competitors) {
  const bits = [];
  if (competitors?.source === 'tomtom') bits.push('TomTom Places Search');
  else if (competitors?.source === 'google') {
    bits.push(`Google Places${competitors.fallbackNote || ''}`);
  }
  if (competitors?.osmUsed) bits.push('OSM shop=mall footprint');
  if (!bits.length) return '';
  return ` · ${bits.join(' + ')}`;
}
