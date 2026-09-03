// MAP STACK chip row — companion to the Map style panel.
//
// Chips project the accepted presentation allowlist from controller stack
// data. Clicks call the same `_setMapStack()` path. Active state tracks
// controller state (never optimistic). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAP_STACK_CHIP_CLASS,
  PRESENTED_MAP_STACK_IDS,
  mapStackChipModel,
  mapStackChipModels,
  renderMapStackChips,
  syncMapStackChips,
} from './mapStackChips.js';

/** Minimal element stand-in — the row only needs create/append/attr/class. */
function makeElement(tagName = 'div') {
  const element = {
    tagName,
    type: '',
    className: '',
    title: '',
    disabled: false,
    textContent: '',
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    classList: {
      toggle(name, force) {
        const classes = new Set(String(element.className).split(/\s+/).filter(Boolean));
        const next = force === undefined ? !classes.has(name) : !!force;
        if (next) classes.add(name);
        else classes.delete(name);
        element.className = [...classes].join(' ');
      },
      contains(name) {
        return String(element.className).split(/\s+/).includes(name);
      },
    },
    appendChild(child) { element.children.push(child); return child; },
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return element.attributes[name] ?? null; },
    addEventListener(type, handler) { (element.listeners[type] ||= []).push(handler); },
    click() { for (const handler of element.listeners.click || []) handler(); },
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set() { element.children.length = 0; },
  });
  return element;
}

const doc = { createElement: (tagName) => makeElement(tagName) };

/** Text a chip renders, label + optional requirement badge. */
const chipText = (chip) => chip.children.map((child) => child.textContent).join(' ');

const CONTROLLER_STACKS = [
  { id: 'google-satellite', label: 'Satellite', requiresIon: false, available: true, unavailableReason: null },
  { id: 'osm', label: 'Streets', requiresIon: false, available: true, unavailableReason: null },
  { id: 'google-hybrid', label: 'Satellite + labels', requiresIon: false, available: true, unavailableReason: null },
  { id: 'photoreal', label: '3D buildings', requiresIon: false, available: true, unavailableReason: null },
  { id: 'bing-aerial', label: 'Bing Aerial', requiresIon: true, available: true, unavailableReason: null },
  { id: 'bing-labels', label: 'Bing Labels', requiresIon: true, available: true, unavailableReason: null },
];

test('the row renders the accepted map style sources in product order', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'google-satellite', doc });

  assert.deepEqual(container.children.map((chip) => chip.dataset.stackId), [
    'google-satellite', 'osm', 'google-hybrid', 'photoreal', 'bing-aerial', 'bing-labels',
  ]);
  assert.deepEqual(container.children.map(chipText), [
    'Satellite', 'Streets', 'Satellite + labels', '3D buildings', 'Bing Aerial', 'Bing Labels',
  ]);
  assert.deepEqual([...PRESENTED_MAP_STACK_IDS], [
    'google-satellite', 'osm', 'google-hybrid', 'photoreal', 'bing-aerial', 'bing-labels',
  ]);
  assert.ok(container.children.every((chip) => chip.tagName === 'button' && chip.type === 'button'));
  assert.ok(container.children.every((chip) => chip.classList.contains(MAP_STACK_CHIP_CLASS)));
});

test('internal and future stacks stay outside the approved presentation set', () => {
  const container = makeElement();
  const withExtra = [...CONTROLLER_STACKS, { id: 'terrain-demo', label: 'Terrain demo', available: true }];
  renderMapStackChips(container, withExtra, { activeId: 'google-satellite', doc });

  assert.equal(container.children.length, PRESENTED_MAP_STACK_IDS.length);
  assert.doesNotMatch(container.children.map(chipText).join(' '), /Terrain demo/);
});

test('re-rendering replaces the previous chips instead of stacking a second row', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'google-satellite', doc });
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'osm', doc });

  assert.equal(container.children.length, PRESENTED_MAP_STACK_IDS.length);
});

test('clicking a chip dispatches that stack id', () => {
  const container = makeElement();
  const selected = [];
  renderMapStackChips(container, CONTROLLER_STACKS, {
    activeId: 'google-satellite',
    onSelect: (stackId) => selected.push(stackId),
    doc,
  });

  container.children[1].click(); // Streets
  container.children[4].click(); // Bing Aerial
  assert.deepEqual(selected, ['osm', 'bing-aerial']);
});

test('the active chip is the pressed chip, and exactly one is pressed', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'google-hybrid', doc });

  const pressed = container.children.filter((chip) => chip.getAttribute('aria-pressed') === 'true');
  assert.deepEqual(pressed.map((chip) => chip.dataset.stackId), ['google-hybrid']);
  assert.ok(pressed[0].classList.contains('active'));
});

