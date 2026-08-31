/**
 * SA retail competitor ingest — DEFERRED.
 *
 * Property Genius scraped / ingested Cashbuild, Woolworths, Pick n Pay, and
 * related SA retail footprints as competitor layers. Those scrapers are NOT
 * ported in this PR (fragile, rate-limited, legally sensitive).
 *
 * Later work can register a live or curated competitor GeoJSON layer here and
 * expose it beside Sites without touching the KMZ import path.
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
  note: 'Retail competitor ingest is deferred. Do not port Property Genius scrapers here.',
});

export function getCompetitorLayerStub() {
  return COMPETITOR_LAYER_STUB;
}
