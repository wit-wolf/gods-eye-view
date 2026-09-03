# Changelog

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [Unreleased] — 2026-09-03

### Fixed

- **Live Street Traffic visible on the property globe:** TomTom flow heat-lines
  no longer classify only onto Photorealistic 3D tiles. With 3D buildings off
  (the Volo default) they drape the globe/terrain on Satellite, Streets, and
  Satellite + labels, and reclassify onto 3D tiles when buildings are turned
  on. Default jamViz is `both` (congestion-colored road overlay + dots),
  including free-flow green corridors so live traffic reads as roads on the
  map—not density specks alone. Simulated / keyless labeling unchanged.

### Changed

- **Property Data Layers only:** cut Earthquakes, FIRMS / Active fires, Dams,
  submarine cables, and local datacenters from `VOLEE_ENABLED_LAYER_IDS` so they
  no longer appear in Data Layers or start feeds. Kept: Sites, Ancora, Area
  News, Street Traffic. Existing OSINT cut (aircraft/ships/sats/CCTV/voice/radio)
  unchanged.
- **Scenes** panel / Scene Director tray hidden on the Volo product surface
  (`features.scenes: false`). Sites **IMPORT** (KMZ) remains.
- First-run copy no longer mentions fires; Environmental mission tile stays in
  markup but is hidden.
- **Map style** widget (left rail): Satellite (Google 2D Map Tiles via existing
  `GOOGLE_MAPS_API_KEY`), Streets (OSM), Satellite + labels (Google hybrid),
  3D buildings (Photorealistic tiles, off by default), Bing Aerial/Labels when
  `CESIUM_ION_TOKEN` is present (honest unavailable otherwise). Cold start
  prefers Google Satellite 2D, else Streets — never 3D by default.

## [Unreleased] — 2026-09-02

### Changed

- Zoning / census sources (verified 2026-09-02): **no national zoning GeoJSON**.
  Live `public/sites/zoning.geojson` and `census-wards.geojson` are **gitignored**
  (committed templates: `zoning.example.geojson`, `census-wards.example.geojson`).
  When local zoning is missing, research cards optionally bbox-query **George
  Municipality Integrated Zoning** (CITP FeatureServer/16) via
  `/api/george-zoning?lat=&lon=` — pin envelope + small `resultRecordCount`,
  never the full ~54k layer. Attributes George Municipality; honest fail on
  CORS/network → drop a GeoJSON extract. Demographics card states **Census 2022
  small-area not public**; optional join on ward/`SAL_CODE` when a 2011
  SAL/ward GeoJSON (+ SuperWEB2 CSV) is dropped locally — no invented LSM/
  income. `DATA_SOURCES.md` lists George GIS, Cape Town Open Data zoning REST,
  Joburg paid extract, Stats SA SuperWEB2, WCG Spatial Data Warehouse; does
  **not** cite wazimap.co.za (404). Ancora live dump remains gitignored.

## [Unreleased] — 2026-09-01

### Added

- **Ancora** Data Layers entry (amber centres, separate from Sites KMZ): loads
  local `public/sites/ancora-centres.geojson` when present — **gitignored** so
  live PropertyCentral occupancy never ships to GitHub. Committed template
  `ancora-centres.example.geojson` (EXAMPLE centres). Research brief shows GLA,
  units occupied/vacant, mandate_status, geocoded name/address with a
  “geocoded (not surveyed)” note; occupancy % from unit counts only. Lists
  known Places Text Search collisions from the 2026-09-02 dump.
- Optional **zoning** and **census/ward** GeoJSON joins on Sites and Ancora
  research cards (`public/sites/zoning.geojson`, `census-wards.geojson`, plus
  `.example` templates). Hit → real properties only; miss/empty → honest copy.
  No invented LSM, income, or municipal codes. No AfriGIS required.
