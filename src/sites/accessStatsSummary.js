/**
 * Pure helpers for Sites research-brief Access / traffic summaries.
 * Cesium-free — unit-testable with node:test. No invented demographics.
 */

import { flowBucket } from '../data/trafficFlowStyle.js';

/** Drive-time rings requested for free-tier Routing / reachable-range. */
export const DRIVE_TIME_MINUTES = Object.freeze([5, 10, 15]);

/** Mean Earth radius (km) for spherical distance helpers. */
const EARTH_RADIUS_KM = 6371;

/** Below this many flow segments, show a thin-coverage note. */
export const FLOW_COVERAGE_SOFT_MIN = 8;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Approximate degree span for a km radius at a given latitude.
 * Lon span is cos(lat)-adjusted so the box stays roughly circular.
 *
 * @param {number} latDeg
 * @param {number} radiusKm
 * @returns {{latSpanDeg:number, lonSpanDeg:number}}
 */
export function spanDegForRadiusKm(latDeg, radiusKm) {
  const latSpanDeg = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI) * 2;
  const cosLat = Math.max(0.2, Math.cos(toRad(latDeg)));
  const lonSpanDeg = latSpanDeg / cosLat;
  return { latSpanDeg, lonSpanDeg };
}

/**
 * Bounding box centred on a pin for TomTom flow tile fetch (~1–2 km).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} [radiusKm=1.5]
 * @returns {{south:number, west:number, north:number, east:number}|null}
 */
export function boundsAroundPin(lat, lon, radiusKm = 1.5) {
  if (![lat, lon, radiusKm].every(Number.isFinite) || radiusKm <= 0) return null;
  const { latSpanDeg, lonSpanDeg } = spanDegForRadiusKm(lat, radiusKm);
  return {
    south: lat - latSpanDeg / 2,
    north: lat + latSpanDeg / 2,
    west: lon - lonSpanDeg / 2,
    east: lon + lonSpanDeg / 2,
  };
}

/**
 * Haversine distance (km) between two lat/lon points.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number}
 */
export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Midpoint of a [[lon,lat],…] polyline (average of vertices).
 * @param {number[][]} coords
 * @returns {{lat:number, lon:number}|null}
 */
export function polylineMidpoint(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  let lonSum = 0;
  let latSum = 0;
  let n = 0;
  for (const pt of coords) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const [lon, lat] = pt;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    lonSum += lon;
    latSum += lat;
    n += 1;
  }
  if (n === 0) return null;
  return { lon: lonSum / n, lat: latSum / n };
}

/**
 * Keep flow segments whose midpoint lies within `radiusKm` of the pin.
 *
 * @param {Array<{coords:number[][]}>} segments
 * @param {number} lat
 * @param {number} lon
 * @param {number} [radiusKm=2]
 * @returns {Array}
 */
export function filterSegmentsNearPin(segments, lat, lon, radiusKm = 2) {
  if (!Array.isArray(segments) || ![lat, lon].every(Number.isFinite)) return [];
  return segments.filter((seg) => {
    const mid = polylineMidpoint(seg?.coords);
    if (!mid) return false;
    return greatCircleKm(lat, lon, mid.lat, mid.lon) <= radiusKm;
  });
}

/**
 * Bucket TomTom flow segments into free / slow / jam + closures.
 * Does not invent levels — only counts segments that already carry trafficLevel.
 *
 * @param {Array<{trafficLevel?:number, closure?:boolean}>} segments
 * @returns {{
 *   free:number, slow:number, jam:number, closures:number, total:number,
 *   pctFree:number|null, pctSlow:number|null, pctJam:number|null,
 *   thinCoverage:boolean
 * }}
 */
export function summarizeFlowSegments(segments) {
  const empty = {
    free: 0,
    slow: 0,
    jam: 0,
    closures: 0,
    total: 0,
    pctFree: null,
    pctSlow: null,
    pctJam: null,
    thinCoverage: true,
  };
  if (!Array.isArray(segments) || segments.length === 0) return empty;

  let free = 0;
  let slow = 0;
  let jam = 0;
  let closures = 0;
  let total = 0;
  for (const seg of segments) {
    if (seg?.closure) closures += 1;
    if (!Number.isFinite(seg?.trafficLevel)) continue;
    total += 1;
    const bucket = flowBucket(seg.trafficLevel);
    if (bucket === 'free') free += 1;
    else if (bucket === 'slow') slow += 1;
    else jam += 1;
  }

  const pct = (n) => (total > 0 ? Math.round((100 * n) / total) : null);
  return {
    free,
    slow,
    jam,
    closures,
    total,
    pctFree: pct(free),
    pctSlow: pct(slow),
    pctJam: pct(jam),
    thinCoverage: total < FLOW_COVERAGE_SOFT_MIN,
  };
}

