/**
 * SA retail competitor *scraper* ingest — DEFERRED.
 *
 * Live competitor nearby results on the research brief use Google Places Nearby
 * (browser Maps key). Property Genius scrapers (Cashbuild / Woolworths / …) are
 * NOT ported (fragile, rate-limited, legally sensitive).
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
  note: 'Retail scrapers deferred — research card uses Places Nearby for live anchors.',
});

export function getCompetitorLayerStub() {
  return COMPETITOR_LAYER_STUB;
}
