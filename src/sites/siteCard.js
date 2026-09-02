/**
 * Volee Sites research brief — honest location card for an imported/dropped pin.
 * No Genius scores. Nearby counts come only from other imported Sites pins.
 * Access / traffic uses live TomTom flow + drive-time when keyed.
 * Locality + competitors prefer TomTom Search (server key); Nominatim /
 * Google Places are labeled fallbacks.
 */
import {
  ensureSiteMetadata,
  upsertSiteMetadata,
} from './siteStore.js';
import {
  descriptionFromProperties,
  folderFromProperties,
  formatCoordinates,
  kmlAttributeRows,
  stripHtmlToText,
} from './kmlText.js';
import { findNearbySites, formatDistanceM } from './nearbySites.js';
import {
  accessStatsDisplayModel,
  loadSiteAccessStats,
} from './siteAccessStats.js';
import {
  formatCompetitorListHtml,
  loadSiteCompetitors,
  loadSiteLocality,
} from './siteResearch.js';
import { loadSiteZoning } from './siteZoning.js';
import { loadSiteDemographics } from './siteDemographics.js';
import {
  ANCORA_GEOCODE_CAVEATS,
  ancoraOccupancyFromUnits,
  ancoraWasGeocoded,
} from './ancoraCentreFields.js';

const PANEL_ID = 'site-card-panel';

let _panel = null;
let _currentUid = null;
let _currentProps = null;
/** @type {AbortController|null} */
let _accessAbort = null;
/** @type {AbortController|null} */
let _researchAbort = null;
/** Last opened pin focus for Area News bias. */
let _openFocus = null;
/** Optional callback when the analyst renames a pin from the card. */
let _onSiteNameChange = null;
/** Optional callback when the analyst deletes the open pin. */
let _onSiteDelete = null;
/** @type {((event: KeyboardEvent) => void)|null} */
let _deleteKeyHandler = null;

function cancelAccessLoad() {
  if (_accessAbort) {
    _accessAbort.abort();
    _accessAbort = null;
  }
}

function cancelResearchLoad() {
  if (_researchAbort) {
    _researchAbort.abort();
    _researchAbort = null;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Register a listener for site-name edits from the research card.
 * @param {null|((uid:string, name:string)=>void)} listener
 */
export function setSiteCardNameChangeListener(listener) {
  _onSiteNameChange = typeof listener === 'function' ? listener : null;
}

/**
 * Register a listener for Delete pin from the research card.
 * @param {null|((uid:string)=>void)} listener
 */
export function setSiteCardDeleteListener(listener) {
  _onSiteDelete = typeof listener === 'function' ? listener : null;
}

function uninstallDeleteKeyHandler() {
  if (!_deleteKeyHandler || typeof document === 'undefined') {
    _deleteKeyHandler = null;
    return;
  }
  document.removeEventListener('keydown', _deleteKeyHandler);
  _deleteKeyHandler = null;
}

/**
 * Confirm + delete the open pin (button or Delete key).
 * @param {string} uid
 * @param {string} displayName
 */
function requestDeletePin(uid, displayName) {
  if (!uid || typeof _onSiteDelete !== 'function') return;
  const liveName = _panel?.querySelector?.('[data-site-title]')?.textContent
    || _panel?.querySelector?.('[data-site-name]')?.value;
  const label = String(liveName || displayName || 'this pin').trim() || 'this pin';
  const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
    ? window.confirm(`Delete pin “${label}”? This cannot be undone. Other Sites pins stay.`)
    : true;
  if (!ok) return;
  try { _onSiteDelete(uid); } catch { /* ignore */ }
}

function installDeleteKeyHandler(uid, displayName) {
  uninstallDeleteKeyHandler();
  if (typeof document === 'undefined') return;
  _deleteKeyHandler = (event) => {
    if (event.key !== 'Delete') return;
    const tag = event.target?.tagName?.toLowerCase?.();
    const editable = tag === 'input' || tag === 'textarea' || event.target?.isContentEditable;
    if (editable) return;
    if (_currentUid !== uid || !isSiteCardOpen()) return;
    event.preventDefault();
    requestDeletePin(uid, displayName);
  };
  document.addEventListener('keydown', _deleteKeyHandler);
}

function ensurePanel() {
  if (_panel && document.body.contains(_panel)) return _panel;
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = PANEL_ID;
    panel.className = 'site-card-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Site research brief');
    document.body.appendChild(panel);
  }
  _panel = panel;
  return panel;
}

