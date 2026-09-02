/**
 * Census / ward join for research briefs — optional public/sites/census-wards.geojson.
 * Never invents LSM, income, or Stats SA numbers.
 */
import {
  findContainingFeature,
  firstPropString,
  loadGeoJsonCollection,
} from './geojsonJoin.js';

export const CENSUS_WARDS_GEOJSON_URL = '/sites/census-wards.geojson';

/**
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
 * @returns {Promise<{
 *   status:'ok'|'miss'|'empty'|'missing'|'unavailable',
 *   wardCode:string|null,
 *   wardName:string|null,
 *   municipality:string|null,
 *   example:boolean,
 *   message:string,
 *   sourceNote?:string
 * }>}
 */
export async function loadSiteDemographics(latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    return {
      status: 'unavailable',
      wardCode: null,
      wardName: null,
      municipality: null,
      example: false,
      message: 'Pin has no coordinates — cannot join census wards.',
    };
  }

  const collection = await loadGeoJsonCollection(CENSUS_WARDS_GEOJSON_URL, { signal });
  if (collection.status === 'missing' || collection.status === 'empty') {
    return {
      status: 'missing',
      wardCode: null,
      wardName: null,
      municipality: null,
      example: false,
      message: 'Stats SA not wired — drop a ward/census GeoJSON at public/sites/census-wards.geojson to enable. No LSM or income is invented.',
    };
  }
  if (collection.status !== 'ok') {
    return {
      status: 'unavailable',
      wardCode: null,
      wardName: null,
      municipality: null,
      example: false,
      message: collection.message || 'Census GeoJSON unavailable.',
    };
  }

  const hit = findContainingFeature(collection.features, longitude, latitude);
  if (!hit) {
    return {
      status: 'miss',
      wardCode: null,
      wardName: null,
      municipality: null,
      example: false,
      message: 'No census/ward polygon at this pin (layer loaded). LSM / income stay unwired.',
    };
  }

  const props = hit.properties || {};
  const wardCode = firstPropString(props, [
    'ward_code', 'wardCode', 'WARD_ID', 'ward_id', 'code', 'PR_CODE',
  ]);
  const wardName = firstPropString(props, [
    'ward_name', 'wardName', 'WARD_NAME', 'name', 'Name', 'label',
  ]);
  const municipality = firstPropString(props, [
    'municipality', 'muni_name', 'MUNICNAME', 'local_municipality', 'district',
  ]);
  const example = props.example === true || props.example === 'true';

  if (!wardCode && !wardName && !municipality) {
    return {
      status: 'miss',
      wardCode: null,
      wardName: null,
      municipality: null,
      example,
      message: 'Census polygon has no ward/municipality properties. No LSM invented.',
      sourceNote: firstPropString(props, ['source_note', 'note']) || undefined,
    };
  }

  return {
    status: 'ok',
    wardCode,
    wardName,
    municipality,
    example,
    message: example
      ? 'Matched EXAMPLE ward polygon — replace with Stats SA / municipal wards. No LSM invented.'
      : 'Matched local census/ward GeoJSON. No LSM or income invented.',
    sourceNote: firstPropString(props, ['source_note', 'note']) || undefined,
  };
}