- Sites **PIN** (drop-pin) mode: toggle place mode, click empty globe to create a
  persistent “Dropped pins” Sites point, open the research brief, Esc/CANCEL to
  exit. Reverse-geocode locality prefers **TomTom Search** (`/api/tomtom/reverse-geocode`,
  server `TOMTOM_API_KEY`); Nominatim via regional brief is the labeled fallback.
  Competitor retail ring prefers **TomTom Places nearby** (`/api/tomtom/nearby-poi`,
  shopping/market/shop/department categories) with Google Places Nearby as
  fallback when the Maps key allows. Demographics / zoning use optional local
  GeoJSON joins (above); PropertyCentral stays stubbed on Sites. Evaluation
  search quota shares `TOMTOM_DAILY_ROUTE_BUDGET` with drive-time — over limit
  degrades honestly (stale cache or fallback / message).
  Research brief includes **Delete pin** (confirm) to remove one entity from the
  globe and IndexedDB layer without RESET; Delete key when the card is open.
  IMPORT chip tip: faster after first load (IndexedDB cache).
- **Area News** Data Layers toggle (off by default): Sites-style widget with
  retail-then-business headlines for the focused camera area (selected Sites
  pin when open). Reuses `/api/regional-brief?mode=area-news` (Nominatim +
  Google News RSS / GDELT fallback, ZA locale when in South Africa). Honest
  empty/unavailable states — no invented articles.
- Sites research brief **Access / traffic** section: live TomTom flow summary
  near the pin (% free / slow / jam, closures, thin-coverage note) from the
  existing flow-tile pipeline, labeled as a **current snapshot** (~2 min tile
  cache) — not peak-hour historic. Keyless / unavailable shows the same honest
  simulated state as the traffic layer (no invented live %).
- Free-tier **drive-time catchment** (5 / 10 / 15 min) via TomTom
  `calculateReachableRange` on same-origin `/api/tomtom/reachable-range`
  (key server-side, 6 h cache, separate daily route budget). Distances only —
  no invented demographics inside the rings.
- Explicit **not wired yet** stubs on the research card for demographics /
  LSM, zoning / SDF, PropertyCentral, and competitor density.

### Changed

- **Sites performance (SA overview):** cluster density scales with camera height —
  country/province views use a much larger `pixelRange` and `minimumClusterSize`
  so DEMO shows cluster bubbles instead of thousands of individual pins.
  Clustering is paused during bulk paint, then rebuilt once. DEMO streams the
  remainder in gentler idle batches, near-camera first. MSAA default lowered
  to 2×; bloom stays off. DISPLAY gains a **Fast** preset (bloom/sharpen off,
  3D tiles off, stronger clustering, smaller paint batches, 30 fps cap).
- Sites **cluster counts** render as circular teal bubbles (count centered on a
  dark disc with Sites outline) instead of bare white numerals; size tiers by
  count. Zoom-in still de-clusters to single teal pins.
- Product lockup renamed to **Volo by Volee** (was Eagle Eye by Volee).
  `PRODUCT_BRANDING` drives document title, title bar, first-run, HUD, README.
  Repo slug stays `gods-eye-view`.
- Scope / scope-mask defaults **OFF** for cold start and globe reset (toggle
  remains in DISPLAY; share links with `sc=1` still restore ON).
- Opening a Sites research brief auto-collapses DISPLAY and positions the card
  clear of the right-rail strip so property details stay readable.
- **Google Photorealistic 3D Tiles default OFF** (OSM imagery cold start /
  reset). DISPLAY has a clear **3D tiles** toggle; MAP SOURCE chips still
  switch Google 3D / Bing / OSM. Share links with `map=photoreal` still restore
  tiles ON.
- Cold-start Cape Town home uses the city **overview** frame (high above the
  bowl / Table Mountain), not the close landmark range.
- Data Layers titles keyless traffic as **Traffic (simulated)** until a
  `TOMTOM_API_KEY` is confirmed (then **Street Traffic**). Meta/chip already
  said SIMULATED; the row name now matches.
- **Bloom** (DISPLAY): soft cinematic glow post-process — optional, GPU cost.
  Tooltip documents it; control unchanged.

### Added

