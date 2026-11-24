/**
 * Pure retail-context helpers for the Sites research card.
 *
 * Separates in-centre tenants from competing shopping centres so a pin on a
 * mall does not list the mall's own stores as "competitors". No invented
 * scores — classification uses TomTom category ids/names + distance only.
 */

import { haversineMetres } from './nearbySites.js';
import { featureContainsPoint } from './geojsonJoin.js';

/** Pin is "in / very near" a shopping centre within this radius (m). */
export const HOST_CENTRE_RADIUS_M = 250;
/** Without a mall polygon, tenants are stores within this of the centre point. */
export const TENANT_RADIUS_M = 200;
/** Competing centres search ring (m). */
export const COMPETING_CENTRES_RADIUS_M = 10_000;
/** Retail-nearby ring when the pin is not in a centre (m). */
export const RETAIL_NEARBY_RADIUS_M = 5_000;
/** Optional standalone anchors outside the host centre (m). */
export const STANDALONE_ANCHOR_RADIUS_M = 3_000;

/** TomTom shopping-centre category id. */
export const TOMTOM_SHOPPING_CENTRE_ID = 7373;
/** TomTom department-store category id. */
export const TOMTOM_DEPARTMENT_STORE_ID = 7327;
/** TomTom market category id. */
export const TOMTOM_MARKET_ID = 7332;

