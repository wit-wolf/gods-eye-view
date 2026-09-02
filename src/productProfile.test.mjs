import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  PRODUCT_BRANDING,
  PRODUCT_PROFILE,
  VOLEE_CUT_LAYER_IDS,
  VOLEE_ENABLED_LAYER_IDS,
  applyProductChrome,
  filterLayerStateRegistryForProduct,
  isProductFeatureEnabled,
  isProductLayerEnabled,
} from './productProfile.js';
import { LAYER_STATE_REGISTRY } from './data/layerState.js';
import { SCOPE_ENABLED_DEFAULT, isScopeMaskEnabled } from './scopeMask.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Volo by Volee branding is centralized', () => {
  assert.equal(PRODUCT_BRANDING.productName, 'Volo by Volee');
  assert.equal(PRODUCT_BRANDING.company, 'Volee');
  assert.equal(PRODUCT_BRANDING.productLine, 'Volo');
  assert.equal(PRODUCT_PROFILE.branding.productName, 'Volo by Volee');
  assert.equal(PRODUCT_BRANDING.scopeEnabledByDefault, false);
  assert.equal(SCOPE_ENABLED_DEFAULT, false);
  assert.equal(isScopeMaskEnabled(), false);
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(html, /<title>Volo by Volee<\/title>/);
  assert.match(html, /VOLO/);
  assert.doesNotMatch(html, /Eagle Eye|EAGLE EYE/i);
  assert.doesNotMatch(html, /God'?s Eye View/);
  assert.doesNotMatch(html, /TOP SECRET/);
  assert.match(html, /id="scope-toggle"[^>]*aria-pressed="false"/);
});

test('Volee profile keeps Sites/traffic/fires/Area News and cuts OSINT feeds', () => {
  assert.equal(PRODUCT_PROFILE.id, 'volee');
  for (const id of ['sites', 'ancora', 'area-news', 'traffic', 'local-firms', 'earthquakes']) {
    assert.equal(isProductLayerEnabled(id), true, id);
  }
  for (const id of VOLEE_CUT_LAYER_IDS) {
    assert.equal(isProductLayerEnabled(id), false, id);
  }
  assert.equal(isProductFeatureEnabled('voice'), false);
  assert.equal(isProductFeatureEnabled('radio'), false);
  assert.equal(isProductFeatureEnabled('cctv'), false);
  assert.equal(isProductFeatureEnabled('detection'), false);
  assert.deepEqual(
    [...VOLEE_ENABLED_LAYER_IDS].sort(),
    [...filterLayerStateRegistryForProduct(LAYER_STATE_REGISTRY).map((e) => e.id)].sort(),
  );
});