- Absorbed Property Genius into this fork as the **Sites** data layer: KMZ/KML
  import, Cesium globe rendering, a clickable **research brief** (KML fields +
  nearby imported pins + notes — no Genius composite scores), local
  persistence, and the November Google Earth Pins demo. The MapLibre Property
  Genius app is no longer required to view those pins. Zoning UI, retail
  scrapers, PropertyCentral, and Azure persistence remain deferred.
- **Volee product profile** (`src/productProfile.js`): property-globe surface
  that registers only Sites, traffic, FIRMS fires, earthquakes, and local
  infrastructure layers. Aircraft, AIS, satellites, CCTV, radio, and voice stay
  in-tree but do not register, start, or appear in the HUD.

### Changed

- Product chrome on this fork is branded **Volo by Volee** (window title,
  header, first-run / property globe launcher, loading screen, README). The
  GitHub repository name stays `wit-wolf/gods-eye-view`. Sites/KMZ import is
  progressive and cancellable so large demos no longer freeze the tab.
  Duplicate Cesium entity ids (preview→full stream / double DEMO) are skipped
  instead of marking the layer UNAVAILABLE.
- First-run missions are **Sites**, **Environmental** (quakes + FIRMS), and
  **Explore**. Spy chrome (TOP SECRET banners, MIC tip, Detection, CRT/NVG/
  FLIR/Noir/Snow) is hidden on the property profile; weather/fire presentation
  remains via kept layers.
- Location search is restricted to **South Africa** via browser Places API
  (New) Text Search / Autocomplete / Place Details (`regionCode` /
  `includedRegionCodes: za`) using the same referrer-restricted
  `GOOGLE_MAPS_API_KEY` as Photorealistic 3D Tiles — not the Node geocode
  proxy (referrer keys are denied server-side). “George” flies to Western
  Cape. Missing key / Google denial surfaces an honest toast.

## [Unreleased] — 2026-08-24

### Added

- Added honest aircraft identity narration: callsign, operator, registration,
  type, and route come only from selected-contact context, and missing operator,
  route, or type enrichment is named explicitly.
- Added local, publication-compatible copies of the two README PNGs, with source
  records and third-party-license boundaries in `docs/media/README.md`.
- Added regression coverage for aircraft identity narration and optional-key
  loading feedback.

### Changed

- First-run presentation now opens with Detection `DENSE` at 75%, `ELASTIC`
  allocation, Fade 7%, Outside 1%, scope feather 11%, and aircraft 3D models in
  `PROXIMITY`. Stored state and share links still override these baselines.
- The 17 selected README GIFs remain unchanged and are documented separately
  from the two owner-published PNGs.
- Bundled datacenter and dam snapshots now omit contact-oriented fields and
  note values containing email or phone identifiers. Feature geometry, names,
  operator/capacity/river metadata, counts, and ODbL terms are unchanged.
- Public documentation and the L9 release matrix no longer reference non-public
  planning material or repository history.

### Fixed

- A missing optional FIRMS key no longer turns the complete Environmental
  mission into `LOAD FAILED`. The FIRMS row still reports `KEY REQUIRED`, while
  earthquakes continue to load. Real lifecycle and fetch failures retain
  failure priority.
- The mapped-installations layer retries after an unavailable request when it is
  enabled or the camera settles.
- Aircraft trails attach to the rendered aircraft transform and remain near the
  rear center across headings. Parked aircraft do not draw a moving head
  segment.
- Grounded aircraft keep validated floor evidence through temporary terrain
  outages and wait for measured photoreal-surface evidence before a 3D model
  takes over from its billboard.
- Cockpit altitude uses aviation MSL data rather than Cesium render height.

### Security

- Production transitive dependencies resolve to patched DOMPurify and
  protobufjs releases without changing the Cesium version or application APIs.
- Production dependency audit reports no known advisories; remaining audit
  findings are confined to development and QA tooling.

## [Unreleased] — 2026-08-23

### Added

- Added a first-run mission launcher for Contacts, Space Missions,
  Environmental, and manual exploration.
- Added terrain-validity gating and bounded last-known placement for grounded
  aircraft models.

### Changed

- Environmental consistently presents both earthquakes and NASA FIRMS fires,
  with honest optional-key degradation.
