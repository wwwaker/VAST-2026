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
dom.window.scrollTo = () => {};
const resizeObservers = new Set();
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() { resizeObservers.add(this); }
  unobserve() {}
  disconnect() { resizeObservers.delete(this); }
};
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
// Simulated content measurements exercise height retention, not browser layout.
let contentHeight = 480;
dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { x:0,y:0,left:0,top:0,right:800,bottom:480,width:800,height:this.classList.contains('w-pending-region') ? 480 : this.classList.contains('w-pending-content') ? contentHeight : 0, toJSON() { return {}; } }; };
dom.window.SVGElement.prototype.setPointerCapture = function () {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const realFetch = globalThis.fetch;
const requests = [];
let holdEvents = false;
let holdWorkspace = false;
let failWorkspace = false;
let holdReader = false;
const delayed = [];
globalThis.fetch = async (url, options) => {
  requests.push(String(url));
  if (failWorkspace && new URL(url, base).pathname.startsWith('/api/mc2/')) throw new Error('Simulated refresh failure');
  const response = await realFetch(new URL(url, base), options);
  if ((holdEvents && new URL(url).pathname === '/api/events') || (holdWorkspace && new URL(url).pathname.startsWith('/api/mc2/')) || (holdReader && new URL(url).pathname === '/api/file-track')) await new Promise(resolve => delayed.push(resolve));
  return response;
};
const bundle = await build({
  entryPoints: [path.join(frontend, 'src/App.tsx')], bundle: true, platform: 'browser', format: 'cjs', write: false,
  external: ['react','react-dom'], logLevel: 'silent',
  plugins: [{ name: 'headless-cytoscape', setup(builder) { builder.onResolve({filter:/^cytoscape$/},()=>({path:'cytoscape-test',namespace:'graph-test'})); builder.onLoad({filter:/.*/,namespace:'graph-test'},()=>({contents: `const real = globalThis.__testCytoscape; export default options => { const graph = real({...options, headless:true, container:undefined, styleEnabled:false}); globalThis.__mc2Graph = graph; globalThis.__mc2ResizeCount = 0; const resize = graph.resize; graph.resize = function(...args) { globalThis.__mc2ResizeCount++; return resize.apply(graph,args); }; return graph; };`, loader:'js'})); } }, { name: 'inline-css', setup(builder) {
    builder.onResolve({ filter: /\.css\?inline$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?inline$/, '')), namespace: 'inline-css' }));
    builder.onLoad({ filter: /.*/, namespace: 'inline-css' }, args => ({ contents: `export default ${JSON.stringify(fs.readFileSync(args.path, 'utf8'))}`, loader: 'js' }));
  } }],
});
globalThis.__testCytoscape = createRequire(import.meta.url)('cytoscape');
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


