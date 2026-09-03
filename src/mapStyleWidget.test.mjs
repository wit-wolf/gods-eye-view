import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_STYLE_WIDGET_CLASS,
  PRESENTED_MAP_STYLE_IDS,
  mapStyleOptionModel,
  mapStyleOptionModels,
  renderMapStyleWidget,
  syncMapStyleWidget,
} from './mapStyleWidget.js';

function makeElement(tagName = 'div') {
  const element = {
    tagName,
    type: '',
    className: '',
    title: '',
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
    querySelector(sel) {
      if (sel === '.map-style-option-mark') {
        return this.children.find((c) => c.className === 'map-style-option-mark') || null;
      }
      return null;
    },
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return element.attributes[name] ?? null; },
    addEventListener(type, handler) { (element.listeners[type] ||= []).push(handler); },
    click() { for (const handler of this.listeners.click || []) handler(); },
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set() { element.children.length = 0; },
  });
  return element;
}

const doc = { createElement: (tagName) => makeElement(tagName) };

const STACKS = [
  { id: 'google-satellite', label: 'Satellite', description: 'Google 2D satellite', available: true },
  { id: 'osm', label: 'Streets', description: 'OpenStreetMap', available: true },
  { id: 'google-hybrid', label: 'Satellite + labels', description: 'Hybrid', available: true },
  { id: 'photoreal', label: '3D buildings', description: 'Heavy', available: true },
  {
    id: 'bing-aerial',
    label: 'Bing Aerial',
    description: 'Ion',
    available: false,
    requiresIon: true,
    unavailableReason: 'Cesium ion token required for Bing stacks',
  },
  { id: 'bing-labels', label: 'Bing Labels', available: false, requiresIon: true },
];

test('Map style widget presents one option per accepted stack id', () => {
  const container = makeElement();
  const models = renderMapStyleWidget(container, STACKS, { activeId: 'google-satellite', doc });
  assert.deepEqual([...PRESENTED_MAP_STYLE_IDS], [
    'google-satellite', 'osm', 'google-hybrid', 'photoreal', 'bing-aerial', 'bing-labels',
  ]);
  assert.equal(models.length, 6);
  assert.deepEqual(container.children.map((row) => row.dataset.stackId), [...PRESENTED_MAP_STYLE_IDS]);
  assert.ok(container.children.every((row) => row.classList.contains(MAP_STYLE_WIDGET_CLASS)));
  assert.equal(container.children[0].getAttribute('aria-pressed'), 'true');
});

test('unavailable Bing rows stay visible, disabled, and honest', () => {
  const container = makeElement();
  const selected = [];
  renderMapStyleWidget(container, STACKS, {
    activeId: 'osm',
    onSelect: (id) => selected.push(id),
    doc,
  });
  const bing = container.children[4];
  assert.equal(bing.getAttribute('aria-disabled'), 'true');
  assert.match(bing.getAttribute('aria-label') || '', /ion/i);
  bing.click();
  assert.deepEqual(selected, []);
  container.children[0].click();
  assert.deepEqual(selected, ['google-satellite']);
});

test('syncMapStyleWidget moves the active mark without re-render', () => {
  const container = makeElement();
  renderMapStyleWidget(container, STACKS, { activeId: 'google-satellite', doc });
  syncMapStyleWidget(container, 'osm');
  assert.equal(container.children[0].getAttribute('aria-pressed'), 'false');
  assert.equal(container.children[1].getAttribute('aria-pressed'), 'true');
  assert.ok(container.children[1].classList.contains('active'));
});

test('mapStyleOptionModels filters unknown ids', () => {
  assert.equal(mapStyleOptionModels([{ id: 'mystery', label: 'X' }], null).length, 0);
  assert.equal(mapStyleOptionModel({ id: 'osm', label: 'Streets' }, 'osm').active, true);
});