/** Display order for tenant category groups. */
export const TENANT_CATEGORY_ORDER = Object.freeze([
  'fashion',
  'food',
  'grocery',
  'department store',
  'services',
  'other',
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when a POI is a shopping centre / mall (TomTom 7373 or name/type).
 * @param {{primaryType?:string|null, types?:string[], categoryIds?:number[], name?:string}} place
 */
export function isShoppingCentre(place) {
  if (!place || typeof place !== 'object') return false;
  const ids = Array.isArray(place.categoryIds) ? place.categoryIds : [];
  if (ids.some((id) => Number(id) === TOMTOM_SHOPPING_CENTRE_ID)) return true;
  const blob = [
    place.primaryType,
    ...(Array.isArray(place.types) ? place.types : []),
    place.name,
  ].filter(Boolean).join(' ').toLowerCase();
  return /shopping\s*cent(?:er|re)|\bmall\b|shopping\s*plaza/.test(blob);
}

/**
 * True when a POI is a major standalone anchor (department store / hypermarket /
 * supermarket) — useful as a small sub-list outside the host centre.
 * @param {{primaryType?:string|null, types?:string[], categoryIds?:number[], name?:string}} place
 */
export function isStandaloneAnchor(place) {
  if (!place || isShoppingCentre(place)) return false;
  const ids = Array.isArray(place.categoryIds) ? place.categoryIds : [];
  if (ids.some((id) => Number(id) === TOMTOM_DEPARTMENT_STORE_ID
    || Number(id) === TOMTOM_MARKET_ID)) {
    return true;
  }
  const blob = [
    place.primaryType,
    ...(Array.isArray(place.types) ? place.types : []),
    place.name,
  ].filter(Boolean).join(' ').toLowerCase();
  return /department\s*store|hypermarket|supermarket|grocery/.test(blob);
}

/**
 * Bucket a store into a landlord-friendly tenant category.
 * Uses TomTom type strings / category ids only — never invents a brand class.
 * @param {{primaryType?:string|null, types?:string[], categoryIds?:number[], name?:string}} place
 * @returns {typeof TENANT_CATEGORY_ORDER[number]}
 */
export function tenantCategoryKey(place) {
  const ids = Array.isArray(place?.categoryIds) ? place.categoryIds.map(Number) : [];
  if (ids.includes(TOMTOM_DEPARTMENT_STORE_ID)) return 'department store';
  if (ids.includes(TOMTOM_MARKET_ID)) return 'grocery';

  const blob = [
    place?.primaryType,
    ...(Array.isArray(place?.types) ? place.types : []),
  ].filter(Boolean).join(' ').toLowerCase();

  if (/department/.test(blob)) return 'department store';
  if (/supermarket|grocery|market|convenience|hypermarket/.test(blob)) return 'grocery';
  if (/restaurant|cafe|coffee|bakery|food|fast\s*food|pub|bar/.test(blob)) return 'food';
  if (/cloth|fashion|shoe|apparel|boutique|jewell?er|sport|wear/.test(blob)) return 'fashion';
  if (/bank|pharm|salon|hair|dry\s*clean|post\s*office|service|optic|atm|clinic|dentist/.test(blob)) {
    return 'services';
  }
  // Generic TomTom "shop" (9361) — keep as other rather than guessing fashion.
  if (/shop|store|retail/.test(blob)) return 'other';
  return 'other';
}

/**
 * Closest shopping centre within HOST_CENTRE_RADIUS_M of the pin.
 * @param {number} latitude
 * @param {number} longitude
 * @param {Array<{name:string,distanceM?:number,lat:number,lon:number,id?:string|null}>} centres
 * @param {{geometry?:object}|null} [mallFeature] optional OSM mall polygon
 * @returns {object|null}
 */
export function detectHostCentre(latitude, longitude, centres, mallFeature = null) {
  if (![latitude, longitude].every(Number.isFinite)) return null;
  const list = (Array.isArray(centres) ? centres : [])
    .filter((c) => c && typeof c.name === 'string' && c.name.trim())
    .map((c) => {
      const distanceM = Number.isFinite(c.distanceM)
        ? c.distanceM
        : ([c.lat, c.lon].every(Number.isFinite)
          ? Math.round(haversineMetres(latitude, longitude, c.lat, c.lon))
          : Number.POSITIVE_INFINITY);
      return { ...c, distanceM };
    })
    .filter((c) => Number.isFinite(c.distanceM))
    .sort((a, b) => a.distanceM - b.distanceM);

  if (mallFeature?.geometry) {
    const containing = list.find((c) => featureContainsPoint(mallFeature, c.lon, c.lat)
      || featureContainsPoint(mallFeature, longitude, latitude));
    if (containing && containing.distanceM <= Math.max(HOST_CENTRE_RADIUS_M, 500)) {
      return containing;
    }
    // Pin inside a mall polygon even if TomTom centre point is slightly farther.
    if (featureContainsPoint(mallFeature, longitude, latitude) && list[0]
      && list[0].distanceM <= 500) {
      return list[0];
    }
  }

  const near = list.find((c) => c.distanceM <= HOST_CENTRE_RADIUS_M);
  return near || null;
}

/**
 * Whether a store belongs to the host centre's tenant mix.
 * @param {object} store
 * @param {object} hostCentre
 * @param {{geometry?:object}|null} [mallFeature]
 * @param {number} [tenantRadiusM]
 */
export function isTenantOfCentre(store, hostCentre, mallFeature = null, tenantRadiusM = TENANT_RADIUS_M) {
  if (!store || !hostCentre) return false;
  if (isShoppingCentre(store)) return false;
  if (hostCentre.id && store.id && hostCentre.id === store.id) return false;

  if (mallFeature?.geometry && [store.lon, store.lat].every(Number.isFinite)) {
    if (featureContainsPoint(mallFeature, store.lon, store.lat)) return true;
  }

  const centreLat = hostCentre.lat;
  const centreLon = hostCentre.lon;
  if ([centreLat, centreLon, store.lat, store.lon].every(Number.isFinite)) {
    const d = Number.isFinite(store._distToHost)
      ? store._distToHost
      : Math.round(haversineMetres(centreLat, centreLon, store.lat, store.lon));
    if (d <= tenantRadiusM) return true;
  } else if (Number.isFinite(store.distanceM) && store.distanceM <= tenantRadiusM) {
    // Fallback when only pin-relative distance is available and the pin is on the centre.
    if (Number.isFinite(hostCentre.distanceM) && hostCentre.distanceM <= HOST_CENTRE_RADIUS_M) {
      return store.distanceM <= tenantRadiusM;
    }
  }

  const centreName = normalizeText(hostCentre.name);
  if (centreName) {
    const hay = `${normalizeText(store.address)} ${normalizeText(store.name)}`;
    if (hay.includes(centreName)) return true;
  }
  return false;
}

/**
 * Group tenants by category for the card.
 * @param {Array<object>} tenants
 * @returns {Array<{key:string, label:string, places:object[]}>}
 */
export function groupTenantsByCategory(tenants) {
  /** @type {Map<string, object[]>} */
  const buckets = new Map(TENANT_CATEGORY_ORDER.map((k) => [k, []]));
  for (const place of Array.isArray(tenants) ? tenants : []) {
    const key = tenantCategoryKey(place);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(place);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0)
      || String(a.name || '').localeCompare(String(b.name || '')));
  }
  return TENANT_CATEGORY_ORDER
    .map((key) => ({
      key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      places: buckets.get(key) || [],
    }))
    .filter((g) => g.places.length > 0);
}

/**
 * Classify TomTom (or compatible) POIs into tenants / competing centres / retail nearby.
 *
 * @param {object} input
 * @param {number} input.latitude
 * @param {number} input.longitude
 * @param {Array<object>} [input.centres] shopping centres (TomTom 7373)
 * @param {Array<object>} [input.stores] non-centre retail POIs
 * @param {{geometry?:object, properties?:object}|null} [input.mallFeature]
 * @param {{totalResults?:number|null, truncated?:boolean}} [input.storesMeta]
 * @returns {{
 *   mode:'in_centre'|'open_site',
 *   hostCentre:object|null,
 *   tenants:object[],
 *   tenantGroups:Array<{key:string,label:string,places:object[]}>,
 *   competingCentres:object[],
 *   competingWithin5km:object[],
 *   competingWithin10km:object[],
 *   retailNearby:object[],
 *   retailWithin2km:object[],
 *   retailWithin5km:object[],
 *   standaloneAnchors:object[],
 *   tenantRadiusM:number,
 *   usedMallPolygon:boolean,
 *   storesTruncated:boolean,
 *   storesTotalResults:number|null,
 * }}
 */