test('the lit chip tracks controller state, not the click', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'google-satellite', doc });

  syncMapStackChips(container, 'google-satellite');
  assert.ok(container.children[0].classList.contains('active'));
  assert.equal(container.children[1].getAttribute('aria-pressed'), 'false');

  syncMapStackChips(container, 'osm');
  assert.ok(container.children[1].classList.contains('active'));
  assert.equal(container.children[1].getAttribute('aria-pressed'), 'true');
  assert.ok(!container.children[0].classList.contains('active'));
});

test('keyless ion stacks stay focusable, aria-disabled, and say why', () => {
  const container = makeElement();
  const keyless = CONTROLLER_STACKS.map((stack) => (stack.requiresIon ? {
    ...stack,
    available: false,
    unavailableReason: 'Cesium ion token required for Bing stacks',
  } : stack));
  const selected = [];
  renderMapStackChips(container, keyless, {
    activeId: 'google-satellite',
    onSelect: (stackId) => selected.push(stackId),
    doc,
  });

  const bingAerial = container.children[4];
  assert.equal(bingAerial.getAttribute('aria-disabled'), 'true');
  assert.equal(
    bingAerial.getAttribute('aria-label'),
    'Bing Aerial unavailable: Cesium ion token required for Bing stacks',
  );
  assert.equal(bingAerial.title, 'Cesium ion token required for Bing stacks');
  assert.equal(chipText(bingAerial), 'Bing Aerial ION');
  bingAerial.click();
  assert.deepEqual(selected, []);
  assert.equal(container.children[1].getAttribute('aria-disabled'), 'false', 'Streets stays selectable');
});

test('photoreal unavailable (tileset failed) does not show an ION badge', () => {
  const container = makeElement();
  const tilesFailed = CONTROLLER_STACKS.map((stack) => (stack.id === 'photoreal' ? {
    ...stack,
    available: false,
    unavailableReason: 'Google Photorealistic 3D Tiles unavailable',
  } : stack));
  renderMapStackChips(container, tilesFailed, { activeId: 'osm', doc });

  const google = container.children[3];
  assert.equal(
    google.getAttribute('aria-label'),
    '3D buildings unavailable: Google Photorealistic 3D Tiles unavailable',
  );
  assert.equal(chipText(google), '3D buildings', 'no ION badge on a stack that does not need ion');
});

test('mapStackChipModels and mapStackChipModel stay aligned with chip rendering', () => {
  assert.deepEqual(mapStackChipModels([{ id: 'osm', label: 'Streets' }], null), [{
    id: 'osm',
    label: 'Streets',
    available: true,
    active: false,
    requiresIon: false,
    requirement: '',
    unavailableHint: '',
    title: 'Streets',
  }]);
  assert.match(
    mapStackChipModel({
      id: 'bing-aerial',
      label: 'Bing Aerial',
      requiresIon: true,
      available: false,
    }, null).unavailableHint,
    /ion/i,
  );
});

test('HTML ships the Map style panel and MAP STYLE chip heading', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="map-style-panel"/);
  assert.match(html, /id="map-style-options"/);
  assert.match(html, /id="map-source-label">MAP STYLE</);
  assert.match(
    readFileSync(new URL('./ui.js', import.meta.url), 'utf8'),
    /renderMapStyleWidget\(this\._mapStyleOptions/,
  );
  assert.match(
    readFileSync(new URL('./ui.js', import.meta.url), 'utf8'),
    /syncMapStyleWidget\(this\._mapStyleOptions/,
  );
  assert.match(
    readFileSync(new URL('./ui.js', import.meta.url), 'utf8'),
    /renderMapStackChips\(this\._mapStackChips, stacks/,
  );
  assert.match(
    readFileSync(new URL('./ui.js', import.meta.url), 'utf8'),
    /_renderMapStackState\(state\) \{[\s\S]*?syncMapStackChips\(this\._mapStackChips, state\.activeId\)/,
  );
});

test('Bing Road stays retired — unknown map= ids must not invent a stack', () => {
  const module = readFileSync(new URL('./mapStackController.js', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /bing-road/,
    'Bing Road is retired: an old map=bing-road link must take the unknown-id default-stack fallback');
  assert.match(module, /DEFAULT_MAP_STACK_ID = 'google-satellite'/);
  assert.match(module, /id: 'google-hybrid'/);
  assert.match(module, /kind: 'google2d'/);
});