/**
 * Human-readable coverage note when few flow segments matched near the pin.
 * @param {{total:number, thinCoverage:boolean}} summary
 * @returns {string|null}
 */
export function flowCoverageNote(summary) {
  if (!summary) return null;
  if (summary.total === 0) {
    return 'No TomTom flow segments matched within ~2 km of this pin.';
  }
  if (summary.thinCoverage) {
    return `Only ${summary.total} flow segment${summary.total === 1 ? '' : 's'} near this pin — treat % as thin coverage.`;
  }
  return null;
}

/**
 * Approximate reach radius (km) from a reachable-range boundary ring.
 * Uses median distance from origin to boundary vertices — not population.
 *
 * @param {{lat:number, lon:number}} origin
 * @param {Array<{latitude?:number, longitude?:number, lat?:number, lon?:number}>} boundary
 * @returns {{medianKm:number|null, maxKm:number|null, pointCount:number}}
 */
export function summarizeReachableBoundary(origin, boundary) {
  const empty = { medianKm: null, maxKm: null, pointCount: 0 };
  if (!origin || ![origin.lat, origin.lon].every(Number.isFinite)) return empty;
  if (!Array.isArray(boundary) || boundary.length === 0) return empty;

  const distances = [];
  for (const pt of boundary) {
    const lat = Number.isFinite(pt?.latitude) ? pt.latitude : pt?.lat;
    const lon = Number.isFinite(pt?.longitude) ? pt.longitude : pt?.lon;
    if (![lat, lon].every(Number.isFinite)) continue;
    distances.push(greatCircleKm(origin.lat, origin.lon, lat, lon));
  }
  if (distances.length === 0) return empty;
  distances.sort((a, b) => a - b);
  const mid = distances.length >> 1;
  const medianKm = distances.length % 2 === 1
    ? distances[mid]
    : (distances[mid - 1] + distances[mid]) / 2;
  return {
    medianKm,
    maxKm: distances[distances.length - 1],
    pointCount: distances.length,
  };
}

/**
 * Round a coordinate for cache keys (~110 m at equator for 3 decimals).
 * @param {number} value
 * @param {number} [decimals=3]
 * @returns {string}
 */
export function roundCoordKey(value, decimals = 3) {
  if (!Number.isFinite(value)) return 'nan';
  const f = 10 ** decimals;
  return String(Math.round(value * f) / f);
}

/**
 * Cache key for a reachable-range request.
 * @param {number} lat @param {number} lon @param {number} minutes
 * @returns {string}
 */
export function reachableCacheKey(lat, lon, minutes) {
  return `${roundCoordKey(lat)},${roundCoordKey(lon)},${minutes}`;
}

/**
 * Format km for the card (one decimal under 20 km, otherwise integer).
 * @param {number|null|undefined} km
 * @returns {string}
 */
export function formatKm(km) {
  if (!Number.isFinite(km)) return '—';
  if (km < 20) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/**
 * Destination point along a great-circle bearing (degrees → degrees).
 * Exported for sample-point drive-time fallbacks / tests.
 *
 * @param {number} lat @param {number} lon
 * @param {number} bearingDeg - 0 = north, clockwise
 * @param {number} distKm
 * @returns {{lat:number, lon:number}}
 */
export function destinationPointDeg(lat, lon, bearingDeg, distKm) {
  const delta = distKm / EARTH_RADIUS_KM;
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const brng = toRad(bearingDeg);
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(brng)
  );
  const l2 = l1 + Math.atan2(
    Math.sin(brng) * Math.sin(delta) * Math.cos(p1),
    Math.cos(delta) - Math.sin(p1) * Math.sin(p2)
  );
  const lonDeg = ((toDeg(l2) + 540) % 360) - 180;
  return { lat: toDeg(p2), lon: lonDeg };
}

/**
 * Four cardinal sample destinations at a fixed distance (isochrone-lite fallback).
 * @param {number} lat @param {number} lon @param {number} distKm
 * @returns {Array<{bearing:string, lat:number, lon:number}>}
 */
export function cardinalSamplePoints(lat, lon, distKm) {
  return [
    { bearing: 'N', ...destinationPointDeg(lat, lon, 0, distKm) },
    { bearing: 'E', ...destinationPointDeg(lat, lon, 90, distKm) },
    { bearing: 'S', ...destinationPointDeg(lat, lon, 180, distKm) },
    { bearing: 'W', ...destinationPointDeg(lat, lon, 270, distKm) },
  ];
}