- The tracked aircraft trail acceptance bar is visual: roughly rear-center,
  stable across headings, with minor hull overlap allowed and no conspicuous
  top, bottom, or lateral projection.

## [Unreleased] — 2026-08-18 to 2026-08-22

### Added

- Added the four-source Map Source tray, share-link v2 state, cockpit/context
  voice parity, MSL altitude readouts, and close-range tracked aircraft models.
- Added the L9 release-candidate matrix, AIS feed watchdog, voice cost controls,
  satellite classes, and the shared world-overlay host.
- Added deterministic first-run, map-source, floor, overlay, tracking, and
  aircraft-model regression harnesses.

### Changed

- Consolidated world labels, cards, tracked readouts, CCTV thumbnails, cable
  labels, mission labels, and detection presentation under shared allocation and
  lifecycle rules.
- Reduced idle rendering through the render governor and explicit scope mask.
- Improved cockpit layout, context restoration, keyless feed honesty, and
  aircraft 2D/3D handoffs.

### Fixed

- Fixed degenerate depth picks, map-source restore states, route-camera motion,
  bright-ground label readability, grounded display flooring, and cross-layer
  tracking cleanup.
- Fixed stale overlay callbacks, parked-idle render leaks, cable-label sweep
  starvation, and several share-link state conflicts.

## [Unreleased] — 2026-08-02 to 2026-08-16

### Added

- Added Global Context modes, Cockpit briefing surfaces, Radio context,
  satellite mission replay, and real per-class aircraft models with adjacent
  provenance records.
- Added a shared screen-space overlay system with bounded allocation for labels,
  cards, callouts, detection brackets, and selected-object presentation.

### Changed

- Unified right-side product controls and responsive cockpit/map layouts.
- Migrated public-safe neighborhood geometry to DataSF and tightened safe local
  development defaults.
- Improved proxy resilience, annotation outline bounds, CCTV enable pacing,
  contact de-emphasis, and deterministic visual stacking.

## [Unreleased] — July 2026

### Added

- Added live NASA FIRMS fires, optional live TomTom traffic, Caltrans and TfL
  CCTV packs, CCTV viewsheds and direct-manipulation calibration, citywide CCTV
  cards, Natural Earth regions, analyst queries, and voice routing QA.
- Added the end-to-end vertical-datum system for aircraft, vessels, CCTV,
  annotations, trails, and terrain-aware rendering.
- Added aircraft class silhouettes, path-derived display heading, ADSBDB
  enrichment, cached CelesTrak TLE lookup, and next-ISS-pass prediction.

### Fixed

- Fixed elevated-airport aircraft placement, vessel sea-surface placement,
  close-zoom FIRMS anchors, antimeridian region framing, annotation resolution,
  cross-layer tracking ownership, and CCTV projection lifecycle issues.

## [Unreleased] — June 2026

### Added

- Added OpenAI Realtime voice control, scene-aware entity context, viewport image
  grounding, the AI HUD summary, live AIS vessels, infrastructure layers, map
  source switching, free-text navigation, and server-side data proxies.
- Added hybrid map annotations, 3D aircraft, panoptic detection, tracking
  harnesses, and public data attribution.
- Added MIT source licensing, security guidance, contribution guidance, data
  source notices, and third-party asset boundaries.

### Changed

- Removed the experimental AI video-edit style and retained seven deterministic
  visual styles.
- Moved Realtime text-history trimming to the server-side retention policy while
  keeping only the latest viewport image in conversation context.

## [0.7.0] — 2026-02-18

- Added the Bikeshare Pulse layer and panoptic label improvements.
- Improved tracked-item boxes, post-render alignment, and CCTV projection
  quality.
- Removed the experimental shift-drag CCTV calibration interaction.

## [0.6.0] — 2026-02-10

- Added the initial multi-layer 3D globe experience, visual styles, live
  aircraft, satellites, earthquakes, CCTV, traffic, FIRMS, infrastructure, and
  performance controls.
- Added entity inspection, tracking, scenes, keyboard controls, and shareable
  views.

## [0.1.0] — 2026-02-09

- Initial project version.