export function classifyRetailContext({
  latitude,
  longitude,
  centres = [],
  stores = [],
  mallFeature = null,
  storesMeta = {},
} = {}) {
  const centreList = (Array.isArray(centres) ? centres : [])
    .filter((c) => c && c.name && [c.lat, c.lon].every(Number.isFinite))
    .map((c) => ({
      ...c,
      distanceM: Number.isFinite(c.distanceM)
        ? c.distanceM
        : Math.round(haversineMetres(latitude, longitude, c.lat, c.lon)),
    }))
    .sort((a, b) => a.distanceM - b.distanceM);

  // Centres endpoint is categorySet=7373; still drop non-centres if a mixed list is passed.
  // `_forceCentre` lets fixtures mark centres without inventing TomTom category ids.
  const onlyCentres = centreList.filter((c) => isShoppingCentre(c) || c._forceCentre === true);
  const hostCentre = detectHostCentre(latitude, longitude, onlyCentres, mallFeature);
  const usedMallPolygon = Boolean(mallFeature?.geometry);

  const storeList = (Array.isArray(stores) ? stores : [])
    .filter((s) => s && s.name && [s.lat, s.lon].every(Number.isFinite))
    .filter((s) => !isShoppingCentre(s))
    .map((s) => ({
      ...s,
      distanceM: Number.isFinite(s.distanceM)
        ? s.distanceM
        : Math.round(haversineMetres(latitude, longitude, s.lat, s.lon)),
    }))
    .sort((a, b) => a.distanceM - b.distanceM);

  if (hostCentre) {
    const tenants = storeList
      .map((s) => {
        const distToHost = [hostCentre.lat, hostCentre.lon, s.lat, s.lon].every(Number.isFinite)
          ? Math.round(haversineMetres(hostCentre.lat, hostCentre.lon, s.lat, s.lon))
          : s.distanceM;
        return { ...s, _distToHost: distToHost, distanceM: distToHost };
      })
      .filter((s) => isTenantOfCentre(s, hostCentre, mallFeature, TENANT_RADIUS_M))
      .sort((a, b) => a.distanceM - b.distanceM);

    const tenantIds = new Set(tenants.map((t) => t.id).filter(Boolean));
    const competingCentres = onlyCentres
      .filter((c) => {
        if (hostCentre.id && c.id && c.id === hostCentre.id) return false;
        if (c === hostCentre) return false;
        if (normalizeText(c.name) === normalizeText(hostCentre.name)
          && Math.abs(c.distanceM - hostCentre.distanceM) < 50) {
          return false;
        }
        return c.distanceM <= COMPETING_CENTRES_RADIUS_M;
      })
      .sort((a, b) => a.distanceM - b.distanceM);

    const standaloneAnchors = storeList
      .filter((s) => !tenantIds.has(s.id))
      .filter((s) => !isTenantOfCentre(s, hostCentre, mallFeature, TENANT_RADIUS_M))
      .filter((s) => isStandaloneAnchor(s))
      .filter((s) => s.distanceM <= STANDALONE_ANCHOR_RADIUS_M
        && s.distanceM > TENANT_RADIUS_M)
      .slice(0, 8);

    return {
      mode: 'in_centre',
      hostCentre,
      tenants,
      tenantGroups: groupTenantsByCategory(tenants),
      competingCentres,
      competingWithin5km: competingCentres.filter((c) => c.distanceM <= 5000),
      competingWithin10km: competingCentres.filter((c) => c.distanceM <= COMPETING_CENTRES_RADIUS_M),
      retailNearby: [],
      retailWithin2km: [],
      retailWithin5km: [],
      standaloneAnchors,
      tenantRadiusM: TENANT_RADIUS_M,
      usedMallPolygon,
      storesTruncated: Boolean(storesMeta.truncated),
      storesTotalResults: Number.isFinite(storesMeta.totalResults) ? storesMeta.totalResults : null,
    };
  }

  const retailNearby = storeList.filter((s) => s.distanceM <= RETAIL_NEARBY_RADIUS_M);
  const competingCentres = onlyCentres
    .filter((c) => c.distanceM <= COMPETING_CENTRES_RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM);

  return {
    mode: 'open_site',
    hostCentre: null,
    tenants: [],
    tenantGroups: [],
    competingCentres,
    competingWithin5km: competingCentres.filter((c) => c.distanceM <= 5000),
    competingWithin10km: competingCentres.filter((c) => c.distanceM <= COMPETING_CENTRES_RADIUS_M),
    retailNearby,
    retailWithin2km: retailNearby.filter((s) => s.distanceM <= 2000),
    retailWithin5km: retailNearby,
    standaloneAnchors: [],
    tenantRadiusM: TENANT_RADIUS_M,
    usedMallPolygon: false,
    storesTruncated: Boolean(storesMeta.truncated),
    storesTotalResults: Number.isFinite(storesMeta.totalResults) ? storesMeta.totalResults : null,
  };
}
