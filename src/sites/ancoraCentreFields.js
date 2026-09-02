/**
 * Ancora centre property display helpers — unit-count occupancy only.
 * Never invent tenants or occupancy when units are missing.
 */

/**
 * @param {object} props
 * @returns {{
 *   units:number|null,
 *   occupied:number|null,
 *   vacant:number|null,
 *   occupancyPct:number|null
 * }}
 */
export function ancoraOccupancyFromUnits(props) {
  const p = props && typeof props === 'object' ? props : {};
  const unitsRaw = p.units ?? p.units_total ?? p.unit_count;
  const occupiedRaw = p.units_occupied ?? p.occupied_units;
  const vacantRaw = p.units_vacant ?? p.vacant_units;

  const units = Number(unitsRaw);
  const occupied = Number(occupiedRaw);
  const vacantDirect = Number(vacantRaw);

  const unitsOk = Number.isFinite(units) && units > 0;
  const occupiedOk = Number.isFinite(occupied) && occupied >= 0;
  const vacantOk = Number.isFinite(vacantDirect) && vacantDirect >= 0;

  let vacant = vacantOk ? vacantDirect : null;
  if (vacant == null && unitsOk && occupiedOk) {
    vacant = Math.max(0, units - occupied);
  }

  let occupancyPct = null;
  if (unitsOk && occupiedOk) {
    occupancyPct = Math.round((100 * occupied) / units);
  } else {
    const direct = Number(p.occupancy_pct ?? p.occupancy);
    if (Number.isFinite(direct) && direct >= 0 && direct <= 100) {
      occupancyPct = Math.round(direct);
    }
  }

  return {
    units: unitsOk ? units : null,
    occupied: occupiedOk ? occupied : null,
    vacant,
    occupancyPct,
  };
}

/**
 * True when a Google Places geocode was used (coords not surveyed on site).
 * @param {object} props
 */
export function ancoraWasGeocoded(props) {
  const p = props && typeof props === 'object' ? props : {};
  if (p.geocoded === true || p.geocoded === 'true') return true;
  if (typeof p.geocoded_name === 'string' && p.geocoded_name.trim()) return true;
  if (typeof p.geocoded_address === 'string' && p.geocoded_address.trim()) return true;
  return false;
}

/** Known Places Text Search collisions (ZA dump 2026-09-02) — display only. */
export const ANCORA_GEOCODE_CAVEATS = Object.freeze([
  'Whitelands Junction and Wijnland Junction both resolved to Wijnland Junction, Eerste River (same coordinates).',
  'Build It Tembisa and Marula Mile both resolved to Marula Square, Lephalale.',
  'Heron Banks_Vaalpark resolved to Heron Banks Golf Course.',
  'Bram Fischerville Square resolved to Bram Fischer Multi-Purpose Centre.',
]);