function renderNearbyBlock(nearby2km, nearby5km) {
  const list2 = nearby2km || [];
  const count5 = nearby5km?.length ?? 0;
  if (!list2.length && count5 === 0) {
    return `<p class="site-card-muted">No other imported Sites pins within 5 km.</p>`;
  }
  const names = list2.slice(0, 8).map((site) => `
    <li>
      <span>${escapeHtml(site.name)}</span>
      <span class="site-card-dist">${escapeHtml(formatDistanceM(site.distanceM))}</span>
    </li>
  `).join('');
  const more2 = list2.length > 8
    ? `<p class="site-card-muted">+${list2.length - 8} more within 2 km</p>`
    : '';
  return `
    <p class="site-card-nearby-summary">
      <strong>${list2.length}</strong> imported pin${list2.length === 1 ? '' : 's'} within 2 km
      · <strong>${count5}</strong> within 5 km
    </p>
    ${list2.length ? `<ul class="site-card-nearby-list">${names}</ul>${more2}` : ''}
  `;
}

function renderAccessLoadingHtml() {
  return `
    <p class="site-card-muted" data-site-access-status>Loading access / traffic…</p>
    <div class="site-card-access-body" hidden></div>
  `;
}

/**
 * Paint Access / traffic into the card mount (idempotent).
 * @param {HTMLElement|null} mount
 * @param {object} stats
 */
function paintAccessStats(mount, stats) {
  if (!mount) return;
  const model = accessStatsDisplayModel(stats);
  const status = mount.querySelector('[data-site-access-status]');
  const body = mount.querySelector('.site-card-access-body');
  if (status) status.hidden = true;
  if (!body) return;
  body.hidden = false;
  body.innerHTML = `
    <div class="site-card-access-block">
      <div class="site-card-access-label">Live flow near pin</div>
      <ul class="site-card-access-list">
        ${model.flowLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}
      </ul>
    </div>
    <div class="site-card-access-block">
      <div class="site-card-access-label">Drive-time catchment (5 / 10 / 15 min)</div>
      <ul class="site-card-access-list">
        ${model.driveLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}
      </ul>
    </div>
    ${model.footnotes.length
    ? `<ul class="site-card-access-notes">${model.footnotes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : ''}
  `;
}

function paintLocality(mount, locality) {
  if (!mount) return;
  const body = mount.querySelector('[data-site-locality-body]') || mount;
  if (!locality || locality.status !== 'ok') {
    body.innerHTML = `<p class="site-card-muted">${escapeHtml(locality?.message || 'Locality unavailable.')}</p>`;
    return;
  }
  const sourceLine = locality.source === 'tomtom'
    ? 'Reverse-geocoded via TomTom Search (server key). Not a cadastral address.'
    : locality.source === 'nominatim'
      ? `Reverse-geocoded via OpenStreetMap Nominatim${locality.fallbackNote || ''}. Not a cadastral address.`
      : 'Reverse-geocoded locality. Not a cadastral address.';
  body.innerHTML = `
    <p class="site-card-locality-label">${escapeHtml(locality.label)}</p>
    <p class="site-card-muted">${escapeHtml(sourceLine)}</p>
  `;
}

function competitorSourceLabel(competitors) {
  if (competitors?.source === 'tomtom') return ' · TomTom Places Search (retail categories)';
  if (competitors?.source === 'google') {
    return ` · Google Places (retail types)${competitors.fallbackNote || ''}`;
  }
  return '';
}

function paintCompetitors(mount, competitors) {
  if (!mount) return;
  const body = mount.querySelector('[data-site-competitors-body]') || mount;
  if (!competitors || (competitors.status !== 'ok' && competitors.status !== 'empty')) {
    const msg = competitors?.status === 'keyless'
      ? (competitors.message || 'No TomTom or Maps key — competitor nearby search unavailable.')
      : competitors?.status === 'budget'
        ? (competitors.message || 'TomTom Evaluation search budget reached — try again later.')
        : competitors?.status === 'denied'
          ? (competitors.message || 'Google Places denied this request.')
          : (competitors?.message || 'Competitor search unavailable.');
    body.innerHTML = `<p class="site-card-muted">${escapeHtml(msg)}</p>`;
    return;
  }
  if (competitors.status === 'empty') {
    body.innerHTML = `<p class="site-card-muted">${escapeHtml(competitors.message || 'No retail anchors found within 5 km.')}</p>`;
    return;
  }
  const list2 = formatCompetitorListHtml(competitors.within2km, 8, escapeHtml);
  const list5 = formatCompetitorListHtml(
    competitors.within5km.filter((p) => p.distanceM > 2000),
    6,
    escapeHtml,
  );
  body.innerHTML = `
    <p class="site-card-nearby-summary">
      <strong>${competitors.within2km.length}</strong> within 2 km
      · <strong>${competitors.within5km.length}</strong> within 5 km
      <span class="site-card-muted">${escapeHtml(competitorSourceLabel(competitors))}</span>
    </p>
    ${list2 ? `<ul class="site-card-nearby-list">${list2}</ul>` : '<p class="site-card-muted">None within 2 km.</p>'}
    ${list5 ? `<details class="site-card-attrs"><summary>Also within 5 km</summary><ul class="site-card-nearby-list">${list5}</ul></details>` : ''}
  `;
}

function formatMaybe(value, suffix = '') {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}${suffix}`;
  }
  const s = String(value).trim();
  return s ? `${s}${suffix}` : null;
}

