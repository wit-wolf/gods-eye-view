/**
 * GEV-style HUD card for a selected Property Genius site.
 * Editable status, notes, and score dimensions; persists via siteStore.
 */
import {
  SITE_STATUSES,
  SITE_STATUS_LABELS,
  SCORE_DIMENSIONS,
  calculateScore,
  normalizeScoreInputs,
  normalizeSiteStatus,
} from './scoring.js';
import {
  ensureSiteMetadata,
  getSiteMetadata,
  loadSiteSettings,
  upsertSiteMetadata,
} from './siteStore.js';

const PANEL_ID = 'site-card-panel';
const INTERNAL_PROP_KEYS = new Set([
  '_uid', '_layerId', '_name', 'stroke', 'stroke-opacity', 'stroke-width',
  'fill', 'fill-opacity', 'icon', 'styleUrl',
]);

let _panel = null;
let _onChange = null;
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
    panel.setAttribute('aria-label', 'Site details');
    document.body.appendChild(panel);
  }
  _panel = panel;
  return panel;
}

function originalAttributes(properties) {
  const props = properties || {};
  const rows = [];
  for (const [key, value] of Object.entries(props)) {
    if (INTERNAL_PROP_KEYS.has(key)) continue;
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue;
    rows.push([key, String(value)]);
  }
  return rows.slice(0, 40);
}

function dimensionLabel(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function statusColor(status) {
  switch (normalizeSiteStatus(status)) {
    case 'screening': return '#4ea1ff';
    case 'shortlisted': return '#3dd68c';
    case 'rejected': return '#ff5c5c';
    default: return '#f0c14a';
  }
}

/**
 * Open / refresh the site card for a feature.
 * @param {object} options
 * @param {string} options.uid
 * @param {string} options.name
 * @param {object} [options.properties]
 * @param {function(object):void} [options.onChange]
 */
export function openSiteCard({ uid, name, properties = {}, onChange = null } = {}) {
  if (!uid || typeof document === 'undefined') return;
  _onChange = onChange;
  _currentUid = uid;
  _currentProps = properties;
  const panel = ensurePanel();
  const meta = ensureSiteMetadata(uid, name);
  const settings = loadSiteSettings();
  const inputs = normalizeScoreInputs(meta.dev_score_inputs);
  const score = calculateScore(inputs, settings.scoring_weights);
  const attrs = originalAttributes(properties);
  const displayName = meta.site_name || name || 'Untitled site';

  panel.hidden = false;
  panel.innerHTML = `
    <div class="site-card-header">
      <div class="site-card-kicker">SITES · PROPERTY GENIUS</div>
      <button type="button" class="site-card-close" data-site-close title="Close" aria-label="Close site card">×</button>
    </div>
    <h2 class="site-card-title">${escapeHtml(displayName)}</h2>
    <div class="site-card-score-row">
      <span class="site-card-score" style="color:${statusColor(meta.status)}">${score}</span>
      <span class="site-card-score-label">SCORE · 0–100</span>
      <span class="site-card-status-pill" style="border-color:${statusColor(meta.status)};color:${statusColor(meta.status)}">${escapeHtml(SITE_STATUS_LABELS[meta.status] || meta.status)}</span>
    </div>
    <label class="site-card-field">
      <span>Status</span>
      <select data-site-status>
        ${SITE_STATUSES.map((status) => `
          <option value="${status}" ${status === meta.status ? 'selected' : ''}>${SITE_STATUS_LABELS[status]}</option>
        `).join('')}
      </select>
    </label>
    <label class="site-card-field">
      <span>Notes</span>
      <textarea data-site-notes rows="3" placeholder="Screening notes…">${escapeHtml(meta.notes || '')}</textarea>
    </label>
    <div class="site-card-scores">
      <div class="site-card-section-title">Development scores</div>
      ${SCORE_DIMENSIONS.map((key) => `
        <label class="site-card-score-dim">
          <span>${dimensionLabel(key)}</span>
          <input type="range" min="0" max="10" step="1" data-score-key="${key}" value="${inputs[key]}" />
          <b data-score-val="${key}">${inputs[key]}</b>
        </label>
      `).join('')}
    </div>
    <details class="site-card-attrs" ${attrs.length ? '' : 'hidden'}>
      <summary>Original KML attributes</summary>
      <dl>
        ${attrs.map(([key, value]) => `
          <div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>
        `).join('')}
      </dl>
    </details>
  `;

  panel.querySelector('[data-site-close]')?.addEventListener('click', () => closeSiteCard());
  panel.querySelector('[data-site-status]')?.addEventListener('change', (event) => {
    persistPartial({ status: event.target.value });
  });
  panel.querySelector('[data-site-notes]')?.addEventListener('change', (event) => {
    persistPartial({ notes: event.target.value });
  });
  for (const input of panel.querySelectorAll('[data-score-key]')) {
    input.addEventListener('input', () => {
      const key = input.getAttribute('data-score-key');
      const val = Number(input.value);
      panel.querySelector(`[data-score-val="${key}"]`).textContent = String(val);
      const nextInputs = { ...normalizeScoreInputs(getSiteMetadata(uid)?.dev_score_inputs) };
      nextInputs[key] = val;
      persistPartial({ dev_score_inputs: nextInputs });
    });
  }
}

function persistPartial(patch) {
  if (!_currentUid) return;
  const record = upsertSiteMetadata(_currentUid, {
    site_name: _currentProps?._name || _currentProps?.name,
    ...patch,
  });
  _onChange?.(record);
  // Refresh score / pill without rebuilding the whole form (preserves focus).
  const panel = _panel;
  if (!panel) return;
  const settings = loadSiteSettings();
  const score = calculateScore(record.dev_score_inputs, settings.scoring_weights);
  const scoreEl = panel.querySelector('.site-card-score');
  const pill = panel.querySelector('.site-card-status-pill');
  if (scoreEl) {
    scoreEl.textContent = String(score);
    scoreEl.style.color = statusColor(record.status);
  }
  if (pill) {
    pill.textContent = SITE_STATUS_LABELS[record.status] || record.status;
    pill.style.borderColor = statusColor(record.status);
    pill.style.color = statusColor(record.status);
  }
}

export function closeSiteCard() {
  const panel = _panel || (typeof document !== 'undefined' ? document.getElementById(PANEL_ID) : null);
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = '';
  }
  _currentUid = null;
  _currentProps = null;
  _onChange = null;
}

export function isSiteCardOpen() {
  const panel = _panel || (typeof document !== 'undefined' ? document.getElementById(PANEL_ID) : null);
  return Boolean(panel && !panel.hidden);
}

/** Accent color for a site status (shared with globe styling). */
export function siteStatusAccent(status) {
  return statusColor(status);
}
