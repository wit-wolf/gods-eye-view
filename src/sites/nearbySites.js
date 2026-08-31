/**
 * Nearby imported-site helpers (haversine). Only uses pins already on the globe.
 */

const EARTH_RADIUS_M = 6371008.8;

/**
 * Great-circle distance in metres.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function haversineMetres(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2
    + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @typedef {{uid:string,name:string,latitude:number,longitude:number,distanceM:number}} NearbySite
 */

/**
 * List other imported sites within `radiusM` of a focus point.
 * @param {object} options
 * @param {string} options.focusUid
 * @param {number} options.latitude
 * @param {number} options.longitude
 * @param {Array<{uid:string,name?:string,latitude?:number,longitude?:number}>} options.sites
 * @param {number} [options.radiusM=2000]
 * @param {number} [options.limit=12]
 * @returns {NearbySite[]}
 */
export function findNearbySites({
  focusUid,
  latitude,
  longitude,
  sites,
  radiusM = 2000,
  limit = 12,
} = {}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  const out = [];
  for (const site of sites || []) {
    if (!site || site.uid === focusUid) continue;
    if (!Number.isFinite(site.latitude) || !Number.isFinite(site.longitude)) continue;
    const distanceM = haversineMetres(latitude, longitude, site.latitude, site.longitude);
    if (distanceM > radiusM) continue;
    out.push({
      uid: String(site.uid),
      name: String(site.name || 'Untitled site'),
      latitude: site.latitude,
      longitude: site.longitude,
      distanceM,
    });
  }
  out.sort((a, b) => a.distanceM - b.distanceM || a.name.localeCompare(b.name));
  return out.slice(0, Math.max(0, limit));
}

/**
 * Format a metre distance for the research card.
 * @param {number} metres
 * @returns {string}
 */
export function formatDistanceM(metres) {
  if (!Number.isFinite(metres)) return '—';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}
