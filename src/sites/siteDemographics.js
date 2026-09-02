/**
 * Census / ward join for research briefs — optional public/sites/census-wards.geojson.
 *
 * Census 2022 small-area (SAL) is request-only; income/employment 2022 withheld.
 * Never invents LSM, income, or Stats SA numbers. Optional join on ward / SAL_CODE
 * when a 2011 SAL/ward GeoJSON (+ SuperWEB2 CSV attributes) is dropped locally.
 */
import {
  findContainingFeature,
  firstPropString,
  loadGeoJsonCollection,
} from './geojsonJoin.js';

export const CENSUS_WARDS_GEOJSON_URL = '/sites/census-wards.geojson';

export const CENSUS_2022_NOT_PUBLIC_MESSAGE =
  'Census 2022 small-area not public; drop 2011 SAL/ward GeoJSON + SuperWEB2 CSV to enable.';

/**
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
 * @returns {Promise<{
 *   status:'ok'|'miss'|'empty'|'missing'|'unavailable',
 *   wardCode:string|null,
 *   wardName:string|null,
 *   municipality:string|null,
 *   salCode:string|null,
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
      salCode: null,
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
      salCode: null,
      example: false,
      message: CENSUS_2022_NOT_PUBLIC_MESSAGE,
    };
  }
  if (collection.status !== 'ok') {
    return {
      status: 'unavailable',
      wardCode: null,
      wardName: null,
      municipality: null,
      salCode: null,
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
      salCode: null,
      example: false,
      message:
        'No census/ward/SAL polygon at this pin (layer loaded). '
        + 'Census 2022 small-area not public; no LSM/income invented.',
    };
  }

  const props = hit.properties || {};
  const salCode = firstPropString(props, [
    'SAL_CODE', 'sal_code', 'salCode', 'SALCODE', 'sal',
  ]);
  const wardCode = firstPropString(props, [
    'ward_code', 'wardCode', 'WARD_ID', 'ward_id', 'WARD_NO', 'code', 'PR_CODE',
  ]) || salCode;
  const wardName = firstPropString(props, [
    'ward_name', 'wardName', 'WARD_NAME', 'name', 'Name', 'label', 'SAL_NAME', 'sal_name',
  ]);
  const municipality = firstPropString(props, [
    'municipality', 'muni_name', 'MUNICNAME', 'local_municipality', 'district',
  ]);
  const example = props.example === true || props.example === 'true';

  if (!wardCode && !wardName && !municipality && !salCode) {
    return {
      status: 'miss',
      wardCode: null,
      wardName: null,
      municipality: null,
      salCode: null,
      example,
      message: 'Census polygon has no ward/SAL/municipality properties. No LSM invented.',
      sourceNote: firstPropString(props, ['source_note', 'note']) || undefined,
    };
  }

  return {
    status: 'ok',
    wardCode,
    wardName,
    municipality,
    salCode,
    example,
    message: example
      ? 'Matched EXAMPLE ward/SAL polygon — replace with 2011 SAL/ward + SuperWEB2 CSV. No LSM invented.'
      : 'Matched local 2011 SAL/ward GeoJSON (optional SuperWEB2 join). No LSM or income invented.',
    sourceNote: firstPropString(props, ['source_note', 'note']) || undefined,
  };
}
