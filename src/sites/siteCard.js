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
} = {}) {
  if (!uid || typeof document === 'undefined') return;
  cancelAccessLoad();
  cancelResearchLoad();
  _currentUid = uid;
  _currentProps = properties;
  const panel = ensurePanel();
  const meta = ensureSiteMetadata(uid, name);
  _openFocus = Number.isFinite(latitude) && Number.isFinite(longitude)
    ? {
      latitude,
      longitude,
      name: meta.site_name || name || properties?._name || null,
      uid,
    }
    : null;
  const displayName = meta.site_name || name || properties._name || 'Untitled site';
  const folder = folderFromProperties(properties, layerName);
  const description = descriptionFromProperties(properties);
  const attrs = kmlAttributeRows(properties);
  const coords = formatCoordinates(latitude, longitude);

  const nearby2km = findNearbySites({
    focusUid: uid,
    latitude,
    longitude,
    sites,
    radiusM: 2000,
    limit: 24,
  });
  const nearby5km = findNearbySites({
    focusUid: uid,
    latitude,
    longitude,
    sites,
    radiusM: 5000,
    limit: 200,
  });

  panel.hidden = false;
  document.body?.classList.add('site-card-open');
  emitSiteCardOpenChange(true);
  panel.innerHTML = `
    <div class="site-card-header">
      <div class="site-card-kicker">SITES · RESEARCH BRIEF</div>
      <button type="button" class="site-card-close" data-site-close title="Close" aria-label="Close site card">×</button>
    </div>
    <h2 class="site-card-title" data-site-title>${escapeHtml(displayName)}</h2>

    <label class="site-card-field">
      <span>Name</span>
      <input type="text" data-site-name value="${escapeHtml(displayName)}" placeholder="Site name…" maxlength="160" />
    </label>

    <section class="site-card-section">
      <div class="site-card-section-title">Identity</div>
      <dl class="site-card-identity">
        <div><dt>Layer</dt><dd>${escapeHtml(folder)}</dd></div>
        <div><dt>Coordinates</dt><dd>${escapeHtml(coords)}</dd></div>
      </dl>
    </section>

    <section class="site-card-section" data-site-locality>
      <div class="site-card-section-title">Locality</div>
      <p class="site-card-muted" data-site-locality-body>Resolving reverse geocode…</p>
    </section>

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

    <section class="site-card-section">
      <div class="site-card-section-title">Nearby imported pins</div>
      <p class="site-card-muted">Counted from Sites pins already on this globe — not a commercial catchment model.</p>
      ${renderNearbyBlock(nearby2km, nearby5km)}
      ${liveLayersNote
    ? `<p class="site-card-live">${escapeHtml(liveLayersNote)}</p>`
    : ''}
    </section>

    <section class="site-card-section site-card-access" data-site-access>
      <div class="site-card-section-title">Access / traffic</div>
      ${renderAccessLoadingHtml()}
    </section>

    <section class="site-card-section" data-site-competitors>
      <div class="site-card-section-title">Competitors nearby</div>
      <p class="site-card-muted" data-site-competitors-body>Searching retail anchors (TomTom Places)…</p>
    </section>

    <label class="site-card-field">
      <span>Notes</span>
      <textarea data-site-notes rows="3" placeholder="Analyst notepad…">${escapeHtml(meta.notes || '')}</textarea>
    </label>

    <section class="site-card-section site-card-research">
      <div class="site-card-section-title">Research · not wired yet</div>
      <ul class="site-card-stubs">
        <li>
          <strong>Demographics / household income / LSM</strong>
          <span>Not wired yet — no invented Stats SA numbers.</span>
        </li>
        <li>
          <strong>Zoning / SDF</strong>
          <span>GeoJSON overlay / intersection — not wired yet (no national SA zoning API).</span>
        </li>
        <li>
          <strong>PropertyCentral occupancy</strong>
          <span>Not wired yet.</span>
        </li>
      </ul>
      <p class="site-card-muted">No demographics, footfall, or composite scores are invented here.</p>
    </section>
  `;

  panel.querySelector('[data-site-close]')?.addEventListener('click', () => closeSiteCard());
  panel.querySelector('[data-site-notes]')?.addEventListener('change', (event) => {
    const nameInput = panel.querySelector('[data-site-name]');
    upsertSiteMetadata(uid, {
      site_name: nameInput?.value?.trim() || displayName,
      notes: event.target.value,
    });
  });
  panel.querySelector('[data-site-name]')?.addEventListener('change', (event) => {
    const nextName = String(event.target.value || '').trim() || 'Untitled site';
    upsertSiteMetadata(uid, { site_name: nextName });
    const title = panel.querySelector('[data-site-title]');
    if (title) title.textContent = nextName;
    if (_openFocus?.uid === uid) _openFocus = { ..._openFocus, name: nextName };
    try { _onSiteNameChange?.(uid, nextName); } catch { /* ignore */ }
  });

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
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const controller = new AbortController();
    _researchAbort = controller;
    Promise.all([
      loadSiteLocality(latitude, longitude, { signal: controller.signal }),
      loadSiteCompetitors(latitude, longitude, { signal: controller.signal }),
    ]).then(([locality, competitors]) => {
      if (_currentUid !== uid || controller.signal.aborted) return;
      paintLocality(localityMount, locality);
      paintCompetitors(competitorsMount, competitors);
      // Soft-fill name for untouched "Dropped pin" defaults.
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
    }).catch((err) => {
      if (err?.name === 'AbortError' || _currentUid !== uid) return;
      paintLocality(localityMount, { status: 'unavailable', message: 'Locality lookup failed.' });
      paintCompetitors(competitorsMount, { status: 'unavailable', message: 'Competitor search failed.' });
    });
  } else {
    paintLocality(localityMount, { status: 'unavailable', message: 'Pin has no coordinates.' });
    paintCompetitors(competitorsMount, { status: 'unavailable', message: 'Pin has no coordinates.' });
  }
}

export function closeSiteCard() {
  cancelAccessLoad();
  cancelResearchLoad();
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

export { stripHtmlToText };
