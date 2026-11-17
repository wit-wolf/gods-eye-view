/**
 * Convert TomTom traffic-flow MVT segments into the road polyline shape used
 * by the Street Traffic dot / heat-line pipeline.
 *
 * When a TomTom key is present these segments are the primary road geometry
 * (Overpass is only a keyless / TomTom-down fallback). Each segment already
 * carries congestion (`trafficLevel`) and closure flags, so no flowMatch pass
 * is required.
 *
 * @module data/tomtomRoads
 */

/** @const {number} Max vertices kept per TomTom flow polyline. */
const MAX_WAYPOINTS_PER_ROAD = 48;

/**
 * Map TomTom `road_type` labels onto OSM-like highway classes used by
 * SPEED_MPS / DENSITY_MULT / SIZE_BY_TYPE in traffic.js.
 *
 * Labels verified against live relative-flow tiles (Austin fixture + TomTom
 * docs / community dumps): Motorway, Major road, Secondary road,
 * Major local road, Connecting road.
 *
 * @param {string} roadType
 * @returns {string}
 */
export function mapTomTomRoadType(roadType) {
  const raw = typeof roadType === 'string' ? roadType.trim().toLowerCase() : '';
  if (!raw) return 'unclassified';
  if (raw === 'motorway' || raw.includes('motorway')) return 'motorway';
  if (raw === 'major road' || raw === 'trunk') return 'trunk';
  if (raw === 'secondary road' || raw === 'secondary') return 'secondary';
  if (raw === 'major local road' || raw === 'primary') return 'primary';
  if (raw === 'connecting road' || raw === 'local road' || raw === 'street') return 'residential';
  if (raw === 'tertiary') return 'tertiary';
  return 'unclassified';
}

/**
 * Sub-sample a lon/lat polyline to at most `maxPoints` vertices, always
 * keeping the original endpoints.
 *
 * @param {number[][]} rawCoords
 * @param {number} [maxPoints=MAX_WAYPOINTS_PER_ROAD]
 * @returns {number[][]}
 */
export function simplifyRoadCoords(rawCoords, maxPoints = MAX_WAYPOINTS_PER_ROAD) {
  if (!Array.isArray(rawCoords) || rawCoords.length < 2) return [];
  const simplifyStep = rawCoords.length > maxPoints
    ? Math.ceil(rawCoords.length / maxPoints)
    : 1;
  const coords = [];
  for (let i = 0; i < rawCoords.length; i += simplifyStep) {
    coords.push(rawCoords[i]);
  }
  const last = rawCoords[rawCoords.length - 1];
  const tail = coords[coords.length - 1];
  if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) {
    coords.push(last);
  }
  return coords.length >= 2 ? coords : [];
}

/**
 * Turn decoded TomTom flow segments into road specs for the traffic layer.
 *
 * Output shape matches Overpass `parseRoads` fields the renderer needs, plus
 * an attached `flow` so live coloring works without flowMatch:
 * `{ coords, type, oneway, flow: { level, closure }, source: 'tomtom' }`.
 *
 * Closed segments are kept (renderer spawns zero dots but counts closures).
 * Pure / Cesium-free for unit tests.
 *
 * @param {Array<{coords:number[][], trafficLevel:number, roadType?:string, closure?:boolean}>} segments
 * @returns {Array<{coords:number[][], type:string, oneway:number, flow:{level:number,closure:boolean}, source:string}>}
 */
export function flowSegmentsToRoadSpecs(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const roads = [];
  for (const seg of segments) {
    const coords = simplifyRoadCoords(seg?.coords);
    if (coords.length < 2) continue;
    const closure = seg.closure === true;
    const level = Number.isFinite(seg.trafficLevel)
      ? Math.min(1, Math.max(0, seg.trafficLevel))
      : (closure ? 0 : null);
    if (level == null && !closure) continue;
    roads.push({
      coords,
      type: mapTomTomRoadType(seg.roadType),
      // Flow polylines are oriented with travel; treat as one-way digitization.
      oneway: 1,
      flow: { level: level ?? 0, closure },
      source: 'tomtom',
    });
  }
  return roads;
}
