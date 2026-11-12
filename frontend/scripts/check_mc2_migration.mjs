/** Real API + actual React components in jsdom; does not measure browser layout. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://127.0.0.1:8000';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: `${base}/?mc2=reference`, pretendToBeVisual: true });
for (const key of ['window','document','HTMLElement','SVGElement','Element','Node','Event','MouseEvent','KeyboardEvent','ShadowRoot','localStorage']) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const realFetch = globalThis.fetch;
const requests = [];
let holdEvents = false;
const delayed = [];
globalThis.fetch = async (url, options) => {
  requests.push(String(url));
  const response = await realFetch(new URL(url, base), options);
  if (holdEvents && new URL(url).pathname === '/api/events') await new Promise(resolve => delayed.push(resolve));
  return response;
};
const bundle = await build({
  entryPoints: [path.join(frontend, 'src/App.tsx')], bundle: true, platform: 'browser', format: 'cjs', write: false,
  external: ['react','react-dom'], logLevel: 'silent',
  plugins: [{ name: 'inline-css', setup(builder) {
    builder.onResolve({ filter: /\.css\?inline$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?inline$/, '')), namespace: 'inline-css' }));
    builder.onLoad({ filter: /.*/, namespace: 'inline-css' }, args => ({ contents: `export default ${JSON.stringify(fs.readFileSync(args.path, 'utf8'))}`, loader: 'js' }));
  } }],
});
const module = { exports: {} };
new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const root = createRoot(document.getElementById('root'));
let shadow;
const checks = [];
const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('PASS', label); };
const wait = async predicate => {
  for (let i = 0; i < 300; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    if (predicate()) return;
  }
  throw new Error('Timed out: ' + String(predicate));
};
const click = async element => { assert.ok(element, 'click target exists'); await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true }))); };
const buttons = (label, area = shadow) => [...area.querySelectorAll('button')].filter(el => el.textContent.trim() === label);
const change = async (selector, value) => {
  const element = shadow.querySelector(selector); assert.ok(element, selector);
  await act(async () => { element.value = value; Simulate.change(element, { target: element }); });
};
const submit = async selector => { await act(async () => Simulate.submit(shadow.querySelector(selector))); };
const rows = () => [...shadow.querySelectorAll('.mc2-record-list .mc2-record')];
const listScope = () => shadow.querySelector('.mc2-list-toolbar').textContent;
const ready = () => rows().length === 40 && listScope().includes('185,147');
try {
  await act(async () => root.render(React.createElement(module.exports.default)));
  await wait(() => { shadow = document.querySelector('[data-testid="mc2-reference"]')?.shadowRoot; return shadow?.querySelectorAll('.mc2-operation').length === 2 && shadow.querySelectorAll('.mc2-cell').length > 0 && ready(); });
  check('New MC2 is the default workspace and isolates its styles', shadow.querySelector('style') && !document.querySelector('.controlbar') && !document.querySelector('.evidence-dock'));
  check('All 147 actors are selectable, beyond overview top 50', shadow.querySelector('[aria-label="执行者"]').options.length === 148);
  check('Three explicit source roots and candidate evidence boundary are visible', shadow.querySelector('[aria-label="发布锚点"]').options.length === 3 && shadow.querySelector('.mc2-candidates').textContent.includes('全历史接力记录 186') && shadow.querySelector('.mc2-candidates').textContent.includes('尚无证据'));
  const counts = [...shadow.querySelectorAll('.mc2-cell')].map(el => Number(el.getAttribute('aria-label').match(/ (\d+) 条记录$/)[1]));
  check('Heatmap accounts for every real record', counts.reduce((a, b) => a + b, 0) === 185147);
  const firstId = rows()[0].textContent;
  await click(buttons('下一页').at(-1));
  await wait(() => rows().length === 40 && listScope().includes('第 2 页'));
  check('Record paging changes the actual records', rows()[0].textContent !== firstId);
  await click(buttons('上一页').at(-1));
  await wait(() => rows()[0]?.textContent === firstId);
  check('Previous page restores original ordered records', true);

  const source = shadow.querySelector('.mc2-node.file'); source.focus();
  await click(source);
  await wait(() => shadow.querySelector('.mc2-reader-body')?.textContent.includes('全历史：3 条记录'));
  check('File reader separates global totals from filtered track', shadow.querySelector('.mc2-reader-body').textContent.includes('当前筛选内的文件轨迹 · 3 条'));
  const post = [...shadow.querySelectorAll('.mc2-reader .mc2-record')].find(el => el.textContent.includes('MC2:event:373902'));
  shadow.querySelector('.mc2-reader-body').scrollTop = 120;
  await click(post);
  await wait(() => shadow.querySelector('.mc2-fields')?.textContent.includes('SwiftWren.txt'));
  check('Source file → post reads recorded fields without invented body', shadow.querySelector('.mc2-reader-body').textContent.includes('未提供可直接阅读的正文'));
  await click(buttons('← 返回上次阅读')[0]);
  await wait(() => shadow.querySelector('.mc2-reader-body')?.textContent.includes('全历史：3 条记录'));
  check('Reader back restores previous file and scroll position', shadow.querySelector('.mc2-reader-body').scrollTop === 120);
  await act(async () => shadow.querySelector('.mc2-reader').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  check('Escape closes reader, restores focus and unlocks page', !shadow.querySelector('.mc2-reader') && shadow.activeElement === source && document.body.style.overflow === '');

  const cells = [...shadow.querySelectorAll('.mc2-cell')];
  const cell = cells.find(el => el.getAttribute('aria-label').startsWith('公开发布 2046-05-17'));
  const count = Number(cell.getAttribute('aria-label').match(/ (\d+) 条记录$/)[1]);
  await click(cell);
  await wait(() => listScope().includes(`匹配 ${count.toLocaleString('zh-CN')} 条`));
  check('Heatmap selection and list use identical category and time scope', shadow.querySelector('[data-testid="mc2-list-scope"]').textContent.includes('公开发布') && cell.getAttribute('aria-pressed') === 'true');
  check('Cell selection leaves overview counts and source layout unchanged', shadow.querySelector('.mc2-activity-card').textContent.includes('185,147') && shadow.querySelectorAll('.mc2-operation').length === 2);
  const selectedPost = rows().find(el => el.textContent.includes('MC2:event:373902'));
  await click(selectedPost);
  await wait(() => shadow.querySelector('.mc2-link-row')?.textContent.includes('SwiftWren.txt'));
  await click(shadow.querySelector('.mc2-link-row'));
  await wait(() => shadow.querySelector('.mc2-reader-body')?.textContent.includes('当前筛选内的文件轨迹 · 1 条'));
  check('Drilling from a selected cell keeps its category and time in file tracks', shadow.querySelector('.mc2-reader-scope').textContent.includes('2046-05-17 00:00:00') && shadow.querySelector('.mc2-reader-body').textContent.includes('全历史：3 条记录'));
  await click(buttons('关闭 · Esc')[0]);
  const cell2 = cells.find(el => el !== cell && / [1-9]\d* 条记录$/.test(el.getAttribute('aria-label')));
  holdEvents = true;
  await click(cell2);
  await wait(() => delayed.length === 1);
  holdEvents = false;
  await click(cell);
  await wait(() => listScope().includes(`匹配 ${count.toLocaleString('zh-CN')} 条`));
  await act(async () => delayed.splice(0).forEach(resolve => resolve()));
  await wait(() => rows().length > 0);
  check('Slow previous selection cannot overwrite latest record scope', listScope().includes(`匹配 ${count.toLocaleString('zh-CN')} 条`) && shadow.querySelector('[data-testid="mc2-list-scope"]').textContent.includes('公开发布'));
  await click(buttons('清除格子选择')[0]); await wait(ready);

  await change('[aria-label="记录关键词"]', 'mc2-no-such-text-998877');
  await submit('.mc2-filter-form');
  await wait(() => listScope().includes('匹配 0 条') && !shadow.querySelector('.mc2-activity-card [role="status"]').textContent);
  check('Empty search shows zero results and recovery, not stale records', rows().length === 0 && shadow.querySelector('.mc2-record-list').textContent.includes('没有符合条件'));
  await click(buttons('清空全部筛选')[0]); await wait(ready);
  await change('[aria-label="开始时间 UTC"]', '2046-06-01T00:00:00');
  await change('[aria-label="结束时间 UTC"]', '2046-05-01T00:00:00');
  const before = requests.length;
  await submit('.mc2-filter-form');
  check('Invalid time window is rejected locally without replacing results', shadow.querySelector('.mc2-filter-form [role="alert"]') && requests.length === before && ready());
  await change('[aria-label="结束时间 UTC"]', '');
  await submit('.mc2-filter-form');
  await wait(() => shadow.querySelector('.mc2-source-card').textContent.includes('root_outside_window'));
  check('Root outside selected window gets a time-specific recovery action', buttons('扩展时间范围，包含此发布锚点').length === 1);
  await click(buttons('扩展时间范围，包含此发布锚点')[0]);
  await wait(() => shadow.querySelector('.mc2-node.file'));
  check('Expanding time range recovers the source trace', !shadow.querySelector('.mc2-source-card').textContent.includes('root_outside_window'));
  await click(buttons('清空全部筛选')[0]); await wait(ready);
  await change('[aria-label="活动类别"]', '2'); await submit('.mc2-filter-form');
  await wait(() => rows().length > 0 && !listScope().includes('185,147') && shadow.querySelectorAll('.mc2-cell:disabled').length > 0);
  check('Category filter also prevents selecting incompatible heatmap rows', [...shadow.querySelectorAll('.mc2-cell:not(:disabled)')].every(el => el.getAttribute('aria-label').startsWith('公开发布')));
  await click(buttons('清空全部筛选')[0]); await wait(ready);
  await change('[aria-label="开始时间 UTC"]', '2046-05-17T00:00:00');
  await change('[aria-label="结束时间 UTC"]', '2046-05-18T00:00:00');
  await submit('.mc2-filter-form');
  await wait(() => shadow.querySelector('.mc2-node.file') && !listScope().includes('185,147') && rows().length > 0);
  await click(shadow.querySelector('.mc2-candidates button'));
  await wait(() => shadow.querySelector('.mc2-type-counts'));
  const expectedTrack = await (await realFetch(`${base}/api/file-track?dataset=MC2&file_id=${encodeURIComponent('MC2:file_path:SwiftWren_further_instructions.md')}&start_us=2410128000000000&end_us=2410214400000000&limit=40`)).json();
  check('Candidate track uses filtered counts, separate from its global hint', expectedTrack.meta.matched_events < expectedTrack.file.event_count && shadow.querySelector('.mc2-reader-body').textContent.includes(`当前筛选内的文件轨迹 · ${expectedTrack.meta.matched_events} 条`) && Number(shadow.querySelector('.mc2-type-counts b').textContent.replaceAll(',', '')) === Object.values(expectedTrack.event_type_counts)[0]);
  await click(buttons('关闭 · Esc')[0]);
  await click(buttons('清空全部筛选')[0]); await wait(ready);
  await change('[aria-label="文件名或路径"]', 'SwiftWren'); await submit('.mc2-file-search form');
  await wait(() => shadow.querySelectorAll('.mc2-file-results button').length === 2);
  check('File search keeps content and similarly named instruction file separate', shadow.querySelector('.mc2-file-results').textContent.includes('SwiftWren.txt') && shadow.querySelector('.mc2-file-results').textContent.includes('SwiftWren_further_instructions.md'));
  await change('[aria-label="发布锚点"]', 'MC2:event:98591');
  await wait(() => shadow.querySelector('.mc2-node.file')?.textContent.includes('MellowOtter.txt'));
  check('Switching root replaces the source trace with selected real file', !shadow.querySelector('.mc2-node.file').textContent.includes('SwiftWren'));
  await change('[aria-label="时间粒度"]', 'hour');
  await wait(() => shadow.querySelectorAll('.mc2-cell').length > cells.length);
  check('Hourly activity covers full time range rather than silently truncating', shadow.querySelectorAll('.mc2-cell').length > 10000);
  check('Old MC2 remains directly accessible', shadow.querySelector('a[href="?mc2=legacy"]'));
  await click(buttons('MC1')[0]);
  await wait(() => document.querySelector('[data-testid="mc1-reference"]')?.shadowRoot?.querySelectorAll('.cell').length === 161);
  check('New MC2 switches back to verified migrated MC1', window.location.search === '?mc1=reference');
  dom.window.history.replaceState(null, '', '?mc2=legacy');
  await act(async () => root.render(React.createElement(module.exports.default, { key: 'legacy' })));
  await wait(() => document.querySelector('[data-testid="mc2-page"]'));
  check('Legacy MC2 remains functional with a return link', !document.querySelector('[data-testid="mc2-reference"]') && document.querySelector('a[href="?mc2=reference"]'));
  console.log(JSON.stringify({ passed: checks.length, limitation: 'Virtual DOM checks do not measure native scrolling, visual layout or browser rendering.' }, null, 2));
} finally {
  await act(async () => root.unmount());
  dom.window.close();
}
process.exit(0);