test('applyProductChrome hides cut HUD controls and reframes first-run', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  // Minimal DOM stub with the surfaces product chrome touches.
  const elements = new Map();
  const makeEl = (id, extras = {}) => {
    const el = {
      id,
      hidden: false,
      classList: {
        _c: new Set(),
        add(name) { this._c.add(name); },
        contains(name) { return this._c.has(name); },
      },
      dataset: {},
      textContent: extras.textContent || '',
      innerHTML: '',
      setAttribute() {},
      querySelector(sel) {
        if (sel === '.first-run-kicker') return elements.get('kicker');
        if (sel === '#first-run-description') return elements.get('desc');
        if (sel === '[data-first-run-status]') return elements.get('tip');
        if (sel === '[data-first-run-choice="contacts"]') return elements.get('contacts');
        if (sel === '[data-first-run-choice="space-missions"]') return elements.get('space');
        if (sel === '[data-first-run-choice="sites"]') return null;
        if (sel === '.first-run-choices') return elements.get('choices');
        if (sel === '[data-first-run-choice="environmental"]') return elements.get('environmental');
        return null;
      },
      querySelectorAll() { return []; },
      insertBefore(node, ref) {
        this._inserted = { node, ref };
      },
    };
    Object.assign(el, extras);
    elements.set(id, el);
    return el;
  };

  makeEl('cctv-panel');
  makeEl('radio-panel');
  makeEl('detection-toggle');
  makeEl('models3d-toggle');
  makeEl('global-context-panel');
  makeEl('kicker', { textContent: 'VOLEE · MISSION CONTROL' });
  makeEl('desc', { textContent: 'forbidden cockpit' });
  makeEl('tip', { textContent: 'Tip: the MIC button in the dock lets you talk to the map.' });
  makeEl('contacts');
  makeEl('space');
  makeEl('environmental');
  makeEl('choices');
  const launcher = makeEl('first-run-launcher');
  launcher.querySelector = makeEl('first-run-launcher').querySelector;

  const body = {
    classList: {
      _c: new Set(),
      add(name) { this._c.add(name); },
      contains(name) { return this._c.has(name); },
    },
    dataset: {},
  };

  const doc = {
    title: 'Volee',
    body,
    getElementById(id) {
      if (id === 'first-run-launcher') return launcher;
      return elements.get(id) || null;
    },
    querySelectorAll(sel) {
      const out = [];
      if (sel.includes('#cctv-panel') || sel === '#cctv-panel') out.push(elements.get('cctv-panel'));
      if (sel.includes('#radio-panel')) out.push(elements.get('radio-panel'));
      if (sel.includes('#detection-toggle')) out.push(elements.get('detection-toggle'));
      if (sel.includes('#models3d-toggle')) out.push(elements.get('models3d-toggle'));
      if (sel.includes('#global-context-panel')) out.push(elements.get('global-context-panel'));
      // applyProductChrome issues many selectors; ignore unknowns.
      return out.filter(Boolean);
    },
    createElement() {
      return {
        type: '',
        dataset: {},
        innerHTML: '',
      };
    },
  };

  // Patch launcher querySelector to use the shared map (makeEl overwrote).
  launcher.querySelector = (sel) => {
    if (sel === '.first-run-kicker') return elements.get('kicker');
    if (sel === '#first-run-description') return elements.get('desc');
    if (sel === '[data-first-run-status]') return elements.get('tip');
    if (sel === '[data-first-run-choice="contacts"]') return elements.get('contacts');
    if (sel === '[data-first-run-choice="space-missions"]') return elements.get('space');
    if (sel === '[data-first-run-choice="sites"]') return null;
    if (sel === '.first-run-choices') return elements.get('choices');
    if (sel === '[data-first-run-choice="environmental"]') return elements.get('environmental');
    return null;
  };
  elements.get('choices').querySelector = (sel) => {
    if (sel === '[data-first-run-choice="environmental"]') return elements.get('environmental');
    return null;
  };

  applyProductChrome(doc);
  assert.equal(body.classList.contains('product-volee'), true);
  assert.equal(elements.get('cctv-panel').hidden, true);
  assert.equal(elements.get('radio-panel').hidden, true);
  assert.equal(elements.get('detection-toggle').hidden, true);
  assert.equal(elements.get('kicker').textContent, 'VOLO · BY VOLEE');
  assert.match(elements.get('desc').textContent, /property/i);
  assert.doesNotMatch(elements.get('tip').textContent, /MIC button/i);
  assert.equal(doc.title, 'Volo by Volee');
  assert.equal(elements.get('contacts').hidden, true);
  assert.ok(elements.get('choices')._inserted?.node?.dataset?.firstRunChoice === 'sites'
    || elements.get('choices')._inserted?.node);
  assert.match(html, /data-first-run-choice="environmental"/);
});

test('main.js skips voice init and registers only product layers', () => {
  const main = readFileSync(join(root, 'src/main.js'), 'utf8');
  assert.match(main, /filterLayerStateRegistryForProduct/);
  assert.match(main, /isProductFeatureEnabled\('voice'\)/);
  assert.match(main, /PRODUCT_LAYER_STATE_REGISTRY/);
  assert.doesNotMatch(main, /dataManager\.register\(flightsLayer\)/);
  assert.doesNotMatch(main, /dataManager\.register\(cctvLayer\)/);
  assert.doesNotMatch(main, /dataManager\.register\(radioLayer\)/);
});
