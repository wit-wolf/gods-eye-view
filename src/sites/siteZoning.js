/**
 * Zoning / SDF join for research briefs — optional public/sites/zoning.geojson.
 * Never invents municipal codes.
 */
import {
  findContainingFeature,
  firstPropString,
  loadGeoJsonCollection,
} from './geojsonJoin.js';

export const ZONING_GEOJSON_URL = '/sites/zoning.geojson';

/**
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
 * @returns {Promise<{
 *   status:'ok'|'miss'|'empty'|'missing'|'unavailable',
 *   zoneCode:string|null,
 *   zoneName:string|null,
 *   example:boolean,
 *   message:string,
 *   sourceNote?:string
 * }>}
 */
export async function loadSiteZoning(latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    return {
      status: 'unavailable',
      zoneCode: null,
      zoneName: null,
      example: false,
      message: 'Pin has no coordinates — cannot join zoning.',
    };
  }

  const collection = await loadGeoJsonCollection(ZONING_GEOJSON_URL, { signal });
  if (collection.status === 'missing' || collection.status === 'empty') {
    return {
      status: 'missing',
      zoneCode: null,
      zoneName: null,
      example: false,
      message: 'No zoning layer loaded — drop a municipal SDF GeoJSON at public/sites/zoning.geojson.',
    };
  }
  if (collection.status !== 'ok') {
    return {
      status: 'unavailable',
      zoneCode: null,
      zoneName: null,
      example: false,
      message: collection.message || 'Zoning GeoJSON unavailable.',
    };
  }

  const hit = findContainingFeature(collection.features, longitude, latitude);
  if (!hit) {
    return {
      status: 'miss',
      zoneCode: null,
      zoneName: null,
      example: false,
      message: 'No zoning feature at this pin (layer loaded).',
    };
  }

  const props = hit.properties || {};
  const zoneCode = firstPropString(props, [
    'zone_code', 'zoneCode', 'ZONE_CODE', 'code', 'zoning', 'sdf_zone', 'ZONE',
  ]);
  const zoneName = firstPropString(props, [
    'zone_name', 'zoneName', 'ZONE_NAME', 'name', 'Name', 'description', 'zone',
  ]);
  const example = props.example === true || props.example === 'true';
  if (!zoneCode && !zoneName) {
    return {
      status: 'miss',
      zoneCode: null,
      zoneName: null,
      example,
      message: 'Zoning polygon has no name/code properties.',
      sourceNote: firstPropString(props, ['source_note', 'note']) || undefined,
    };
  }

  return {
    status: 'ok',
    zoneCode,
    zoneName,
    example,
    message: example
      ? 'Matched EXAMPLE zoning polygon — replace with live municipal SDF.'
      : 'Matched local zoning GeoJSON.',
    sourceNote: firstPropString(props, ['source_note', 'note']) || undefined,
  };
}
