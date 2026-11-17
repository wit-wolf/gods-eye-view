/**
 * Location-aware municipal zoning provider registry.
 *
 * Each provider declares a WGS84 extent; only the matching municipality is
 * queried. Pins outside every extent return an honest "no zoning data" miss
 * with no George (or other) label.
 *
 * Endpoints and field names are verified against live ArcGIS REST services —
 * do not invent layers here.
 *
 * @module sites/zoningProviders
 */

import { findContainingFeature, firstPropString } from './geojsonJoin.js';

/** ~275 m half-width — matches Vite proxy envelopes. */
export const ZONING_HALF_DEG = 0.0025;
export const ZONING_RESULT_RECORD_COUNT = 25;

/**
 * @typedef {object} ZoningExtent
 * @property {number} west
 * @property {number} south
 * @property {number} east
 * @property {number} north
 */

/**
 * @typedef {object} ZoningProvider
 * @property {string} id
 * @property {string} municipality
 * @property {string} attribution
 * @property {ZoningExtent} extent WGS84 envelope derived from the layer extent.
 * @property {string} proxyUrl Same-origin Vite proxy path.
 * @property {string} featureServer Upstream ArcGIS query URL.
 * @property {string} outFields Comma-separated ArcGIS outFields.
 * @property {{zoneCode:string[], zoneName:string[], landUse?:string[], town?:string[]}} fields
 */

/**
 * George Municipality Integrated Zoning (CITP FeatureServer/16).
 * Extent converted from layer Web Mercator bbox (verified via FeatureServer).
 */
export const GEORGE_ZONING_PROVIDER = Object.freeze({
  id: 'george',
  municipality: 'George Municipality',
  attribution: 'George Municipality Integrated Zoning (CITP)',
  extent: Object.freeze({
    west: 22.1935,
    south: -34.0615,
    east: 23.6750,
    north: -33.3861,
  }),
  proxyUrl: '/api/george-zoning',
  featureServer:
    'https://gis.george.gov.za/server/rest/services/Hosted/CITP/FeatureServer/16/query',
  outFields: 'zoning,zoning_code,land_use,town',
  fields: Object.freeze({
    zoneCode: Object.freeze(['zoning_code', 'zone_code', 'ZONE_CODE', 'code']),
    zoneName: Object.freeze(['zoning', 'zone_name', 'zoneName', 'ZONE_NAME', 'name']),
    landUse: Object.freeze(['land_use', 'landUse', 'LAND_USE']),
    town: Object.freeze(['town', 'Town', 'TOWN']),
  }),
});

/**
 * City of Cape Town Integrated Zoning
 * (Theme_Based/ODP_SPLIT_5 FeatureServer/0 — verified live query 2026-11).
 * Fields: INT_ZONE_CODE, INT_ZONE_DESC.
 */
export const CAPE_TOWN_ZONING_PROVIDER = Object.freeze({
  id: 'cape-town',
  municipality: 'City of Cape Town',
  attribution: 'City of Cape Town Integrated Zoning (ODP)',
  extent: Object.freeze({
    west: 18.3048,
    south: -34.3602,
    east: 19.0048,
    north: -33.4706,
  }),
  proxyUrl: '/api/cape-town-zoning',
  featureServer:
    'https://citymaps.capetown.gov.za/agsext/rest/services/Theme_Based/ODP_SPLIT_5/FeatureServer/0/query',
  outFields: 'INT_ZONE_CODE,INT_ZONE_DESC',
  fields: Object.freeze({
    zoneCode: Object.freeze(['INT_ZONE_CODE', 'int_zone_code']),
    zoneName: Object.freeze(['INT_ZONE_DESC', 'int_zone_desc']),
    landUse: Object.freeze([]),
    town: Object.freeze([]),
  }),
});

/** Ordered registry — first matching extent wins. */
export const ZONING_PROVIDERS = Object.freeze([
  GEORGE_ZONING_PROVIDER,
  CAPE_TOWN_ZONING_PROVIDER,
]);

