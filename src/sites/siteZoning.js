/**
 * Zoning / SDF join for research briefs.
 *
 * 1) Optional local public/sites/zoning.geojson (gitignored live file).
 * 2) If missing/empty — location-aware municipal registry (George, Cape Town, …).
 *    Only the provider whose extent contains the pin is queried. Elsewhere:
 *    honest "No zoning data for this area yet" with no municipal label.
 * Never invents municipal codes or endpoints.
 */
import {
  findContainingFeature,
  firstPropString,
  loadGeoJsonCollection,
} from './geojsonJoin.js';
import {
  NO_ZONING_DATA_MESSAGE,
  noZoningDataResult,
  selectZoningProvider,
} from './zoningProviders.js';
import { loadZoningProviderBbox } from './zoningQuery.js';

export const ZONING_GEOJSON_URL = '/sites/zoning.geojson';

/**
 * @param {number} latitude
 * @param {number} longitude
 * @param {{signal?:AbortSignal}} [opts]
 * @returns {Promise<{
 *   status:'ok'|'miss'|'empty'|'missing'|'unavailable',
 *   zoneCode:string|null,
 *   zoneName:string|null,
 *   landUse?:string|null,
 *   town?:string|null,
 *   municipality?:string|null,
 *   example:boolean,
 *   source?:string,
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
  if (collection.status === 'ok') {
    const hit = findContainingFeature(collection.features, longitude, latitude);
    if (!hit) {
      return {
        status: 'miss',
        zoneCode: null,
        zoneName: null,
        example: false,
        source: 'local',
        message: 'No zoning feature at this pin (local layer loaded).',
      };
    }

    const props = hit.properties || {};
    const zoneCode = firstPropString(props, [
      'zoning_code', 'zone_code', 'zoneCode', 'ZONE_CODE', 'code', 'zoning', 'sdf_zone', 'ZONE',
      'INT_ZONE_CODE',
    ]);
    const zoneName = firstPropString(props, [
      'zoning', 'zone_name', 'zoneName', 'ZONE_NAME', 'name', 'Name', 'description', 'zone',
      'INT_ZONE_DESC',
    ]);
    const zoneNamePrefer = firstPropString(props, [
      'zone_name', 'zoneName', 'ZONE_NAME', 'name', 'Name', 'description', 'zone', 'zoning',
      'INT_ZONE_DESC',
    ]);
    const landUse = firstPropString(props, ['land_use', 'landUse', 'LAND_USE']);
    const town = firstPropString(props, ['town', 'Town', 'TOWN']);
    const municipality = firstPropString(props, [
      'municipality', 'muni_name', 'MUNICNAME', 'local_municipality',
    ]);
    const example = props.example === true || props.example === 'true';
    const resolvedName = zoneNamePrefer || zoneName;
    const resolvedCode = zoneCode && zoneCode !== resolvedName ? zoneCode : (
      firstPropString(props, [
        'zoning_code', 'zone_code', 'zoneCode', 'ZONE_CODE', 'code', 'sdf_zone', 'ZONE', 'INT_ZONE_CODE',
      ])
    );

    if (!resolvedCode && !resolvedName) {
      return {
        status: 'miss',
        zoneCode: null,
        zoneName: null,
        landUse,
        town,
        municipality,
        example,
        source: 'local',
        message: 'Zoning polygon has no name/code properties.',
        sourceNote: firstPropString(props, ['source_note', 'note']) || undefined,
      };
    }

    return {
      status: 'ok',
      zoneCode: resolvedCode,
      zoneName: resolvedName,
      landUse,
      town,
      municipality,
      example,
      source: 'local',
      message: example
        ? 'Matched EXAMPLE zoning polygon — replace with live municipal SDF.'
        : 'Matched local zoning GeoJSON.',
      sourceNote: firstPropString(props, ['source_note', 'note']) || undefined,
    };
  }

  // Missing or empty local file → location-aware municipal registry.
  if (collection.status === 'missing' || collection.status === 'empty') {
    const provider = selectZoningProvider(latitude, longitude);
    if (!provider) return noZoningDataResult();
    return loadZoningProviderBbox(provider, latitude, longitude, { signal });
  }

  return {
    status: 'unavailable',
    zoneCode: null,
    zoneName: null,
    example: false,
    message: collection.message || 'Zoning GeoJSON unavailable.',
  };
}

export { NO_ZONING_DATA_MESSAGE, selectZoningProvider };
