// Map style widget — dedicated left-rail control for basemap / globe stacks.
// One active style at a time. Unavailable stacks stay visible with an honest
// reason (missing Google key, missing Cesium ion token, 3D tileset failed).

export const MAP_STYLE_WIDGET_CLASS = 'map-style-option';

/** Presentation order for the Map style panel (product surface). */
export const PRESENTED_MAP_STYLE_IDS = Object.freeze([
  'google-satellite',
  'osm',
  'google-hybrid',
  'photoreal',
  'bing-aerial',
  'bing-labels',
]);

/**
 * @param {{id: string, label: string, shortLabel?: string, description?: string, available?: boolean, requiresIon?: boolean, requiresGoogle?: boolean, unavailableReason?: string|null}} stack
 * @param {string|null} activeId
 */
export function mapStyleOptionModel(stack, activeId) {
  const available = stack?.available !== false;
  const label = String(stack?.label ?? stack?.id ?? '');
  const description = String(stack?.description || stack?.shortLabel || '');
  const unavailableHint = available
    ? ''
    : String(stack?.unavailableReason || `${label || 'This map style'} is unavailable`);
  return {
    id: String(stack?.id ?? ''),
    label,
    description,
    available,
    active: !!stack?.id && stack.id === activeId,
    requiresIon: stack?.requiresIon === true,
    requiresGoogle: stack?.requiresGoogle === true,
    unavailableHint,
    title: available ? (description || label) : unavailableHint,
  };
}

/**
 * @param {Array<object>} stacks
 * @param {string|null} activeId
 */
export function mapStyleOptionModels(stacks, activeId) {
  const stacksById = new Map((Array.isArray(stacks) ? stacks : [])
    .map((stack) => [stack?.id, stack]));
  return PRESENTED_MAP_STYLE_IDS
    .map((id) => stacksById.get(id))
    .filter(Boolean)
    .map((stack) => mapStyleOptionModel(stack, activeId));
}

/**
 * @param {HTMLElement} container
 * @param {Array<object>} stacks
 * @param {object} [options]
 */
export function renderMapStyleWidget(container, stacks, {
  activeId = null,
  onSelect = null,
  doc,
} = {}) {
  if (!container) return [];
  const ownerDoc = doc || container.ownerDocument || globalThis.document;
  if (!ownerDoc?.createElement) return [];

  container.innerHTML = '';
  const models = mapStyleOptionModels(stacks, activeId);

  for (const model of models) {
    const row = ownerDoc.createElement('button');
    row.type = 'button';
    row.className = [
      MAP_STYLE_WIDGET_CLASS,
      model.active ? 'active' : '',
      model.available ? '' : 'unavailable',
    ].filter(Boolean).join(' ');
    row.dataset.stackId = model.id;
    row.title = model.title;
    row.setAttribute('aria-pressed', String(model.active));
    row.setAttribute('aria-disabled', String(!model.available));
    if (!model.available) {
      row.setAttribute('aria-label', `${model.label} unavailable: ${model.unavailableHint}`);
    }

    const left = ownerDoc.createElement('span');
    left.className = 'map-style-option-copy';

    const label = ownerDoc.createElement('strong');
    label.className = 'map-style-option-label';
    label.textContent = model.label;
    left.appendChild(label);

    if (model.description && model.description !== model.label) {
      const desc = ownerDoc.createElement('small');
      desc.className = 'map-style-option-desc';
      desc.textContent = model.description;
      left.appendChild(desc);
    }

    if (!model.available && model.unavailableHint) {
      const hint = ownerDoc.createElement('small');
      hint.className = 'map-style-option-unavailable';
      hint.textContent = model.unavailableHint;
      left.appendChild(hint);
    }

    row.appendChild(left);

    const mark = ownerDoc.createElement('span');
    mark.className = 'map-style-option-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = model.active ? '●' : '○';
    row.appendChild(mark);

    row.addEventListener('click', () => {
      if (!model.available) return;
      onSelect?.(model.id);
    });
    container.appendChild(row);
  }

  return models;
}

/**
 * @param {HTMLElement} container
 * @param {string|null} activeId
 */
export function syncMapStyleWidget(container, activeId) {
  const rows = container?.children;
  if (!rows) return;
  for (const row of Array.from(rows)) {
    const stackId = row?.dataset?.stackId;
    if (!stackId) continue;
    const active = stackId === activeId;
    row.classList?.toggle('active', active);
    row.setAttribute?.('aria-pressed', String(active));
    const mark = row.querySelector?.('.map-style-option-mark');
    if (mark) mark.textContent = active ? '●' : '○';
  }
}