export const NO_ZONING_DATA_MESSAGE = 'No zoning data for this area yet';

/**
 * @param {number} latitude
 * @param {number} longitude
 * @param {ZoningExtent} extent
 * @returns {boolean}
 */
export function pointInZoningExtent(latitude, longitude, extent) {
  if (!extent || ![latitude, longitude].every(Number.isFinite)) return false;
  return longitude >= extent.west
    && longitude <= extent.east
    && latitude >= extent.south
    && latitude <= extent.north;
}

/**
 * Select the municipal zoning provider for a pin, or null when outside every
 * registered extent.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @param {readonly ZoningProvider[]} [providers]
 * @returns {ZoningProvider|null}
 */
export function selectZoningProvider(
  latitude,
  longitude,
  providers = ZONING_PROVIDERS,
) {
  if (![latitude, longitude].every(Number.isFinite)) return null;
  for (const provider of providers) {
    if (pointInZoningExtent(latitude, longitude, provider.extent)) return provider;
  }
  return null;
}

/**
 * @param {ZoningProvider} provider
 * @param {number} latitude
 * @param {number} longitude
 * @returns {string}
 */
export function buildZoningQueryUrl(provider, latitude, longitude) {
  const geometry = JSON.stringify({
    xmin: longitude - ZONING_HALF_DEG,
    ymin: latitude - ZONING_HALF_DEG,
    xmax: longitude + ZONING_HALF_DEG,
    ymax: latitude + ZONING_HALF_DEG,
  });
  const qs = new URLSearchParams({
    geometry,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: provider.outFields,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: String(ZONING_RESULT_RECORD_COUNT),
  });
  return `${provider.featureServer}?${qs}`;
}

/**
 * @param {ZoningProvider} provider
 * @param {object} props
 */
export function readZoningProps(provider, props) {
  const p = props && typeof props === 'object' ? props : {};
  const fields = provider.fields || {};
  return {
    zoneCode: firstPropString(p, fields.zoneCode || []),
    zoneName: firstPropString(p, fields.zoneName || []),
    landUse: firstPropString(p, fields.landUse || []),
    town: firstPropString(p, fields.town || []),
  };
}

/**
 * @param {ZoningProvider} provider
 * @param {object} collection
 * @param {number} longitude
 * @param {number} latitude
 */
export function matchZoningCollection(provider, collection, longitude, latitude) {
  const features = Array.isArray(collection?.features) ? collection.features : [];
  if (!features.length) {
    return {
      status: 'miss',
      zoneCode: null,
      zoneName: null,
      landUse: null,
      town: null,
      municipality: provider.municipality,
      example: false,
      source: provider.id,
      message: `${provider.municipality} zoning bbox returned no polygons near this pin.`,
      sourceNote: provider.attribution,
    };
  }
  const hit = findContainingFeature(features, longitude, latitude) || features[0];
  const mapped = readZoningProps(provider, hit?.properties);
  if (!mapped.zoneCode && !mapped.zoneName) {
    return {
      status: 'miss',
      ...mapped,
      municipality: provider.municipality,
      example: false,
      source: provider.id,
      message: `${provider.municipality} zoning feature has no zone code / name fields.`,
      sourceNote: provider.attribution,
    };
  }
  return {
    status: 'ok',
    ...mapped,
    municipality: provider.municipality,
    example: false,
    source: provider.id,
    message: `Matched ${provider.municipality} zoning (bbox query — not a national layer).`,
    sourceNote: provider.attribution,
  };
}

/**
 * Honest empty state when the pin is outside every registered municipality.
 * @returns {object}
 */
export function noZoningDataResult() {
  return {
    status: 'miss',
    zoneCode: null,
    zoneName: null,
    landUse: null,
    town: null,
    municipality: null,
    example: false,
    source: 'none',
    message: NO_ZONING_DATA_MESSAGE,
  };
}
