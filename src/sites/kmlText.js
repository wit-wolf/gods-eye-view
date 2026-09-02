/**
 * KML attribute helpers for the Sites research card.
 * Strip markup; never invent demographics or scores.
 */

const INTERNAL_PROP_KEYS = new Set([
  '_uid', '_layerId', '_name',
  'stroke', 'stroke-opacity', 'stroke-width',
  'fill', 'fill-opacity', 'icon', 'styleUrl',
  'visibility', 'tessellate', 'extrude', 'altitudeMode',
  'label-scale', 'icon-scale', 'icon-offset', 'icon-offset-units',
  'icon-opacity', 'icon-color', 'label-color', 'label-opacity',
]);

const FOLDER_KEYS = [
  'folder', 'Folder', 'path', 'Path', 'layer', 'Layer',
  'document', 'Document', 'parent', 'Parent',
];

/**
 * Strip HTML / KML description markup to plain text.
 * @param {unknown} value
 * @returns {string}
 */
export function stripHtmlToText(value) {
  let text = String(value ?? '');
  if (!text) return '';
  text = text.replace(/<\s*br\s*\/?>/gi, '\n');
  text = text.replace(/<\/\s*p\s*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]{2,}/g, ' ').trim();
  return text;
}

/**
 * Best-effort KMZ folder / document path from feature properties.
 * @param {object} properties
 * @param {string} [layerName]
 * @returns {string}
 */
export function folderFromProperties(properties, layerName = '') {
  const props = properties || {};
  for (const key of FOLDER_KEYS) {
    const value = props[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return String(layerName || props._layerId || 'Imported layer').trim();
}

/**
 * Visible KML/ExtendedData rows for the research card.
 * @param {object} properties
 * @returns {Array<[string, string]>}
 */
export function kmlAttributeRows(properties) {
  const props = properties || {};
  const rows = [];
  for (const [key, value] of Object.entries(props)) {
    if (INTERNAL_PROP_KEYS.has(key)) continue;
    if (key === 'name' || key === 'Name' || key === 'title') continue;
    if (key === 'description' || key === 'Description') continue;
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue;
    const text = stripHtmlToText(value);
    if (!text) continue;
    rows.push([key, text.length > 240 ? `${text.slice(0, 237)}…` : text]);
  }
  return rows.slice(0, 40);
}

/**
 * Plain-text description from KML.
 * @param {object} properties
 * @returns {string}
 */
export function descriptionFromProperties(properties) {
  const props = properties || {};
  const raw = props.description ?? props.Description ?? '';
  return stripHtmlToText(raw);
}

/**
 * Format lat/lon for the identity block.
 * @param {number|null|undefined} latitude
 * @param {number|null|undefined} longitude
 * @returns {string}
 */
export function formatCoordinates(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return 'Coordinates unavailable';
  const ns = latitude >= 0 ? 'N' : 'S';
  const ew = longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(latitude).toFixed(5)}°${ns}, ${Math.abs(longitude).toFixed(5)}°${ew}`;
}