function paintAncoraCentre(mount, properties) {
  if (!mount) return;
  const body = mount.querySelector('[data-site-ancora-body]') || mount;
  const props = properties && typeof properties === 'object' ? properties : {};
  const example = props.example === true || props.example === 'true';
  const recordName = formatMaybe(props.name || props.Name);
  const geocodedName = formatMaybe(props.geocoded_name || props.geocodedName);
  const geocodedAddress = formatMaybe(props.geocoded_address || props.geocodedAddress);
  const geocoded = ancoraWasGeocoded(props);
  const occupancy = ancoraOccupancyFromUnits(props);

  const rows = [];
  if (recordName) rows.push(['Name (record)', recordName]);
  if (geocodedName) rows.push(['Geocoded name', geocodedName]);
  if (geocodedAddress) rows.push(['Geocoded address', geocodedAddress]);
  const locality = formatMaybe(props.locality || props.city);
  const region = formatMaybe(props.region || props.province);
  const mandate = formatMaybe(props.mandate_status || props.mandate || props.Mandate);
  const gla = formatMaybe(props.gla_sqm ?? props.gla ?? props.GLA, ' m²');
  if (locality) rows.push(['Locality', locality]);
  if (region) rows.push(['Region', region]);
  if (mandate) rows.push(['Mandate status', mandate]);
  if (gla) rows.push(['GLA', gla]);
  if (occupancy.units != null) rows.push(['Units', String(occupancy.units)]);
  if (occupancy.occupied != null) rows.push(['Units occupied', String(occupancy.occupied)]);
  if (occupancy.vacant != null) rows.push(['Units vacant', String(occupancy.vacant)]);
  if (occupancy.occupancyPct != null) {
    rows.push(['Occupancy', `${occupancy.occupancyPct}% (from unit counts)`]);
  }

  const missing = [];
  if (!mandate) missing.push('mandate_status');
  if (!gla) missing.push('GLA');
  if (occupancy.units == null) missing.push('units');
  if (occupancy.occupancyPct == null) missing.push('occupancy');

  const nameMismatch = recordName && geocodedName
    && recordName.toLocaleLowerCase() !== geocodedName.toLocaleLowerCase();

  body.innerHTML = `
    ${example
    ? `<p class="site-card-example-banner">EXAMPLE centre — not live Ancora / PropertyCentral occupancy.</p>`
    : ''}
    ${geocoded
    ? `<p class="site-card-geocode-note">Geocoded (not surveyed) — Google Places Text Search (ZA/ZW). Coordinates are Places matches, not on-site surveys.${nameMismatch ? ' Record name and geocoded name differ — verify on site.' : ''}</p>`
    : ''}
    ${rows.length
    ? `<dl class="site-card-identity">${rows.map(([k, v]) => `
        <div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>
      `).join('')}</dl>`
    : `<p class="site-card-muted">No centre fields on this feature.</p>`}
    ${missing.length
    ? `<p class="site-card-muted">No data for ${escapeHtml(missing.join(', '))} — not invented. Occupancy uses public.units counts only when present.</p>`
    : ''}
    ${!example ? `
    <details class="site-card-attrs">
      <summary>Geocode caveats (2026-09-02 dump)</summary>
      <ul class="site-card-caveat-list">
        ${ANCORA_GEOCODE_CAVEATS.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}
      </ul>
    </details>
    ` : ''}
    ${props.source_note
    ? `<p class="site-card-muted">${escapeHtml(String(props.source_note))}</p>`
    : ''}
  `;
}

