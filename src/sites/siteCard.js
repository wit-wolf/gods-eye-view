/**
 * Volee Sites research brief — honest location card for an imported pin.
 * No Genius scores. Nearby counts come only from other imported Sites pins.
 */
import {
  ensureSiteMetadata,
  upsertSiteMetadata,
} from './siteStore.js';
import { getCompetitorLayerStub } from './competitors.stub.js';
import {
  descriptionFromProperties,
  folderFromProperties,
  formatCoordinates,
  kmlAttributeRows,
  stripHtmlToText,
} from './kmlText.js';
import { findNearbySites, formatDistanceM } from './nearbySites.js';

const PANEL_ID = 'site-card-panel';

let _panel = null;
let _currentUid = null;
let _currentProps = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  _currentUid = uid;
  _currentProps = properties;
  const panel = ensurePanel();
  const meta = ensureSiteMetadata(uid, name);
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

  const competitors = getCompetitorLayerStub();

  panel.hidden = false;
  panel.innerHTML = `
    <div class="site-card-header">
      <div class="site-card-kicker">SITES · RESEARCH BRIEF</div>
      <button type="button" class="site-card-close" data-site-close title="Close" aria-label="Close site card">×</button>
    </div>
    <h2 class="site-card-title">${escapeHtml(displayName)}</h2>

    <section class="site-card-section">
      <div class="site-card-section-title">Identity</div>
      <dl class="site-card-identity">
        <div><dt>Layer</dt><dd>${escapeHtml(folder)}</dd></div>
        <div><dt>Coordinates</dt><dd>${escapeHtml(coords)}</dd></div>
      </dl>
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

    <label class="site-card-field">
      <span>Notes</span>
      <textarea data-site-notes rows="3" placeholder="Analyst notepad…">${escapeHtml(meta.notes || '')}</textarea>
    </label>

    <section class="site-card-section site-card-research">
      <div class="site-card-section-title">Research · not wired yet</div>
      <ul class="site-card-stubs">
        <li>
          <strong>Competitors</strong>
          <span>${escapeHtml(competitors.brands.join(', '))} — ${escapeHtml(competitors.note)}</span>
        </li>
        <li>
          <strong>Zoning</strong>
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
    upsertSiteMetadata(uid, {
      site_name: displayName,
      notes: event.target.value,
    });
  });
}

export function closeSiteCard() {
  const panel = _panel || (typeof document !== 'undefined' ? document.getElementById(PANEL_ID) : null);
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = '';
  }
  _currentUid = null;
  _currentProps = null;
}

export function isSiteCardOpen() {
  const panel = _panel || (typeof document !== 'undefined' ? document.getElementById(PANEL_ID) : null);
  return Boolean(panel && !panel.hidden);
}

/** @deprecated Scores removed — kept as no-op export for any stale imports. */
export function siteStatusAccent() {
  return SITES_PIN_COLOR;
}

/** Single Sites pin colour (not a pipeline legend). */
export const SITES_PIN_COLOR = '#3dd6c6';

export { stripHtmlToText };
