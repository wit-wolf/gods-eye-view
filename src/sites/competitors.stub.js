/**
 * SA retail competitor *scraper* ingest — DEFERRED.
 *
 * Live retail-context results on the research brief prefer TomTom Places
 * Search (server TOMTOM_API_KEY via /api/tomtom/nearby-poi profiles:
 * centres + stores), splitting in-centre tenants from competing malls. Google
 * Places Nearby is a labeled fallback when the Maps key works. Property Genius
 * scrapers (Cashbuild / Woolworths / …) are NOT ported (fragile, rate-limited,
 * legally sensitive).
 */
export const COMPETITOR_LAYER_STUB = Object.freeze({
  id: 'sites-competitors',
  status: 'deferred',
  brands: Object.freeze([
    'Cashbuild',
    'Woolworths',
    'Pick n Pay',
    'Checkers',
    'Builders Warehouse',
  ]),
  note: 'Retail scrapers deferred — Ancora GeoJSON + TomTom Places retail context (Google fallback).',
});

export function getCompetitorLayerStub() {
  return COMPETITOR_LAYER_STUB;
}