function paintZoning(mount, zoning) {
  if (!mount) return;
  const body = mount.querySelector('[data-site-zoning-body]') || mount;
  if (!zoning || zoning.status !== 'ok') {
    body.innerHTML = `<p class="site-card-muted">${escapeHtml(zoning?.message || 'No zoning layer loaded')}</p>`;
    return;
  }
  body.innerHTML = `
    ${zoning.example ? `<p class="site-card-example-banner">EXAMPLE zoning polygon</p>` : ''}
    <dl class="site-card-identity">
      ${zoning.zoneName ? `<div><dt>Zone</dt><dd>${escapeHtml(zoning.zoneName)}</dd></div>` : ''}
      ${zoning.zoneCode ? `<div><dt>Code</dt><dd>${escapeHtml(zoning.zoneCode)}</dd></div>` : ''}
    </dl>
    <p class="site-card-muted">${escapeHtml(zoning.message || 'Matched local zoning GeoJSON.')}</p>
  `;
}

function paintDemographics(mount, demo) {
  if (!mount) return;
  const body = mount.querySelector('[data-site-demographics-body]') || mount;
  if (!demo || demo.status !== 'ok') {
    body.innerHTML = `<p class="site-card-muted">${escapeHtml(demo?.message || 'Stats SA not wired — drop a ward/census GeoJSON to enable')}</p>`;
    return;
  }
  body.innerHTML = `
    ${demo.example ? `<p class="site-card-example-banner">EXAMPLE census / ward polygon</p>` : ''}
    <dl class="site-card-identity">
      ${demo.wardName ? `<div><dt>Ward</dt><dd>${escapeHtml(demo.wardName)}</dd></div>` : ''}
      ${demo.wardCode ? `<div><dt>Code</dt><dd>${escapeHtml(demo.wardCode)}</dd></div>` : ''}
      ${demo.municipality ? `<div><dt>Municipality</dt><dd>${escapeHtml(demo.municipality)}</dd></div>` : ''}
    </dl>
    <p class="site-card-muted">${escapeHtml(demo.message || 'Matched ward GeoJSON. No LSM or income invented.')}</p>
  `;
}

/**
 * Open / refresh the research brief for a feature.
 * @param {object} options
 * @param {string} options.uid
 * @param {string} options.name
 * @param {object} [options.properties]
 * @param {number|null} [options.latitude]
 * @param {number|null} [options.longitude]
 * @param {string} [options.layerName]
 * @param {Array<{uid:string,name?:string,latitude?:number,longitude?:number}>} [options.sites]
 * @param {string} [options.liveLayersNote]
 * @param {'sites'|'ancora'} [options.mode='sites']
 * @param {boolean} [options.showDelete=true]
 * @param {boolean} [options.showNearbyImported=true]
 * @param {boolean} [options.showAccess=true]
 * @param {boolean} [options.showCompetitors=true]
 * @param {boolean} [options.allowRename=true]
 */
