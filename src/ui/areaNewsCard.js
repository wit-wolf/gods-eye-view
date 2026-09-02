/**
 * Area News widget — Sites-style panel for retail-then-business headlines.
 * No invented articles; empty and error states stay honest.
 */
import {
  formatAreaNewsAge,
  rankAndLimitAreaNews,
} from '../data/regionalBrief.js';

const PANEL_ID = 'area-news-panel';

let _panel = null;
let _open = false;
/** User closed the panel while the layer stays on — wait for a forced refresh. */
let _dismissed = false;

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
    panel.className = 'area-news-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Area news');
    document.body.appendChild(panel);
  }
  _panel = panel;
  return panel;
}

function emitOpenChange(open) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('volee:area-news', {
    detail: { open: Boolean(open) },
  }));
}

function topicLabel(topic) {
  if (topic === 'retail') return 'Retail';
  if (topic === 'business') return 'Business';
  return 'Other';
}

/**
 * @param {object} opts
 * @param {'loading'|'ready'|'empty'|'error'|'unavailable'} opts.state
 * @param {object|null} [opts.place]
 * @param {Array} [opts.articles]
 * @param {string|null} [opts.newsSource]
 * @param {string|null} [opts.message]
 * @param {string|null} [opts.focusLabel]
 */
export function renderAreaNewsCard({
  state = 'loading',
  place = null,
  articles = [],
  newsSource = null,
  message = null,
  focusLabel = null,
} = {}) {
  if (typeof document === 'undefined') return;
  const panel = ensurePanel();
  const placeLabel = place?.label || focusLabel || 'Focused area';
  const ranked = rankAndLimitAreaNews(articles, 10);

  let bodyHtml = '';
  if (state === 'loading') {
    bodyHtml = `<p class="area-news-muted">Loading retail and business headlines…</p>`;
  } else if (state === 'unavailable' || state === 'error') {
    bodyHtml = `<p class="area-news-muted">${escapeHtml(message || 'Area news is temporarily unavailable.')}</p>`;
  } else if (state === 'empty' || ranked.length === 0) {
    bodyHtml = `<p class="area-news-muted">${escapeHtml(message || 'No recent retail/business headlines for this area.')}</p>`;
  } else {
    bodyHtml = `
      <ul class="area-news-list">
        ${ranked.map((article) => `
          <li class="area-news-item" data-topic="${escapeHtml(article.topic || 'other')}">
            <a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">
              <span class="area-news-topic">${escapeHtml(topicLabel(article.topic))}</span>
              <strong class="area-news-headline">${escapeHtml(article.title)}</strong>
              <span class="area-news-meta">${escapeHtml(article.domain || 'source')} · ${escapeHtml(formatAreaNewsAge(article.publishedAt))}</span>
            </a>
          </li>
        `).join('')}
      </ul>
    `;
  }

  panel.hidden = false;
  _open = true;
  _dismissed = false;
  document.body?.classList.add('area-news-open');
  emitOpenChange(true);
  panel.innerHTML = `
    <div class="area-news-header">
      <div class="area-news-kicker">AREA NEWS · RETAIL THEN BUSINESS</div>
      <button type="button" class="area-news-close" data-area-news-close title="Close" aria-label="Close area news">×</button>
    </div>
    <h2 class="area-news-title">${escapeHtml(placeLabel)}</h2>
    <p class="area-news-lede">Location-matched headlines for the camera focus (and selected site when open). Not verified incidents.</p>
    ${bodyHtml}
    <p class="area-news-footnote">
      ${newsSource
    ? `Source: ${escapeHtml(newsSource)}. Article links keep publisher terms.`
    : 'Uses the free regional briefing path (Google News RSS, GDELT fallback).'}
    </p>
  `;

  panel.querySelector('[data-area-news-close]')?.addEventListener('click', () => {
    panel.hidden = true;
    _open = false;
    _dismissed = true;
    document.body?.classList.remove('area-news-open');
    emitOpenChange(false);
  });
}

export function closeAreaNewsCard() {
  const panel = _panel || (typeof document !== 'undefined' ? document.getElementById(PANEL_ID) : null);
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = '';
  }
  document.body?.classList.remove('area-news-open');
  if (_open) emitOpenChange(false);
  _open = false;
  _dismissed = false;
}

export function isAreaNewsCardOpen() {
  const panel = _panel || (typeof document !== 'undefined' ? document.getElementById(PANEL_ID) : null);
  return Boolean(panel && !panel.hidden);
}

/**
 * Re-show a hidden panel shell. Skipped after user dismiss until forced.
 * @param {{force?:boolean}} [opts]
 */
export function ensureAreaNewsCardVisible({ force = false } = {}) {
  if (_dismissed && !force) return _panel;
  const panel = ensurePanel();
  if (panel.hidden) {
    panel.hidden = false;
    _open = true;
    _dismissed = false;
    document.body?.classList.add('area-news-open');
    emitOpenChange(true);
  }
  return panel;
}
