/** Component integration checks in a virtual DOM. No browser/layout claims. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import postcss from 'postcss';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(frontend, 'src/views/mc1/reference');
const base = process.argv[2] || 'http://127.0.0.1:8000';
const checks = [];
function check(name, test) { assert.ok(test, name); checks.push(name); console.log('PASS', name); }
const selectors = css => {
  const result = [];
  postcss.parse(css).walkRules(rule => result.push(rule.selector.replace(/\r\n/g, '\n')));
  return result;
};
const originalCss = fs.readFileSync(path.join(frontend, '../VAST_Challenge_2026-main/frontend/src/style.css'), 'utf8');
const migratedCss = fs.readFileSync(path.join(source, 'style.css'), 'utf8');
assert.deepEqual(selectors(migratedCss), selectors(originalCss).map(s => s === 'body' ? ':host' : s));
check('Reference stylesheet keeps every layout selector (only body becomes shadow host)', true);
for (const [selector, properties] of Object.entries({ '.section': ['grid-template-columns', 'gap'], '.compare-row': ['display','gap'], '.heatmap-grid': ['display','gap'], '.flow-overlay': ['position','inset'], '.flow-modal': ['max-height'], '.net-svg': ['max-height'] })) {
  const read = css => {
    const values = [];
    postcss.parse(css).walkRules(selector, r => r.walkDecls(d => { if (properties.includes(d.prop)) values.push(`${d.prop}:${d.value}`); }));
    return values;
  };
  assert.deepEqual(read(migratedCss), read(originalCss));
}
check('Reference grid, comparison, heatmap and bounded-modal layout rules preserved', true);

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: base, pretendToBeVisual: true });
for (const key of ['window','document','HTMLElement','SVGElement','Element','Node','Event','MouseEvent','KeyboardEvent']) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const fetchReal = globalThis.fetch;
let holdCell = false;
let holdContext = false;
const delayed = [];
globalThis.fetch = async (url, options) => {
  const response = await fetchReal(new URL(url, base), options);
  if ((holdCell && /\/api\/messages\?/.test(url)) || (holdContext && /\/context$/.test(url))) {
    await new Promise(resolve => delayed.push(resolve));
  }
  return response;
};
const bundle = await build({ entryPoints: [path.join(source, 'main.jsx')], bundle: true, platform: 'browser', format: 'cjs', write: false, external: ['react','react-dom'], logLevel: 'silent' });
const module = { exports: {} };
new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const App = module.exports.default;
const root = createRoot(document.getElementById('root'));
let destination;
const wait = async predicate => {
  for (let i = 0; i < 160; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    if (predicate()) return;
  }
  throw new Error('Timed out waiting for component state');
};
const click = async el => {
  assert.ok(el, 'click target exists');
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};
const button = text => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text);
const summary = () => document.querySelector('.heatmap-section .ds-text')?.textContent;
try {
  await act(async () => root.render(React.createElement(App, { onDatasetChange: id => { destination = id; } })));
  await wait(() => document.querySelectorAll('.cell').length === 161 && document.querySelectorAll('.net-node').length === 7);
  check('Loads 7 agents × 23 time buckets and real reply graph', document.querySelector('.gc-counts').textContent.includes('912'));
  const cells = [...document.querySelectorAll('.cell')].filter(el => el.textContent.trim());
  const primaryCell = cells.find(el => el.title.startsWith('法务 Agent 2046-05-17T09:00:00'));
  await click(primaryCell);
  await wait(() => document.querySelectorAll('.heatmap-section .message').length > 0);
  const message = document.querySelector('.heatmap-section .message');
  message.focus();
  const selectedTimestamp = message.querySelector('.msg-meta b').textContent;
  await click(message);
  await wait(() => document.querySelector('.chat-bubble.selected'));
  check('Cell → messages → conversation keeps the selected message', document.querySelector('.chat-bubble.selected').textContent.includes(selectedTimestamp));
  const other = [...document.querySelectorAll('.chat-bubble')].find(el => !el.classList.contains('selected'));
  assert.ok(other, 'Source-backed conversation includes replies');
  if (other) {
    document.querySelector('.flow-list').scrollTop = 120;
    await click(other);
    await wait(() => document.querySelector('.flow-back'));
    await click(document.querySelector('.flow-back'));
    await wait(() => document.querySelector('.chat-bubble.selected')?.textContent.includes(selectedTimestamp));
    check('Conversation drill-in supports returning to previous message', true);
    check('Returning to a message restores the saved reading offset', document.querySelector('.flow-list').scrollTop === 120);
  }
  await act(async () => document.querySelector('.flow-modal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  check('Escape closes modal and retains cell selection', !document.querySelector('.flow-modal') && Boolean(summary()));
  check('Closing conversation restores keyboard focus to its source message', document.activeElement === message);
  const before = summary();
  holdCell = true;
  await click(primaryCell);
  await wait(() => delayed.length === 1);
  holdCell = false;
  await click(cells[cells.length - 1]);
  await wait(() => document.querySelectorAll('.heatmap-section .message').length > 0);
  const after = summary();
  await act(async () => delayed.splice(0).forEach(resolve => resolve()));
  await wait(() => document.querySelectorAll('.heatmap-section .message').length > 0);
  check('A slow previous cell response cannot overwrite latest selection', before !== after && summary() === after);

  // Defer the first context, select a second message programmatically, then release.
  await click(primaryCell);
  await wait(() => document.querySelectorAll('.heatmap-section .message').length >= 2);
  const messages = [...document.querySelectorAll('.heatmap-section .message')];
  holdContext = true;
  await click(messages[0]);
  await wait(() => delayed.length === 1);
  holdContext = false;
  await click(messages[1]);
  const timestamp2 = messages[1].querySelector('.msg-meta b').textContent;
  await wait(() => document.querySelector('.chat-bubble.selected')?.textContent.includes(timestamp2));
  await act(async () => delayed.splice(0).forEach(resolve => resolve()));
  await wait(() => document.querySelector('.chat-bubble.selected'));
  check('A slow old context response cannot overwrite current conversation', document.querySelector('.chat-bubble.selected').textContent.includes(timestamp2));
  await click(document.querySelector('.flow-close'));
  await click(button('情绪热力图'));
  await wait(() => document.querySelector('.cell-num'));
  check('Sentiment view labels actual lexical scoring', document.querySelector('[title*="词典命中分值"]'));
  await click(button('数量热力图'));
  await wait(() => !document.querySelector('.cell-num'));
  await click(button('文本来源'));
  const content = [...document.querySelectorAll('.heatmap-section label.check')].find(el => el.textContent.trim() === '消息内容')?.querySelector('input');
  const thoughts = [...document.querySelectorAll('.heatmap-section label.check')].find(el => el.textContent.includes('内心想法') && el.classList.contains('group-head'))?.querySelector('input');
  await click(content); await click(thoughts);
  await wait(() => document.querySelectorAll('.cell').length && [...document.querySelectorAll('.cell')].every(el => !el.textContent.trim()));
  check('Deselecting every text source yields zero results, never resets to all', true);
  await click(content);
  await wait(() => [...document.querySelectorAll('.cell')].some(el => el.textContent.trim()));
  check('Selecting a source again recovers from empty selection', true);
  await click(button('清空全部筛选'));
  await wait(() => document.querySelectorAll('.cell').length === 161);
  await click(document.querySelector('.net-node'));
  await wait(() => document.querySelectorAll('.network-section .message').length || document.querySelector('.node-detail'));
  check('Network node opens real node information', document.querySelector('.node-detail'));
  await click(document.querySelector('.edge-hit'));
  await wait(() => document.querySelector('.net-edge.selected') && document.querySelectorAll('.network-card > .detail-card:last-child .message').length > 0);
  check('Network edge opens its evidence messages', true);
  await click(button('◧ 并排对比'));
  check('Reference comparison mode keeps heatmap/network and hides side filters', document.querySelector('.compare-row') && !document.querySelector('.filter-panel') && !document.querySelector('.seqflow-card'));
  await click(button('MC2'));
  check('Dataset navigation calls the existing workspace switch', destination === 'MC2');
  check('Old MC1 remains linked', document.querySelector('a[href="?mc1=legacy"]'));

  // Mount the real application, including workspace providers and shadow host.
  globalThis.localStorage = dom.window.localStorage;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  dom.window.history.replaceState(null, '', '?mc1=reference');
  const integratedBundle = await build({
    entryPoints: [path.join(frontend, 'src/App.tsx')], bundle: true, platform: 'browser', format: 'cjs', write: false,
    external: ['react','react-dom'], logLevel: 'silent',
    plugins: [{ name: 'inline-css', setup(builder) {
      builder.onResolve({ filter: /\.css\?inline$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?inline$/, '')), namespace: 'inline-css' }));
      builder.onLoad({ filter: /.*/, namespace: 'inline-css' }, args => ({ contents: `export default ${JSON.stringify(fs.readFileSync(args.path, 'utf8'))}`, loader: 'js' }));
    } }],
  });
  const integratedModule = { exports: {} };
  new Function('require','module','exports',integratedBundle.outputFiles[0].text)(createRequire(import.meta.url),integratedModule,integratedModule.exports);
  const IntegratedApp = integratedModule.exports.default;
  await act(async () => root.render(React.createElement(IntegratedApp)));
  await wait(() => document.querySelector('[data-testid="mc1-reference"]')?.shadowRoot?.querySelectorAll('.cell').length === 161);
  const shadow = document.querySelector('[data-testid="mc1-reference"]').shadowRoot;
  check('Real app opens migrated MC1 inside an isolated stylesheet boundary', shadow.querySelector('style') && !document.querySelector('.evidence-dock') && !document.querySelector('.controlbar'));
  await click([...shadow.querySelectorAll('.workspace-nav button')].find(el => el.textContent === 'MC2'));
  await wait(() => document.querySelector('[data-testid="mc2-reference"]'));
  check('Migrated MC1 navigates to the new MC2 application', true);
  dom.window.history.replaceState(null, '', '?mc1=legacy');
  await act(async () => root.render(React.createElement(IntegratedApp, { key: 'legacy' })));
  await wait(() => document.querySelector('[data-testid="mc1-page"]'));
  check('Legacy MC1 still renders its original page with a new-page return link', !document.querySelector('[data-testid="mc1-reference"]') && document.querySelector('a[href="?mc1=reference"]'));
  console.log(JSON.stringify({ passed: checks.length, checks, limitation: 'Virtual DOM: does not measure visual layout, native scrolling or browser rendering.' }, null, 2));
} finally {
  await act(async () => root.unmount());
  dom.window.close();
}
// D3's shared clock keeps a housekeeping interval after the virtual window closes.
// All assertions and React cleanup have completed; no browser process is started.
process.exit(0);