export function openSiteCard({
  uid,
  name,
  properties = {},
  latitude = null,
  longitude = null,
  layerName = '',
  sites = [],
  liveLayersNote = '',
  mode = 'sites',
  showDelete = mode !== 'ancora',
  showNearbyImported = mode !== 'ancora',
  showAccess = true,
  showCompetitors = true,
  allowRename = mode !== 'ancora',
} = {}) {
  if (!uid || typeof document === 'undefined') return;
  cancelAccessLoad();
  cancelResearchLoad();
  _currentUid = uid;
  _currentProps = properties;
  const panel = ensurePanel();
  const meta = ensureSiteMetadata(uid, name);
  const isAncora = mode === 'ancora';
  _openFocus = Number.isFinite(latitude) && Number.isFinite(longitude)
    ? {
      latitude,
      longitude,
      name: meta.site_name || name || properties?._name || null,
      uid,
    }
    : null;
  const displayName = meta.site_name || name || properties._name || (isAncora ? 'Ancora centre' : 'Untitled site');
  const folder = folderFromProperties(properties, layerName);
  const description = descriptionFromProperties(properties);
  const attrs = kmlAttributeRows(properties);
  const coords = formatCoordinates(latitude, longitude);

  const nearby2km = showNearbyImported
    ? findNearbySites({
      focusUid: uid,
      latitude,
      longitude,
      sites,
      radiusM: 2000,
      limit: 24,
    })
    : [];
  const nearby5km = showNearbyImported
    ? findNearbySites({
      focusUid: uid,
      latitude,
      longitude,
      sites,
      radiusM: 5000,
      limit: 200,
    })
    : [];

  panel.hidden = false;
  document.body?.classList.add('site-card-open');
  emitSiteCardOpenChange(true);
  panel.dataset.cardMode = isAncora ? 'ancora' : 'sites';
  panel.innerHTML = `
    <div class="site-card-header">
      <div class="site-card-kicker">${isAncora ? 'ANCORA · CENTRE BRIEF' : 'SITES · RESEARCH BRIEF'}</div>
      <button type="button" class="site-card-close" data-site-close title="Close" aria-label="Close site card">×</button>
    </div>
    <h2 class="site-card-title" data-site-title>${escapeHtml(displayName)}</h2>

    ${allowRename ? `
    <label class="site-card-field">
      <span>Name</span>
      <input type="text" data-site-name value="${escapeHtml(displayName)}" placeholder="Site name…" maxlength="160" />
    </label>
    ` : `
    <p class="site-card-muted" style="margin:0 0 0.7rem">Name from Ancora GeoJSON (read-only).</p>
    `}

    <section class="site-card-section">
      <div class="site-card-section-title">Identity</div>
      <dl class="site-card-identity">
        <div><dt>Layer</dt><dd>${escapeHtml(folder)}</dd></div>
        <div><dt>Coordinates</dt><dd>${escapeHtml(coords)}</dd></div>
      </dl>
    </section>

    ${isAncora ? `
    <section class="site-card-section" data-site-ancora>
      <div class="site-card-section-title">Centre record</div>
      <div data-site-ancora-body></div>
    </section>
    ` : ''}

    <section class="site-card-section" data-site-locality>
      <div class="site-card-section-title">Locality</div>
      <p class="site-card-muted" data-site-locality-body>Resolving reverse geocode…</p>
    </section>

    ${!isAncora ? `
    <section class="site-card-section">
      <div class="site-card-section-title">From the KMZ</div>
      ${description
    ? `<p class="site-card-description">${escapeHtml(description)}</p>`
    : `<p class="site-card-muted">No description in the KML for this pin.</p>`}
      ${attrs.length ? `
        <details class="site-card-attrs" open>
          <summary>Original attributes</summary>
          <dl>
            ${attrs.map(([key, value]) => `
              <div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>
            `).join('')}
          </dl>
        </details>
      ` : `<p class="site-card-muted">No ExtendedData / extra attributes on this placemark.</p>`}
    </section>
    ` : ''}

    ${showNearbyImported ? `
    <section class="site-card-section">
      <div class="site-card-section-title">Nearby imported pins</div>
      <p class="site-card-muted">Counted from Sites pins already on this globe — not a commercial catchment model.</p>
      ${renderNearbyBlock(nearby2km, nearby5km)}
      ${liveLayersNote
    ? `<p class="site-card-live">${escapeHtml(liveLayersNote)}</p>`
    : ''}
    </section>
    ` : ''}

    ${showAccess ? `
    <section class="site-card-section site-card-access" data-site-access>
      <div class="site-card-section-title">Access / traffic</div>
      ${renderAccessLoadingHtml()}
    </section>
    ` : ''}

    ${showCompetitors ? `
    <section class="site-card-section" data-site-competitors>
      <div class="site-card-section-title">Competitors nearby</div>
      <p class="site-card-muted" data-site-competitors-body>Searching retail anchors (TomTom Places)…</p>
    </section>
    ` : ''}

    <section class="site-card-section" data-site-zoning>
      <div class="site-card-section-title">Zoning / SDF</div>
      <p class="site-card-muted" data-site-zoning-body>Checking local zoning GeoJSON…</p>
    </section>

    <section class="site-card-section" data-site-demographics>
      <div class="site-card-section-title">Census / demographics</div>
      <p class="site-card-muted" data-site-demographics-body>Checking ward / census GeoJSON…</p>
    </section>

    <label class="site-card-field">
      <span>Notes</span>
      <textarea data-site-notes rows="3" placeholder="Analyst notepad…">${escapeHtml(meta.notes || '')}</textarea>
    </label>

    ${!isAncora ? `
    <section class="site-card-section site-card-research">
      <div class="site-card-section-title">Research · not wired yet</div>
      <ul class="site-card-stubs">
        <li>
          <strong>PropertyCentral occupancy</strong>
          <span>Not wired yet — use the Ancora layer for centre GeoJSON when available. No invented occupancy.</span>
        </li>
      </ul>
      <p class="site-card-muted">No LSM, footfall, or composite scores are invented here.</p>
    </section>
    ` : `
    <p class="site-card-muted">No LSM, footfall, or composite scores are invented here.</p>
    `}

    <section class="site-card-section site-card-actions">
      <p class="site-card-muted">${isAncora
    ? 'Live Ancora dump goes in <code>public/sites/ancora-centres.geojson</code> (gitignored). Example template: <code>ancora-centres.example.geojson</code>. Sites KMZ: enable Sites → <strong>IMPORT</strong> (cached after first load).'
    : 'Research = this brief (click a pin). Load KMZ/KML via <strong>IMPORT</strong> (faster after first load — cached) or drop a file on the globe. <strong>RESET</strong> clears all Sites — use Delete pin for one.'}</p>
      ${showDelete ? `
      <button type="button" class="site-card-delete" data-site-delete title="Remove this pin only (Delete key)">
        Delete pin
      </button>
      ` : ''}
    </section>
  `;

  panel.querySelector('[data-site-close]')?.addEventListener('click', () => closeSiteCard());
  if (showDelete) {
    panel.querySelector('[data-site-delete]')?.addEventListener('click', () => {
      requestDeletePin(uid, displayName);
    });
    installDeleteKeyHandler(uid, displayName);
  } else {
    uninstallDeleteKeyHandler();
  }
  panel.querySelector('[data-site-notes]')?.addEventListener('change', (event) => {
    const nameInput = panel.querySelector('[data-site-name]');
    upsertSiteMetadata(uid, {
      site_name: nameInput?.value?.trim() || displayName,
      notes: event.target.value,
    });
  });
  if (allowRename) {
    panel.querySelector('[data-site-name]')?.addEventListener('change', (event) => {
      const nextName = String(event.target.value || '').trim() || 'Untitled site';
      upsertSiteMetadata(uid, { site_name: nextName });
      const title = panel.querySelector('[data-site-title]');
      if (title) title.textContent = nextName;
      if (_openFocus?.uid === uid) _openFocus = { ..._openFocus, name: nextName };
      try { _onSiteNameChange?.(uid, nextName); } catch { /* ignore */ }
    });
  }

  if (isAncora) {
    paintAncoraCentre(panel.querySelector('[data-site-ancora]'), properties);
  }

  const accessMount = panel.querySelector('[data-site-access]');
  if (accessMount && Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const controller = new AbortController();
    _accessAbort = controller;
    loadSiteAccessStats({
      latitude,
      longitude,
      signal: controller.signal,
    }).then((stats) => {
      if (_currentUid !== uid || controller.signal.aborted) return;
      paintAccessStats(accessMount, stats);
    }).catch((err) => {
      if (err?.name === 'AbortError' || _currentUid !== uid) return;
      paintAccessStats(accessMount, {
        flow: {
          mode: 'unavailable',
          summary: { total: 0, pctFree: null, pctSlow: null, pctJam: null, closures: 0 },
          coverageNote: 'Access / traffic request failed.',
          snapshotNote: null,
        },
        drive: {
          mode: 'unavailable',
          rings: [
            { minutes: 5, state: 'unavailable', medianKm: null, maxKm: null },
            { minutes: 10, state: 'unavailable', medianKm: null, maxKm: null },
            { minutes: 15, state: 'unavailable', medianKm: null, maxKm: null },
          ],
          note: 'Drive-time unavailable.',
        },
      });
    });
  } else if (accessMount) {
    paintAccessStats(accessMount, {
      flow: {
        mode: 'unavailable',
        summary: { total: 0, pctFree: null, pctSlow: null, pctJam: null, closures: 0 },
        coverageNote: 'Pin has no coordinates — cannot fetch access stats.',
        snapshotNote: null,
      },
      drive: {
        mode: 'unavailable',
        rings: [],
        note: 'Pin has no coordinates.',
      },
    });
  }

  const localityMount = panel.querySelector('[data-site-locality]');
  const competitorsMount = panel.querySelector('[data-site-competitors]');
  const zoningMount = panel.querySelector('[data-site-zoning]');
  const demographicsMount = panel.querySelector('[data-site-demographics]');
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const controller = new AbortController();
    _researchAbort = controller;
    const tasks = [
      loadSiteLocality(latitude, longitude, { signal: controller.signal }),
      showCompetitors
        ? loadSiteCompetitors(latitude, longitude, { signal: controller.signal })
        : Promise.resolve(null),
      loadSiteZoning(latitude, longitude, { signal: controller.signal }),
      loadSiteDemographics(latitude, longitude, { signal: controller.signal }),
    ];
    Promise.all(tasks).then(([locality, competitors, zoning, demographics]) => {
      if (_currentUid !== uid || controller.signal.aborted) return;
      paintLocality(localityMount, locality);
      if (competitorsMount && competitors) paintCompetitors(competitorsMount, competitors);
      paintZoning(zoningMount, zoning);
      paintDemographics(demographicsMount, demographics);
      // Soft-fill name for untouched "Dropped pin" defaults.
      if (allowRename) {
        const nameInput = panel.querySelector('[data-site-name]');
        const current = String(nameInput?.value || '').trim();
        if (
          locality?.status === 'ok'
          && locality.label
          && (!current || current === 'Dropped pin' || current === 'Untitled site')
        ) {
          if (nameInput) nameInput.value = locality.locality || locality.label;
          const title = panel.querySelector('[data-site-title]');
          const nextName = locality.locality || locality.label;
          if (title) title.textContent = nextName;
          upsertSiteMetadata(uid, { site_name: nextName });
          if (_openFocus?.uid === uid) _openFocus = { ..._openFocus, name: nextName };
          try { _onSiteNameChange?.(uid, nextName); } catch { /* ignore */ }
        }
      }
    }).catch((err) => {
      if (err?.name === 'AbortError' || _currentUid !== uid) return;
      paintLocality(localityMount, { status: 'unavailable', message: 'Locality lookup failed.' });
      if (competitorsMount) {
        paintCompetitors(competitorsMount, { status: 'unavailable', message: 'Competitor search failed.' });
      }
      paintZoning(zoningMount, { status: 'unavailable', message: 'Zoning lookup failed.' });
      paintDemographics(demographicsMount, { status: 'unavailable', message: 'Census lookup failed.' });
    });
  } else {
    paintLocality(localityMount, { status: 'unavailable', message: 'Pin has no coordinates.' });
    if (competitorsMount) {
      paintCompetitors(competitorsMount, { status: 'unavailable', message: 'Pin has no coordinates.' });
    }
    paintZoning(zoningMount, { status: 'unavailable', message: 'Pin has no coordinates.' });
    paintDemographics(demographicsMount, { status: 'unavailable', message: 'Pin has no coordinates.' });
  }
}