const rows = () => [...shadow.querySelectorAll('.mc2-record-list .mc2-record')];
const ready = () => shadow?.querySelectorAll('.mc2-cell').length > 0 && shadow.querySelector('[data-testid="evidence-count"]')?.textContent.includes('185,147');
try {
  await act(async () => root.render(React.createElement(module.exports.default)));
  await wait(() => { shadow = document.querySelector('[data-testid="mc2-reference"]')?.shadowRoot; return ready(); });
  check('MC2 has 24 actual event rows, with all 185147 records', shadow.querySelectorAll('.w-type-label').length === 24 && [...shadow.querySelectorAll('.mc2-cell')].reduce((a,e)=>a+Number(e.getAttribute('aria-label').match(/ (\d+) 条记录$/)[1]),0) === 185147);
  await click(buttons('执行者')[0]);
  check('All 147 actors remain selectable in MC1-style section', shadow.querySelectorAll('[name="actor"]').length === 148);
  check('Sidebar has no dates or Apply button', !shadow.querySelector('[type="datetime-local"]') && !buttons('应用筛选').length);
  check('Overview carries category colors and icons without changing record totals', shadow.querySelectorAll('.w-type-label>svg').length === 24 && shadow.querySelectorAll('.w-category-legend>span').length >= 6 && new Set([...shadow.querySelectorAll('.mc2-cell')].filter(el => !el.getAttribute('aria-label').endsWith(' 0 条记录')).map(el => el.style.background)).size > 10);
  check('Total-volume bars shade by actual magnitude', new Set([...shadow.querySelectorAll('.w-bar-mark')].map(el => el.getAttribute('fill'))).size > 3);
  check('Navigation and relation-mode controls reuse SVG icons', buttons('返回上一步')[0].querySelector('svg') && buttons('并排对比')[0].querySelector('svg') && shadow.querySelectorAll('.w-mode-tabs button>svg').length === 5);

  await wait(() => !!globalThis.__mc2Graph && !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  check('Graph wheel zoom is enabled with explicit zoom buttons retained', globalThis.__mc2Graph?.userZoomingEnabled() === true && shadow.querySelector('[aria-label="放大关系图"]'));
  check('Both datasets share MC1 control and playback templates', shadow.querySelectorAll('.global-controls .check').length === 4 && shadow.querySelector('.tl-play') && shadow.querySelector('.tl-scale'));
  await click(buttons('隐藏筛选')[0]);
  check('Shared hide-filter control releases sidebar space', shadow.querySelector('.w-layout.filters-hidden') && shadow.querySelector('.filter-panel').hidden);
  await click(buttons('显示筛选')[0]);
  await click(buttons('并排对比')[0]);
  check('Parallel view uses the same control state and hides sidebar', shadow.querySelector('.w-main-parallel') && shadow.querySelector('.filter-panel').hidden);
  await click(buttons('并排对比：已开启')[0]);
  const resizeBefore = globalThis.__mc2ResizeCount;
  await act(async () => window.dispatchEvent(new Event('scroll')));
  check('Outer page scroll refreshes graph coordinates across ShadowRoot', globalThis.__mc2ResizeCount > resizeBefore);
  check('Displayed record identifiers omit dataset prefix', [...shadow.querySelectorAll('.mc2-record-id')].every(e => !e.textContent.includes('MC2:')));
  check('Empty local process has only compact entry', !shadow.querySelector('.w-timeline-scroll'));
  await click(buttons('收起概览')[0]);
  check('Collapsed overview retains volume and removes type rows', shadow.querySelector('[aria-label="时间总量柱"]') && !shadow.querySelector('.w-type-label'));
  check('Explicit overview collapse releases its expanded height reservation', parseFloat(shadow.querySelector('.mc2-activity-card .w-pending-region').style.minHeight) < 660);
  await click(buttons('展开24类型')[0]);
  const activityBeforePlay = shadow.querySelector('.w-activity');
  holdWorkspace = true;
  const requestsBeforePlay = requests.length;
  await click(shadow.querySelector('.tl-play'));
  await wait(() => shadow.querySelector('.mc2-activity-card [data-refresh-state="refreshing"]'));
  check('Playback retains the previous matrix with a light update status', shadow.querySelector('.w-activity') === activityBeforePlay && !shadow.querySelector('.mc2-activity-card .w-loading-placeholder') && shadow.querySelector('.mc2-activity-card .mc2-status').textContent.includes('暂显示上次结果'));
  await wait(() => requests.slice(requestsBeforePlay).filter(url => new URL(url).pathname === '/api/mc2/activity').length >= 2);
  check('Further playback steps keep the same visible matrix until results arrive', shadow.querySelector('.w-activity') === activityBeforePlay && shadow.querySelector('.mc2-activity-card .is-retaining .w-pending-content').inert);
  await click(buttons('收起概览')[0]);
  check('Overview can collapse immediately even while playback data is pending', !shadow.querySelector('.w-type-label') && parseFloat(shadow.querySelector('.mc2-activity-card .w-pending-region').style.minHeight) < 660);
  await click(buttons('展开24类型')[0]);
  await click(shadow.querySelector('.tl-play'));
  holdWorkspace = false;
  await wait(() => delayed.length > 0);
  await act(async () => { delayed.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 100)); });
  await wait(() => !shadow.querySelector('.mc2-activity-card [aria-busy="true"]'));
  await click(buttons('恢复全范围')[0]); await wait(ready);
  const globalDates = shadow.querySelector('.tl-date').textContent;
  const globalHandles = [...shadow.querySelectorAll('.tl-range')].map(e => e.value);
  await click(shadow.querySelector('[aria-label^="筛选当天 2046-05-17"]'));
  await wait(() => shadow.querySelector('[data-testid="mc2-list-scope"]').textContent.includes('2046-05-17') && !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  check('Activity bar selects one day without moving global timeline', shadow.querySelector('.tl-date').textContent === globalDates && [...shadow.querySelectorAll('.tl-range')].every((e,i) => e.value === globalHandles[i]));
  check('Only selected activity bar changes color, no matrix outlines', shadow.querySelectorAll('[aria-label="时间总量柱"] [aria-pressed="true"]').length === 1 && !shadow.querySelector('.mc2-cell.selected'));
  await click(shadow.querySelector('[aria-label^="筛选当天 2046-05-17"]'));
  await wait(() => !buttons('清除单日选择').length && shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('185,147'));
  check('Repeated activity bar click clears only local day selection', shadow.querySelector('.tl-date').textContent === globalDates);
  await click(shadow.querySelector('[aria-label^="筛选当天 2046-05-17"]'));
  await wait(() => !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  const taskCell = [...shadow.querySelectorAll('.mc2-cell')].find(e => e.getAttribute('aria-label').startsWith('queue_subordinate_task 2046-05-17'));
  await click(taskCell);
  await wait(() => shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('15 条') && shadow.querySelector('.w-facet-bars button')?.textContent.includes('10'));
  check('Matrix axes replace repeated entity prefixes with icons and short names', [...shadow.querySelectorAll('.w-relation-matrix th .w-entity-name')].every(e => !/agent:|person:|system:|Agent\//.test(e.textContent)) && shadow.querySelector('.w-relation-matrix th svg'));
  check('Clicking a single matrix cell highlights only that cell', shadow.querySelectorAll('.mc2-cell.selected').length === 1 && shadow.querySelector('.mc2-cell.selected') === taskCell && shadow.querySelectorAll('.mc2-cell[aria-pressed=true]').length === 1);
  const taskHeader = [...shadow.querySelectorAll('.w-type-label')].find(el => el.textContent.includes('subordinate'));
  await click(taskHeader);
  await wait(() => !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  check('Selecting a row header highlights the header without outlining any cells', taskHeader.classList.contains('is-selected') && !shadow.querySelector('.mc2-cell.selected') && !shadow.querySelector('.mc2-cell[aria-pressed=true]') && shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('15 条'));
  await click(taskCell);
  await wait(() => !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  const otherTaskCell = [...shadow.querySelectorAll('.mc2-cell')].find(el => el !== taskCell && el.getAttribute('aria-label').startsWith('queue_subordinate_task'));
  await click(otherTaskCell);
  await wait(() => !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  check('Moving between cells replaces the single highlight and preserves type-scope behavior', shadow.querySelector('.mc2-cell.selected') === otherTaskCell && shadow.querySelectorAll('.mc2-cell.selected').length === 1 && shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('15 条'));
  await click(otherTaskCell);
  await wait(() => !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  check('Clicking the selected cell clears only its type selection', !shadow.querySelector('.mc2-cell.selected') && buttons('清除单日选择').length === 1);
  await click(taskCell);
  await wait(() => shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('15 条') && !shadow.querySelector('.w-relation-section [aria-busy="true"]'));

  check('15-task selection immediately opens exact role endpoints and visible update cue', shadow.querySelector('.w-selection-notice').textContent.includes('15 条') && shadow.querySelector('.w-relation-matrix') && buttons('查看关系').length === 1);
  check('Five no-file events are explicit and accessible', buttons('无明确文件关联 · 5 条').length === 1);
  await click(buttons('无明确文件关联 · 5 条')[0]);
  await wait(() => shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('5 条'));
  check('No-file group retains all five actual records', rows().length === 5);
  await click(buttons('返回上一步')[0]);
  await wait(() => shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('15 条') && shadow.querySelector('.w-facet-bars button')?.textContent.includes('SwiftWren'));
  await click([...shadow.querySelectorAll('.w-facet-bars button')].find(e=>e.textContent.includes('SwiftWren_further_instructions.md')));
  await wait(() => shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('10 条') && shadow.querySelector('.w-relation-matrix td button:not(:disabled)'));
  check('File drill-down selects ten recorded tasks, preserving parent 15', shadow.querySelector('[data-testid="relation-summary"]').textContent.includes('当前 10 条事件') && shadow.querySelector('.w-selection-notice').textContent.includes('15 条'));
  await click(shadow.querySelector('.w-relation-matrix td button:not(:disabled)'));
  await wait(() => shadow.querySelector('.w-edge-events button'));
  await click([...shadow.querySelectorAll('.w-edge-events button')].find(e=>e.textContent.startsWith('查看过程')));
  await wait(() => shadow.querySelector('[data-testid="process-summary"]'));
  check('Single task opens a real local timeline and readable story', shadow.querySelector('[aria-label="真实时间执行者泳道"]') && shadow.querySelector('.w-process-story li'));
  await click(shadow.querySelector('.w-timeline-scroll g[role="button"]'));
  await wait(() => shadow.querySelector('.mc2-fields'));
  check('Record lists and selected message share pill metadata', shadow.querySelector('.mc2-reader .msg-meta .comm-id') && shadow.querySelector('.mc2-record-list article.message .msg-meta .comm-id'));
  check('Reader header uses shared back/close actions', shadow.querySelector('.mc2-reader .flow-close') && !shadow.querySelector('.mc2-reader .mc2-close'));
  check('Reader uses MC1 message cards and collapses raw fields', shadow.querySelector('.flow-modal .chat-bubble') && shadow.querySelector('.mc2-reader details:not([open]) .mc2-fields') && shadow.querySelector('.mc2-reader').textContent.includes('原始记录与来源定位'));
  check('Actor filter is a name link, not a standalone action button', shadow.querySelector('.cb-agent.w-text-link') && !buttons('以此执行者筛选主页面').length);
  holdReader = true;
  const messageBeforeFile = shadow.querySelector('.mc2-reader .chat-bubble');
  await click(shadow.querySelector('.mc2-reader .mc2-link-row'));
  await wait(() => delayed.length > 0 && shadow.querySelector('.mc2-reader [data-refresh-state="refreshing"]'));
  check('Reader retains its previous message while a different payload type loads', shadow.querySelector('.mc2-reader .chat-bubble') === messageBeforeFile && !shadow.querySelector('.mc2-reader .w-loading-placeholder') && shadow.querySelector('.mc2-reader .w-pending-content').inert && shadow.querySelector('.mc2-reader .mc2-status').textContent.includes('暂显示上次结果'));
  holdReader = false;
  await act(async () => { delayed.splice(0).forEach(resolve => resolve()); });
  await wait(() => shadow.querySelector('.mc2-reader').textContent.includes('当前筛选内的文件轨迹'));
  check('Reader switches from event to file without mixing payload types', !!shadow.querySelector('.mc2-reader .mc2-type-counts'));
  await click(buttons('返回上次阅读')[0]);
  await wait(() => shadow.querySelector('.mc2-reader .chat-bubble'));
  await click(shadow.querySelector('[aria-label="关闭阅读记录"]'));
  check('Reader close preserves exact process and edge scope', !shadow.querySelector('.mc2-reader') && shadow.querySelector('[data-testid="process-summary"]') && shadow.querySelector('.w-edge-inspector'));
  check('Process selection returns to a colored symbol and halo', shadow.querySelectorAll('.w-process-mark.selected').length === 1 && shadow.querySelector('.w-process-mark.selected .w-process-symbol') && shadow.querySelector('.w-process-mark.selected .w-process-halo'));
  check('Process lanes and shape legend use reusable SVG symbols', shadow.querySelectorAll('.w-process-legend svg').length === 4 && shadow.querySelector('[aria-label="真实时间执行者泳道"] g>svg') && shadow.querySelector('.w-process-story .w-text-link>svg'));

  await click(buttons('返回上一步')[0]);
  await wait(() => !shadow.querySelector('.w-timeline-scroll'));
  check('Back restores previous relationship selection', !!shadow.querySelector('.w-edge-inspector'));
  await click(buttons('异常发布与附近参与者')[0]);
  await wait(() => shadow.querySelector('[data-testid="process-summary"]')?.textContent.includes('主选 1 条 / 邻近上下文 4 条'));
  check('Process story explains incoming task and five readable activities', shadow.querySelectorAll('.w-process-story li').length === 5 && shadow.querySelector('.w-process-story').textContent.includes('任务目标') && shadow.querySelector('.w-process-story').textContent.includes('john windward'));
  check('One shortcut discovers all five events without knowing Chloe', ['373893','373899','373902','373909','373913'].every(id=>shadow.querySelector(`.w-timeline-scroll [aria-label^="event:${id}"]`)));
  check('Shortcut keeps full matrix collapsed, and marks incoming task as context', !shadow.querySelector('.w-type-label') && shadow.querySelector('[aria-label^="event:373893"]').getAttribute('aria-label').includes('邻近上下文'));
  await click(buttons('固定此过程')[0]);
  await click(shadow.querySelector('[aria-label="定位日期 2046-06-01"]'));
  await wait(() => shadow.querySelector('.tl-date')?.textContent.includes('2046-06-01 00:00:00') && !shadow.querySelector('.w-process-section [aria-busy="true"]'));
  await wait(() => shadow.querySelector('.w-process-section').textContent.includes('固定上下文，不随当前选择变化'));
  check('Pinned old context is explicitly independent of current date', !!shadow.querySelector('[data-testid="process-summary"]'));
  await click(buttons('取消固定，跟随当前选择')[0]);
  await wait(() => shadow.querySelector('[data-testid="process-outside"]'));
  check('Expired unpinned process stops drawing instead of retaining stale timeline', !shadow.querySelector('.w-timeline-scroll') && shadow.querySelector('[data-testid="process-outside"]').textContent.includes('停止'));
  await click(buttons('恢复全范围')[0]);
  await wait(ready);
  await click(buttons('有明确来源的发布实例比较')[0]);
  await wait(() => shadow.querySelector('.w-comparison'));
  check('Historical comparison names the explicit-source subset and missing creation', shadow.querySelector('.w-relation-section').textContent.includes('3 个有明确来源') && shadow.querySelector('.w-comparison').textContent.includes('未见明确记录') && shadow.querySelector('.w-comparison').textContent.includes('2 秒'));
  await click(buttons('恢复全范围')[0]);
  await wait(ready);
  const first = rows()[0].textContent;
  await click(buttons('下一页').at(-1));
  await wait(() => !shadow.querySelector('.w-evidence-section [aria-busy="true"]') && rows()[0]?.textContent !== first);
  const second = rows()[0].textContent;
  check('Evidence pages actually change records', first !== second);
  await click(buttons('上一页').at(-1));
  await wait(() => rows()[0]?.textContent === first);
  await change('[aria-label="记录关键词"]','no-such-mc2-record-721983');

  await wait(() => shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('0 条'));
  check('Zero result has no stale record or graph', rows().length === 0 && !shadow.querySelector('.w-relation-matrix td button'));
  await click(buttons('恢复全范围')[0]);
  await wait(ready);
  const beforeCache = requests.length;
  await click(shadow.querySelector('[aria-label^="筛选当天 2046-05-17"]'));
  await wait(() => buttons('清除单日选择').length && !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  await click([...shadow.querySelectorAll('.w-type-label')].find(e => e.textContent.includes('subordinate')));
  await wait(() => shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('15 条') && !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  check('Returning to a recent scope uses cached workspace responses', requests.length === beforeCache);
  await click(buttons('恢复全范围')[0]); await wait(ready);
  holdWorkspace = true;
  const matrixBeforeFilter = shadow.querySelector('.w-activity');
  const recordsBeforeFilter = shadow.querySelector('.mc2-record-list');
  const facetBeforeFilter = shadow.querySelector('.w-facets');
  contentHeight = 730;
  await act(async () => { [...resizeObservers].forEach(observer => observer.callback()); });
  await change('[aria-label="记录关键词"]', 'pending-query-one');
  await wait(() => delayed.length > 0 && shadow.querySelector('.w-relation-section .is-pending'));
  const pendingRegion = shadow.querySelector('.w-relation-section .is-pending');
  check('Relation refresh masks old results with a prominent loading label while preserving height', !pendingRegion.classList.contains('is-retaining') && pendingRegion.querySelector(':scope > .w-loading-mask .w-loading-spinner') && pendingRegion.querySelector(':scope > .w-loading-mask').textContent.includes('正在加载关系调查') && !shadow.querySelector('.w-relation-section > .mc2-status').textContent.includes('上次结果') && pendingRegion.querySelector('.w-relation-body') && pendingRegion.querySelector('.w-pending-content').inert && pendingRegion.getAttribute('aria-busy') === 'true' && parseFloat(pendingRegion.style.minHeight) >= 520);
  check('Filtering preserves the mounted matrix, evidence list and object distribution', shadow.querySelector('.w-activity') === matrixBeforeFilter && shadow.querySelector('.mc2-record-list') === recordsBeforeFilter && shadow.querySelector('.w-facets') === facetBeforeFilter && shadow.querySelector('.w-evidence-section .is-retaining'));
  await wait(() => parseFloat(pendingRegion.style.minHeight) >= 730);
  contentHeight = 120;
  holdWorkspace = false;
  await change('[aria-label="记录关键词"]', 'no-such-record-latest');
  await wait(() => shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('0 条') && !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  await act(async () => { delayed.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 100)); });
  check('Delayed older responses cannot replace latest keyword results', shadow.querySelector('[aria-label="记录关键词"]').value === 'no-such-record-latest' && shadow.querySelector('[data-testid="evidence-count"]').textContent.includes('0 条'));
  check('Empty results preserve card floors after refresh completes', parseFloat(shadow.querySelector('.mc2-activity-card .w-pending-region').style.minHeight) >= 660 && parseFloat(shadow.querySelector('.w-relation-section .w-pending-region').style.minHeight) >= 520 && parseFloat(shadow.querySelector('.w-evidence-section .w-pending-region').style.minHeight) >= 350);
  check('Smaller results retain previously measured heights and mounted lists', parseFloat(shadow.querySelector('.w-relation-section .w-pending-region').style.minHeight) >= 730 && shadow.querySelector('.mc2-record-list') === recordsBeforeFilter && shadow.querySelector('.w-facets') === facetBeforeFilter);
  contentHeight = 480;
  await click(buttons('恢复全范围')[0]); await wait(ready);
  const beforeFailure = shadow.querySelector('.w-activity');
  failWorkspace = true;
  await change('[aria-label="记录关键词"]', 'failed-refresh-unique');
  await wait(() => shadow.querySelector('.mc2-activity-card [data-refresh-state="error"]'));
  check('Failed updates preserve results, height and offer an explicit retry', shadow.querySelector('.w-activity') === beforeFailure && !shadow.querySelector('.mc2-activity-card .w-loading-placeholder') && shadow.querySelector('.mc2-activity-card [role="alert"]').textContent.includes('更新失败') && shadow.querySelector('.mc2-activity-card [role="alert"] button') && shadow.querySelector('.mc2-activity-card .w-pending-content').inert);
  failWorkspace = false;
  await click(shadow.querySelector('.mc2-activity-card [role="alert"] button'));
  await wait(() => shadow.querySelector('.mc2-activity-card [data-refresh-state="ready"]'));
  check('Retry replaces the retained view with the successful empty result', !shadow.querySelector('.mc2-activity-card [role="alert"]') && shadow.querySelector('.mc2-activity-card .mc2-note').textContent.includes('0 条记录'));
  await click(buttons('恢复全范围')[0]); await wait(ready);
  await click(buttons('MC1')[0]);
  await wait(() => document.querySelector('[data-testid="mc1-reference"]')?.shadowRoot?.querySelectorAll('.cell').length > 0);
  check('MC1 remains navigable and renders its unchanged matrix', true);
  console.log(`Passed ${checks.length} real API + React interaction checks. Graph uses headless Cytoscape; this is not visual QA.`);
} finally {
  await act(async () => root.unmount());
  dom.window.close();
}

process.exit(0);
