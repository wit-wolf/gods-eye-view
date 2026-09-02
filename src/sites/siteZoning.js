/**
 * Zoning / SDF join for research briefs.
 *
 * 1) Optional local public/sites/zoning.geojson (gitignored live file).
 * 2) If missing/empty — George Municipality Integrated Zoning bbox overlay
 *    (FeatureServer/16 envelope around the pin; never the full ~54k layer).
 * Never invents municipal codes.
 */
import {
  findContainingFeature,
  firstPropString,
  loadGeoJsonCollection,
} from './geojsonJoin.js';
import { loadGeorgeZoningBbox } from './georgeZoning.js';

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
 *   source?:'local'|'george',
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
    ]);
    const zoneName = firstPropString(props, [
      'zoning', 'zone_name', 'zoneName', 'ZONE_NAME', 'name', 'Name', 'description', 'zone',
    ]);
    // Prefer dedicated name when both zoning (label) and zoning_code exist.
    const zoneNamePrefer = firstPropString(props, [
      'zone_name', 'zoneName', 'ZONE_NAME', 'name', 'Name', 'description', 'zone', 'zoning',
    ]);
    const landUse = firstPropString(props, ['land_use', 'landUse', 'LAND_USE']);
    const town = firstPropString(props, ['town', 'Town', 'TOWN']);
    const municipality = firstPropString(props, [
      'municipality', 'muni_name', 'MUNICNAME', 'local_municipality',
    ]);
    const example = props.example === true || props.example === 'true';
    const resolvedName = zoneNamePrefer || zoneName;
    const resolvedCode = zoneCode && zoneCode !== resolvedName ? zoneCode : (
      firstPropString(props, ['zoning_code', 'zone_code', 'zoneCode', 'ZONE_CODE', 'code', 'sdf_zone', 'ZONE'])
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

  // Missing or empty local file → optional George bbox overlay.
  if (collection.status === 'missing' || collection.status === 'empty') {
    return loadGeorgeZoningBbox(latitude, longitude, { signal });
  }

  return {
    status: 'unavailable',
    zoneCode: null,
    zoneName: null,
    example: false,
    message: collection.message || 'Zoning GeoJSON unavailable.',
  };
}