export function closeSiteCard() {
  cancelAccessLoad();
  cancelResearchLoad();
  uninstallDeleteKeyHandler();
  const panel = _panel || (typeof document !== 'undefined' ? document.getElementById(PANEL_ID) : null);
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = '';
  }
  document.body?.classList.remove('site-card-open');
  emitSiteCardOpenChange(false);
  _currentUid = null;
  _currentProps = null;
  _openFocus = null;
}

function emitSiteCardOpenChange(open) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('volee:site-card', {
    detail: { open: Boolean(open) },
  }));
}

export function isSiteCardOpen() {
  const panel = _panel || (typeof document !== 'undefined' ? document.getElementById(PANEL_ID) : null);
  return Boolean(panel && !panel.hidden);
}

/**
 * Focus of the open Sites pin — Area News prefers this over camera nadir.
 * @returns {{latitude:number, longitude:number, name:string|null, uid:string}|null}
 */
export function getOpenSiteFocus() {
  if (!_currentUid || !_openFocus) return null;
  if (![ _openFocus.latitude, _openFocus.longitude ].every(Number.isFinite)) return null;
  return { ..._openFocus };
}

/** @deprecated Scores removed — kept as no-op export for any stale imports. */
export function siteStatusAccent() {
  return SITES_PIN_COLOR;
}

/** Single Sites pin colour (not a pipeline legend). */
export const SITES_PIN_COLOR = '#3dd6c6';
/** Ancora centres accent (matches ancoraLayer). */
export const ANCORA_CARD_ACCENT = '#e8a54b';

export { stripHtmlToText };
