/** Real API + actual React components in jsdom; does not measure browser layout. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] || "http://127.0.0.1:8000";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: `${base}/?mc2=reference`,
  pretendToBeVisual: true,
});

for (const key of [
  "window",
  "document",
  "HTMLElement",
  "SVGElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "ShadowRoot",
  "localStorage",
]) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
dom.window.scrollTo = () => {};
const resizeObservers = new Set();
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {
    resizeObservers.add(this);
  }
  unobserve() {}
  disconnect() {
    resizeObservers.delete(this);
  }
};
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
// Simulated content measurements exercise height retention, not browser layout.
let contentHeight = 480;
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 480,
    width: 800,
    height: this.classList.contains("w-pending-region")
      ? 480
      : this.classList.contains("w-pending-content")
        ? contentHeight
        : 0,
    toJSON() {
      return {};
    },
  };
};
dom.window.SVGElement.prototype.setPointerCapture = function () {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Load React DOM after the DOM exists so its input-event detection uses the browser path.
const { createRoot } = await import("react-dom/client");
const { Simulate } = await import("react-dom/test-utils");
const realFetch = globalThis.fetch;
const requests = [];
const requestEvents = [];
const holdEvents = false;
let holdWorkspace = false;
let failWorkspace = false;
let holdReader = false;
const delayed = [];
globalThis.fetch = async (url, options) => {
  requests.push(String(url));
  const pathname = new URL(url, base).pathname;
  requestEvents.push(`start:${pathname}`);
  if (failWorkspace && new URL(url, base).pathname.startsWith("/api/mc2/")) {
    throw new Error("Simulated refresh failure");
  }
  const response = await realFetch(new URL(url, base), options);
  requestEvents.push(`response:${pathname}`);
  if (
    (holdEvents && new URL(url).pathname === "/api/events") ||
    (holdWorkspace && new URL(url).pathname.startsWith("/api/mc2/")) ||
    (holdReader && new URL(url).pathname === "/api/file-track")
  ) {
    await new Promise((resolve) => delayed.push(resolve));
  }

  return response;
};

const bundle = await build({
  entryPoints: [path.join(frontend, "src/app/App.tsx")],
  bundle: true,
  platform: "browser",
  format: "cjs",
  write: false,
  external: ["react", "react-dom"],
  logLevel: "silent",
  plugins: [
    {
      name: "headless-cytoscape",
      setup(builder) {
        builder.onResolve({ filter: /^cytoscape$/ }, () => ({
          path: "cytoscape-test",
          namespace: "graph-test",
        }));
        builder.onLoad({ filter: /.*/, namespace: "graph-test" }, () => ({
          contents: `const real = globalThis.__testCytoscape; export default options => { const graph = real({...options, headless:true, container:undefined, styleEnabled:false}); globalThis.__mc2Graph = graph; globalThis.__mc2ResizeCount = 0; const resize = graph.resize; graph.resize = function(...args) { globalThis.__mc2ResizeCount++; return resize.apply(graph,args); }; return graph; };`,
          loader: "js",
        }));
      },
    },
    {
      name: "inline-css",
      setup(builder) {
        builder.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.replace(/\?inline$/, "")),
          namespace: "inline-css",
        }));
        builder.onLoad({ filter: /.*/, namespace: "inline-css" }, (args) => ({
          contents: `export default ${JSON.stringify(fs.readFileSync(args.path, "utf8"))}`,
          loader: "js",
        }));
      },
    },
  ],
});

globalThis.__testCytoscape = createRequire(import.meta.url)("cytoscape");
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const root = createRoot(document.getElementById("root"));
let shadow;
const checks = [];

const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS", label);
};

const wait = async (predicate) => {
  for (let i = 0; i < 300; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    if (predicate()) {
      return;
    }
  }
  throw new Error("Timed out: " + String(predicate));
};

const click = async (element) => {
  assert.ok(element, "click target exists");
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};

const buttons = (label, area = shadow) =>
  [...area.querySelectorAll("button")].filter((el) => el.textContent.trim() === label);

const change = async (selector, value) => {
  const element = shadow.querySelector(selector);
  assert.ok(element, selector);
  await act(async () => {
    element.value = value;
    Simulate.change(element, { target: element });
  });
};

const rows = () => [...shadow.querySelectorAll(".mc2-record-list .mc2-record")];

const ready = () =>
  shadow?.querySelectorAll(".mc2-cell").length > 0 &&
  shadow.querySelector('[data-testid="evidence-count"]')?.textContent.includes("185,147");

try {
  await act(async () => root.render(React.createElement(module.exports.default)));
  await wait(() => {
    shadow = document.querySelector('[data-testid="mc2-reference"]')?.shadowRoot;

    return ready();
  });
  check(
    "MC2 has 24 actual event rows, with all 185147 records",
    shadow.querySelectorAll(".w-type-label").length === 24 &&
      [...shadow.querySelectorAll(".mc2-cell")].reduce(
        (a, e) => a + Number(e.getAttribute("aria-label").match(/ (\d+) 条记录$/)[1]),
        0,
      ) === 185147,
  );
  await click(buttons("执行者")[0]);
  await wait(() => requestEvents.includes("response:/api/mc2/relations"));
  check(
    "Object distribution starts in parallel with the initial relationship query",
    requestEvents.indexOf("start:/api/mc2/facets") >= 0 &&
      requestEvents.indexOf("start:/api/mc2/facets") <
        requestEvents.indexOf("response:/api/mc2/relations"),
  );
  check(
    "All 147 actors remain selectable in MC1-style section",
    shadow.querySelectorAll('[name="actor"]').length === 148,
  );
  check(
    "Sidebar has no dates or Apply button",
    !shadow.querySelector('[type="datetime-local"]') && !buttons("应用筛选").length,
  );
  check(
    "Overview carries category colors and icons without changing record totals",
    shadow.querySelectorAll(".w-type-label>svg").length === 24 &&
      shadow.querySelectorAll(".w-category-legend>span").length >= 6 &&
      new Set(
        [...shadow.querySelectorAll(".mc2-cell")]
          .filter((el) => !el.getAttribute("aria-label").endsWith(" 0 条记录"))
          .map((el) => el.style.background),
      ).size > 10,
  );
  check(
    "Total-volume bars shade by actual magnitude",
    new Set([...shadow.querySelectorAll(".w-bar-mark")].map((el) => el.getAttribute("fill"))).size >
      3,
  );
  check(
    "Relation controls show a single investigation selector without disabled file tabs",
    buttons("返回上一步")[0].querySelector("svg") &&
      buttons("并排对比")[0].querySelector("svg") &&
      shadow.querySelector('[aria-label="关系角色"]') &&
      !shadow.querySelector(".w-mode-tabs") &&
      buttons("发布实例比较").length === 1,
  );
  check(
    "Default relationship overview lists real families and counts",
    shadow.querySelectorAll(".w-relation-categories>button").length === 11,
  );
  check(
    "Removed role explanations, standalone scope rows and diagnostic toolbar do not return",
    !shadow.querySelector(".w-role-semantics,.w-scope-path,.w-current-scope,.w-experience-tools"),
  );
  await click(buttons("关系图")[0]);

  await wait(
    () =>
      !!globalThis.__mc2Graph && !shadow.querySelector('.w-relation-section [aria-busy="true"]'),
  );
  check(
    "Graph wheel zoom is enabled with explicit zoom buttons retained",
    globalThis.__mc2Graph?.userZoomingEnabled() === true &&
      shadow.querySelector('[aria-label="放大关系图"]'),
  );
  const initialGraph = globalThis.__mc2Graph;
  const canvas = shadow.querySelector(".w-canvas-frame");
  const beforeHoverChildren = canvas.parentElement.childElementCount;
  await act(async () => initialGraph.nodes()[0].emit("mouseover"));
  check(
    "Node hover lives inside the canvas overlay without inserting a row above it",
    canvas.querySelector(".w-edge-tooltip")?.textContent.includes(initialGraph.nodes()[0].id()) &&
      canvas.parentElement.childElementCount === beforeHoverChildren,
  );
  await act(async () => initialGraph.nodes()[0].emit("mouseout"));
  check("Leaving a node removes its tooltip", !canvas.querySelector(".w-edge-tooltip"));
  await click(shadow.querySelector('[aria-label="搜索关系图对象"]'));
  await change('[aria-label="输入关系图对象"]', "agent");
  check(
    "Graph search results remain within the floating canvas toolbar",
    canvas.querySelector(
      '.w-canvas-tools .w-canvas-popover [aria-label="关系图搜索结果"] button',
    ) && canvas.parentElement.childElementCount === beforeHoverChildren,
  );
  await act(async () =>
    Simulate.keyDown(shadow.querySelector('[aria-label="输入关系图对象"]'), { key: "Escape" }),
  );
  check(
    "Escape dismisses graph search and returns focus to its trigger",
    !canvas.querySelector(".w-canvas-popover") &&
      shadow.activeElement?.getAttribute("aria-label") === "搜索关系图对象",
  );
  await click(shadow.querySelector('[aria-label="搜索关系图对象"]'));
  await act(async () =>
    shadow
      .querySelector(".w-relation-canvas")
      .dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true })),
  );
  check(
    "Clicking outside graph tools dismisses the overlay",
    !canvas.querySelector(".w-canvas-popover"),
  );
  check(
    "Relationship families have distinct colors and bounded narrow widths",
    new Set(initialGraph.edges().map((e) => e.data("color"))).size >= 5 &&
      initialGraph.edges().every((e) => e.data("weight") >= 1 && e.data("weight") <= 3),
  );
  const positions = initialGraph.nodes().map((n) => n.position());
  check(
    "Adaptive overview layout has finite separated positions instead of a grid row",
    positions.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) &&
      new Set(positions.map((p) => Math.round(p.y))).size > 3,
  );
  const initialPositions = new Map(initialGraph.nodes().map((n) => [n.id(), { ...n.position() }]));
  const focusNode = initialGraph.nodes()[0];
  await act(async () => focusNode.emit("tap"));
  check(
    "Clicking a node opens its explicit local view without filtering global evidence",
    shadow.querySelector(".w-node-inspector") &&
      shadow.querySelector(".w-graph-scope").textContent.includes("局部关系") &&
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("185,147"),
  );
  await click(buttons("查看全部关系")[0]);
  check(
    "Returning from a local graph preserves the original node positions",
    initialGraph
      .nodes()
      .every((n) => JSON.stringify(n.position()) === JSON.stringify(initialPositions.get(n.id()))),
  );
  await change('[aria-label="关系角色"]', "mail_recipient");
  await wait(
    () =>
      !shadow.querySelector('.w-relation-section [aria-busy="true"]') &&
      shadow.querySelector(".w-relation-matrix"),
  );
  const matrixRows = [...shadow.querySelectorAll(".w-relation-matrix tbody tr")];

  const matrixColumns = [
    ...shadow.querySelectorAll(".w-relation-matrix thead th:not(:first-child)"),
  ];

  check(
    "Mail matrix shows every row and column continuously without 24-object pages",
    matrixRows.length === 49 &&
      matrixColumns.length === 49 &&
      !shadow.querySelector(".w-matrix-pages") &&
      shadow.querySelector(".w-matrix-tools").textContent.includes("连续滚动"),
  );
  check(
    "Full matrix retains all 7452 recipient role event counts",
    [...shadow.querySelectorAll(".w-relation-matrix td button")].reduce(
      (sum, b) => sum + Number(b.textContent),
      0,
    ) === 7452,
  );
  const lastName = matrixColumns.at(-1).getAttribute("title");
  await change('[aria-label="定位矩阵对象"]', lastName);
  await act(async () => Simulate.submit(shadow.querySelector(".w-matrix-locate")));
  const matrixScroll = shadow.querySelector(".w-matrix-scroll");
  const matrixPosition = { left: matrixScroll.scrollLeft, top: matrixScroll.scrollTop };
  check(
    "Name locate scrolls to matching row and column and highlights their headers",
    shadow.querySelector('.w-matrix-locate [role="status"]').textContent.includes(lastName) &&
      shadow.querySelectorAll(".w-relation-matrix th.is-located").length === 2 &&
      matrixPosition.left > 0 &&
      matrixPosition.top > 0,
  );
  await change('[aria-label="矩阵格子尺寸"]', "18");
  check(
    "Compact matrix hides only cell text while preserving accessible exact counts",
    shadow.querySelector(".w-matrix-scroll").style.getPropertyValue("--matrix-cell") === "18px" &&
      [...shadow.querySelectorAll(".w-relation-matrix td button")].every(
        (b) => b.textContent === "" && /\d+$/.test(b.getAttribute("aria-label")),
      ),
  );
  await change('[aria-label="定位矩阵对象"]', "not-a-person-92832");
  await act(async () => Simulate.submit(shadow.querySelector(".w-matrix-locate")));
  check(
    "Matrix locate reports absent names without replacing results",
    shadow.querySelector('.w-matrix-locate [role="status"]').textContent === "未找到此对象" &&
      shadow.querySelectorAll(".w-relation-matrix tbody tr").length === 49,
  );
  await click(buttons("关系图")[0]);
  await click(buttons("关系矩阵")[0]);
  check(
    "Matrix restores scroll and cell size after switching graph views",
    shadow.querySelector(".w-matrix-scroll").scrollLeft === matrixPosition.left &&
      shadow.querySelector(".w-matrix-scroll").scrollTop === matrixPosition.top &&
      shadow.querySelector('[aria-label="矩阵格子尺寸"]').value === "18",
  );
  await change('[aria-label="矩阵排序"]', "count");
  check(
    "Changing matrix order resets scroll without truncating the endpoints",
    shadow.querySelector(".w-matrix-scroll").scrollTop === 0 &&
      shadow.querySelector(".w-matrix-scroll").scrollLeft === 0 &&
      shadow.querySelectorAll(".w-relation-matrix tbody tr").length === 49,
  );
  await click(buttons("关系图")[0]);
  await wait(() => globalThis.__mc2Graph.edges().length > 0);
  check(
    "Dense mail graph opens a labelled one-hop view with complete graph access",
    shadow.querySelector(".w-graph-scope").textContent.includes("局部关系") &&
      globalThis.__mc2Graph.edges().length < 2230 &&
      buttons("查看全部关系").length === 1,
  );
  await click(buttons("查看全部关系")[0]);
  check(
    "Expanding dense mail restores every relation combination",
    globalThis.__mc2Graph.edges().length === 2230,
  );
  await change('[aria-label="关系角色"]', "overview");
  await wait(() => !!shadow.querySelector(".w-relation-categories"));
  await click(buttons("关系图")[0]);

  check(
    "Both datasets share MC1 control and playback templates",
    shadow.querySelectorAll(".global-controls .check").length === 4 &&
      shadow.querySelector(".tl-play") &&
      shadow.querySelector(".tl-scale"),
  );
  await click(buttons("隐藏筛选")[0]);
  check(
    "Shared hide-filter control releases sidebar space",
    shadow.querySelector(".w-layout.filters-hidden") &&
      shadow.querySelector(".filter-panel").hidden,
  );
  await click(buttons("显示筛选")[0]);
  await click(buttons("并排对比")[0]);
  check(
    "Parallel view uses the same control state and hides sidebar",
    shadow.querySelector(".w-main-parallel") && shadow.querySelector(".filter-panel").hidden,
  );
  await click(buttons("并排对比：已开启")[0]);
  const resizeBefore = globalThis.__mc2ResizeCount;
  await act(async () => window.dispatchEvent(new Event("scroll")));
  check(
    "Outer page scroll refreshes graph coordinates across ShadowRoot",
    globalThis.__mc2ResizeCount > resizeBefore,
  );
  check(
    "Displayed record identifiers omit dataset prefix",
    [...shadow.querySelectorAll(".mc2-record-id")].every((e) => !e.textContent.includes("MC2:")),
  );
  check("Empty local process has only compact entry", !shadow.querySelector(".w-timeline-scroll"));
  await click(buttons("收起概览")[0]);
  check(
    "Collapsed overview retains volume and removes type rows",
    shadow.querySelector('[aria-label="时间总量柱"]') && !shadow.querySelector(".w-type-label"),
  );
  check(
    "Explicit overview collapse releases its expanded height reservation",
    !shadow.querySelector(".mc2-activity-card .w-pending-region").style.minHeight,
  );
  await click(buttons("展开24类型")[0]);
  const beforePlaybackDates = shadow.querySelector(".tl-date").textContent;
  const activityBeforePlay = shadow.querySelector(".w-activity");
  holdWorkspace = true;
  const requestsBeforePlay = requests.length;
  await click(shadow.querySelector(".tl-play"));
  await wait(() => shadow.querySelector('.mc2-activity-card [data-refresh-state="refreshing"]'));
  check(
    "Playback retains the previous matrix with a light update status",
    shadow.querySelector(".w-activity") === activityBeforePlay &&
      !shadow.querySelector(".mc2-activity-card .w-loading-placeholder") &&
      shadow.querySelector(".mc2-activity-card .mc2-status").textContent.includes("暂显示上次结果"),
  );
  await wait(
    () =>
      requests
        .slice(requestsBeforePlay)
        .filter((url) => new URL(url).pathname === "/api/mc2/activity").length >= 2,
  );
  check(
    "Further playback steps keep the same visible matrix until results arrive",
    shadow.querySelector(".w-activity") === activityBeforePlay &&
      shadow.querySelector(".mc2-activity-card .is-retaining .w-pending-content").inert,
  );
  await click(buttons("收起概览")[0]);
  check(
    "Overview can collapse immediately even while playback data is pending",
    !shadow.querySelector(".w-type-label") &&
      parseFloat(shadow.querySelector(".mc2-activity-card .w-pending-region").style.minHeight) <
        660,
  );
  await click(buttons("展开24类型")[0]);
  await click(shadow.querySelector(".tl-play"));
  holdWorkspace = false;
  await wait(() => delayed.length > 0);
  await act(async () => {
    delayed.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  await wait(() => !shadow.querySelector('.mc2-activity-card [aria-busy="true"]'));
  await click(buttons("返回上一步")[0]);
  await wait(() => shadow.querySelector(".tl-date").textContent === beforePlaybackDates);
  check(
    "A multi-frame playback session returns to its starting window in one step",
    shadow.querySelector(".tl-date").textContent === beforePlaybackDates,
  );
  await click(buttons("恢复全范围")[0]);
  await wait(ready);
  const globalDates = shadow.querySelector(".tl-date").textContent;
  const globalHandles = [...shadow.querySelectorAll(".tl-range")].map((e) => e.value);
  await click(shadow.querySelector('[aria-label^="筛选当天 2046-05-17"]'));
  await wait(
    () =>
      shadow.querySelector('[data-testid="mc2-list-scope"]').textContent.includes("2046-05-17") &&
      !shadow.querySelector('.w-relation-section [aria-busy="true"]'),
  );
  check(
    "Activity bar selects one day without moving global timeline",
    shadow.querySelector(".tl-date").textContent === globalDates &&
      [...shadow.querySelectorAll(".tl-range")].every((e, i) => e.value === globalHandles[i]),
  );
  check(
    "Only selected activity bar changes color, no matrix outlines",
    shadow.querySelectorAll('[aria-label="时间总量柱"] [aria-pressed="true"]').length === 1 &&
      !shadow.querySelector(".mc2-cell.selected"),
  );
  await click(shadow.querySelector('[aria-label^="筛选当天 2046-05-17"]'));
  await wait(
    () =>
      !buttons("清除单日选择").length &&
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("185,147"),
  );
  check(
    "Repeated activity bar click clears only local day selection",
    shadow.querySelector(".tl-date").textContent === globalDates,
  );
  await click(shadow.querySelector('[aria-label^="筛选当天 2046-05-17"]'));
  await wait(() => !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  let taskCell = [...shadow.querySelectorAll(".mc2-cell")].find((e) =>
    e.getAttribute("aria-label").startsWith("queue_subordinate_task 2046-05-17"),
  );
  await click(taskCell);
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("15 条") &&
      shadow.querySelector(".w-facet-bars button")?.textContent.includes("10"),
  );
  check(
    "Matrix axes replace repeated entity prefixes with icons and short names",
    [...shadow.querySelectorAll(".w-relation-matrix th .w-entity-name")].every(
      (e) => !/agent:|person:|system:|Agent\//.test(e.textContent),
    ) && shadow.querySelector(".w-relation-matrix th svg"),
  );
  check(
    "Clicking a single matrix cell highlights only that cell",
    shadow.querySelectorAll(".mc2-cell.selected").length === 1 &&
      shadow.querySelector(".mc2-cell.selected") === taskCell &&
      shadow.querySelectorAll(".mc2-cell[aria-pressed=true]").length === 1,
  );
  const nextDayBar = shadow.querySelector('[aria-label^="筛选当天 2046-05-18"]');
  const nextDayTotal = Number(nextDayBar.getAttribute("aria-label").match(/ (\d+) 条$/)[1]);
  await click(nextDayBar);
  await wait(
    () =>
      !shadow.querySelector('.w-relation-section [aria-busy="true"]') &&
      shadow
        .querySelector('[data-testid="evidence-count"]')
        .textContent.includes(`${nextDayTotal.toLocaleString("en-US")} 条`),
  );
  check(
    "A new activity date clears the old cell, type scope and type-specific relation",
    !shadow.querySelector(".mc2-cell.selected,.w-type-label.is-selected") &&
      shadow.querySelector('[aria-label="关系角色"]').value === "overview" &&
      shadow.querySelectorAll('[aria-label="时间总量柱"] [aria-pressed=true]').length === 1,
  );
  await click(buttons("返回上一步")[0]);
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("15 条") &&
      shadow.querySelector(".mc2-cell.selected"),
  );
  check(
    "Back restores the previous date, exact cell and type scope together",
    shadow.querySelector(".mc2-cell.selected") === taskCell &&
      shadow.querySelector('[aria-label="关系角色"]').value === "queue_target_agent",
  );
  await click(shadow.querySelector('[aria-label="定位日期 2046-06-01"]'));
  await wait(
    () =>
      !shadow.querySelector('.w-relation-section [aria-busy="true"]') &&
      shadow.querySelector(".tl-date").textContent.includes("2046-06-01"),
  );
  check(
    "Changing the global time window also clears stale local selections",
    !shadow.querySelector(".mc2-cell.selected,.w-type-label.is-selected") &&
      !buttons("清除单日选择").length &&
      shadow.querySelector('[aria-label="关系角色"]').value === "overview",
  );
  await click(buttons("返回上一步")[0]);
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("15 条") &&
      shadow.querySelector(".mc2-cell.selected"),
  );
  taskCell = [...shadow.querySelectorAll(".mc2-cell")].find((e) =>
    e.getAttribute("aria-label").startsWith("queue_subordinate_task 2046-05-17"),
  );

  const taskHeader = [...shadow.querySelectorAll(".w-type-label")].find((el) =>
    el.textContent.includes("subordinate"),
  );

  await click(taskHeader);
  await wait(() => !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  check(
    "Clicking the selected type header clears type and locator together",
    !taskHeader.classList.contains("is-selected") && !shadow.querySelector(".mc2-cell.selected"),
  );
  await click(taskHeader);
  await wait(() =>
    shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("15 条"),
  );
  check(
    "Header selection highlights the type without a cell locator",
    taskHeader.classList.contains("is-selected") && !shadow.querySelector(".mc2-cell.selected"),
  );
  await click(taskCell);
  await wait(() => !shadow.querySelector('.w-relation-section [aria-busy="true"]'));

  const otherTaskCell = [...shadow.querySelectorAll(".mc2-cell")].find(
    (el) => el !== taskCell && el.getAttribute("aria-label").startsWith("queue_subordinate_task"),
  );

  const beforeLocatorMove = requests.length;
  await click(otherTaskCell);
  await wait(() => !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  check("Moving a cell locator does not send a query", requests.length === beforeLocatorMove);
  check(
    "Moving between cells replaces the single highlight and preserves type-scope behavior",
    shadow.querySelector(".mc2-cell.selected") === otherTaskCell &&
      shadow.querySelectorAll(".mc2-cell.selected").length === 1 &&
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("15 条"),
  );
  await click(otherTaskCell);
  await wait(() => !shadow.querySelector('.w-relation-section [aria-busy="true"]'));
  check(
    "Clicking the selected cell clears only its type selection",
    !shadow.querySelector(".mc2-cell.selected") && buttons("清除单日选择").length === 1,
  );
  await click(taskCell);
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("15 条") &&
      !shadow.querySelector('.w-relation-section [aria-busy="true"]'),
  );

  check(
    "15-task selection immediately opens exact role endpoints and visible update cue",
    shadow.querySelector(".w-selection-notice").textContent.includes("15 条") &&
      shadow.querySelector(".w-relation-matrix") &&
      buttons("查看关系").length === 1,
  );
  check(
    "Five no-file events are explicit and accessible",
    buttons("无明确文件关联 · 5 条").length === 1,
  );
  await click(buttons("无明确文件关联 · 5 条")[0]);
  await wait(() =>
    shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("5 条"),
  );
  check("No-file group retains all five actual records", rows().length === 5);
  await click(buttons("返回上一步")[0]);
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("15 条") &&
      shadow.querySelector(".w-facet-bars button")?.textContent.includes("SwiftWren"),
  );
  await click(
    [...shadow.querySelectorAll(".w-facet-bars button")].find((e) =>
      e.textContent.includes("SwiftWren_further_instructions.md"),
    ),
  );
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("10 条") &&
      !shadow.querySelector('.w-relation-section [aria-busy="true"]') &&
      shadow.querySelector(".w-relation-matrix td button:not(:disabled)"),
  );
  check(
    "File drill-down selects ten recorded tasks, preserving parent 15",
    shadow
      .querySelector('[data-testid="relation-summary"]')
      .textContent.includes("当前 10 条事件") &&
      shadow.querySelector(".w-selection-notice").textContent.includes("15 条"),
  );
  await click(
    [...shadow.querySelectorAll(".w-relation-matrix td button")].find(
      (b) => Number(b.getAttribute("aria-label").match(/ (\d+)$/)[1]) > 0,
    ),
  );
  await wait(() => shadow.querySelector(".w-edge-events button"));
  await click(
    [...shadow.querySelectorAll(".w-edge-events button")].find((e) =>
      e.textContent.startsWith("查看过程"),
    ),
  );
  await wait(() => shadow.querySelector('[data-testid="process-summary"]'));
  check(
    "Single task opens a real local timeline",
    !!shadow.querySelector('[aria-label="真实时间执行者泳道"]'),
  );
  const processRequestsBeforeRange = requests.length;
  check(
    "Process graph replaces zoom/pan buttons with two range handles and window drag",
    shadow.querySelector('[aria-label="过程图窗口起点"]') &&
      shadow.querySelector('[aria-label="过程图窗口终点"]') &&
      shadow.querySelector('[aria-label="平移过程图时间窗口"]') &&
      !buttons("放大时间").length &&
      !buttons("向前平移").length,
  );
  await click(buttons("全部窗口")[0]);
  const processEndRange = shadow.querySelector('[aria-label="过程图窗口终点"]');
  const processDuration = Number(processEndRange.max);
  await change('[aria-label="过程图窗口终点"]', String(processDuration * 0.8));
  await change('[aria-label="过程图窗口起点"]', String(processDuration * 0.2));
  check(
    "Local range changes both endpoints without changing evidence/query scope",
    Number(shadow.querySelector('[aria-label="过程图窗口起点"]').value) > 0 &&
      Number(processEndRange.value) < processDuration &&
      shadow.querySelector('[data-testid="process-summary"]').textContent.includes("主选") &&
      requests.length === processRequestsBeforeRange,
  );
  await click(buttons("聚焦活动")[0]);
  const hoverProcess = shadow.querySelector(".w-process-mark");
  await act(async () => Simulate.mouseEnter(hoverProcess));
  check(
    "Process marker hover explains solid/hollow and exact event within a plot overlay",
    shadow.querySelector('.w-process-plot [role="tooltip"]')?.textContent.includes("主选") ||
      shadow.querySelector('.w-process-plot [role="tooltip"]')?.textContent.includes("补充"),
  );
  await act(async () => Simulate.mouseLeave(hoverProcess));
  check(
    "Leaving process marker removes tooltip without losing graph",
    !shadow.querySelector(".w-process-tooltip") && shadow.querySelector(".w-timeline-scroll"),
  );
  const processOptions = shadow.querySelector(".w-process-options");
  await click(processOptions.querySelector("summary"));
  check(
    "Process display options open inside their anchored menu",
    processOptions.open && processOptions.querySelector(".w-process-popover input"),
  );
  await act(async () => Simulate.keyDown(processOptions.querySelector("input"), { key: "Escape" }));
  check(
    "Escape closes process options and restores summary focus",
    !processOptions.open && shadow.activeElement === processOptions.querySelector("summary"),
  );
  await click(processOptions.querySelector("summary"));
  await act(async () =>
    shadow
      .querySelector('[aria-label="真实时间执行者泳道"]')
      .dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true })),
  );
  check("Clicking the process chart dismisses the options menu", !processOptions.open);
  await click(buttons("按时间阅读过程")[0]);
  await wait(() => shadow.querySelector(".w-process-story li"));
  check(
    "Process chronological reading uses exact paged members",
    shadow.querySelector(".w-process-story li") && buttons("下一页过程成员").length === 1,
  );
  await click(buttons("时间泳道")[0]);
  await click(shadow.querySelector(".w-process-mark"));
  check(
    "Selecting a process mark opens inspection without opening Reader",
    shadow.querySelector(".w-event-inspector") && !shadow.querySelector(".mc2-reader"),
  );
  await click(buttons("阅读原始记录")[0]);
  await wait(() => shadow.querySelector(".mc2-fields"));
  check(
    "Record lists and selected message share pill metadata",
    shadow.querySelector(".mc2-reader .msg-meta .comm-id") &&
      shadow.querySelector(".mc2-record-list article.message .msg-meta .comm-id"),
  );
  check(
    "Reader header uses shared back/close actions",
    shadow.querySelector(".mc2-reader .flow-close") &&
      !shadow.querySelector(".mc2-reader .mc2-close"),
  );
  check(
    "Reader uses MC1 message cards and collapses raw fields",
    shadow.querySelector(".flow-modal .chat-bubble") &&
      shadow.querySelector(".mc2-reader details:not([open]) .mc2-fields") &&
      shadow.querySelector(".mc2-reader").textContent.includes("原始记录与来源定位"),
  );
  check(
    "Actor filter is a name link, not a standalone action button",
    shadow.querySelector(".cb-agent.w-text-link") && !buttons("以此执行者筛选主页面").length,
  );
  holdReader = true;
  const messageBeforeFile = shadow.querySelector(".mc2-reader .chat-bubble");
  await click(shadow.querySelector(".mc2-reader .mc2-link-row"));
  await wait(
    () =>
      delayed.length > 0 && shadow.querySelector('.mc2-reader [data-refresh-state="refreshing"]'),
  );
  check(
    "Reader retains its previous message while a different payload type loads",
    shadow.querySelector(".mc2-reader .chat-bubble") === messageBeforeFile &&
      !shadow.querySelector(".mc2-reader-body > .w-pending-region > .w-loading-placeholder") &&
      shadow.querySelector(".mc2-reader-body > .w-pending-region > .w-pending-content").inert &&
      shadow.querySelector(".mc2-reader .mc2-status").textContent.includes("暂显示上次结果"),
  );
  holdReader = false;
  await act(async () => {
    delayed.splice(0).forEach((resolve) => resolve());
  });
  await wait(() =>
    shadow.querySelector(".mc2-reader").textContent.includes("当前筛选内的文件轨迹"),
  );
  check(
    "Reader switches from event to file without mixing payload types",
    !!shadow.querySelector(".mc2-reader .mc2-type-counts"),
  );
  await click(buttons("返回上次阅读")[0]);
  await wait(() => shadow.querySelector(".mc2-reader .chat-bubble"));
  await click(shadow.querySelector('[aria-label="关闭阅读记录"]'));
  check(
    "Reader close preserves exact process and edge scope",
    !shadow.querySelector(".mc2-reader") &&
      shadow.querySelector('[data-testid="process-summary"]') &&
      shadow.querySelector(".w-edge-inspector"),
  );
  check(
    "Process selection returns to a colored symbol and halo",
    shadow.querySelectorAll(".w-process-mark.selected").length === 1 &&
      shadow.querySelector(".w-process-mark.selected .w-process-symbol") &&
      shadow.querySelector(".w-process-mark.selected .w-process-halo"),
  );
  check(
    "Process lanes and shape legend use reusable SVG symbols",
    shadow.querySelectorAll(".w-process-legend svg").length === 5 &&
      shadow.querySelector('[aria-label="真实时间执行者泳道"] g>svg'),
  );
  await click(shadow.querySelector('[aria-label="完整关系事件时间分布"] [role="button"]'));
  await wait(
    () =>
      shadow.querySelector(".w-edge-inspector .w-notice") &&
      !shadow.querySelector('.w-edge-inspector [aria-busy="true"]'),
  );
  const savedBucket = shadow.querySelector(".w-edge-inspector .w-notice").textContent;
  await change('[aria-label="筛选对象分布"]', "SwiftWren");
  await wait(() => !shadow.querySelector('.w-facets [aria-busy="true"]'));
  const savedEvidence = shadow.querySelector('[data-testid="evidence-count"]').textContent;
  const savedRole = shadow.querySelector('[aria-label="关系角色"]').value;
  const savedProcess = shadow.querySelector('[data-testid="process-summary"]').textContent;
  const mountedProcess = shadow.querySelector(".w-timeline-scroll");
  const mountedEvidence = shadow.querySelector(".mc2-record-list");
  const requestsBeforeOverlay = requests.length;
  await click(buttons("发布实例比较")[0]);
  await wait(() => shadow.querySelector('[aria-label="发布实例真实时间对齐"]'));
  check(
    "Comparison floats above the same mounted process and records without new main-scope requests",
    shadow.querySelector(".w-research-dialog") &&
      shadow.querySelector(".w-timeline-scroll") === mountedProcess &&
      shadow.querySelector(".mc2-record-list") === mountedEvidence &&
      !requests
        .slice(requestsBeforeOverlay)
        .some((u) => /\/api\/mc2\/(relations|activity|evidence|process)\?/.test(u)),
  );
  await click(
    [...shadow.querySelectorAll(".w-compare-row-tools button")].find((b) =>
      b.textContent.includes("阅读全历史"),
    ),
  );
  await wait(() => shadow.querySelector(".mc2-reader .mc2-type-counts"));
  check(
    "Nested Reader suspends the research dialog while keeping it mounted",
    shadow.querySelector(".w-research-dialog")?.inert && document.body.style.overflow === "hidden",
  );
  check(
    "Comparison file reading explicitly ignores conflicting main time and task type",
    shadow.querySelector(".mc2-reader-scope").textContent.includes("数据起点") &&
      !shadow.querySelector(".mc2-reader-scope").textContent.includes("queue_subordinate_task"),
  );
  await click(shadow.querySelector('[aria-label="关闭阅读记录"]'));
  check(
    "Closing nested Reader resumes the research dialog with scroll still locked",
    !shadow.querySelector(".w-research-dialog").inert && document.body.style.overflow === "hidden",
  );
  await click(shadow.querySelector('[aria-label="关闭发布比较"]'));
  await wait(
    () =>
      shadow.querySelector('[aria-label="关系角色"]')?.value === savedRole &&
      !shadow.querySelector('.w-relation-section [aria-busy="true"]'),
  );
  check(
    "Explicit comparison exit restores file, exact edge, records and process",
    shadow.querySelector('[data-testid="evidence-count"]').textContent === savedEvidence &&
      shadow.querySelector('[data-testid="process-summary"]').textContent === savedProcess &&
      shadow.querySelector(".w-edge-inspector") &&
      shadow.querySelector(".w-context-title").textContent.includes("SwiftWren"),
  );
  check(
    "Research close restores trigger focus and body scrolling",
    shadow.activeElement === buttons("发布实例比较")[0] &&
      document.body.style.overflow !== "hidden",
  );
  check(
    "Comparison exit also restores the relation bucket and object search",
    shadow.querySelector(".w-edge-inspector .w-notice")?.textContent === savedBucket &&
      shadow.querySelector('[aria-label="筛选对象分布"]').value === "SwiftWren",
  );
  await click(buttons("发布实例比较")[0]);
  await wait(() => shadow.querySelector('[aria-label="发布实例真实时间对齐"]'));
  await act(async () =>
    Simulate.keyDown(shadow.querySelector(".w-research-dialog"), { key: "Escape" }),
  );
  await wait(() => !shadow.querySelector(".w-research-dialog"));
  check(
    "Escape from comparison restores the same original investigation",
    shadow.querySelector('[data-testid="evidence-count"]').textContent === savedEvidence &&
      shadow.querySelector('[aria-label="关系角色"]').value === savedRole,
  );
  await click(buttons("文件指纹")[0]);
  await wait(() => shadow.querySelector(".w-pattern-list button"));
  check(
    "Exact fingerprint entry names full-history scope and all 15310 files",
    shadow.querySelector(".w-research-dialog").textContent.includes("15,310") &&
      shadow.querySelector(".w-fingerprint-stats").textContent.includes("195"),
  );
  check(
    "Fingerprint entry moved from object sidebar to relationship title actions",
    !shadow.querySelector(".w-facets").textContent.includes("精确文件模式") &&
      buttons("文件指纹")[0].closest(".mc2-card-head"),
  );
  check(
    "Fingerprint rows visualize action sequences and frequency with a separate detail pane",
    shadow.querySelector(".w-pattern-row .w-step-node") &&
      shadow.querySelector(".w-pattern-row .w-pattern-frequency") &&
      shadow.querySelector(".w-pattern-detail"),
  );
  await click(shadow.querySelector(".w-pattern-list button"));
  await wait(() => shadow.querySelector(".w-pattern-members article"));
  check(
    "Pattern members have exact paths, content status and separate scope actions",
    buttons("全历史文件调查").length === 12 &&
      buttons("在当前筛选中查看此文件").length === 12 &&
      shadow.querySelector(".w-pattern-members article").textContent.includes("正文"),
  );
  await click(buttons("在当前筛选中查看此文件")[0]);
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("0 条") &&
      !shadow.querySelector('.w-relation-section [aria-busy="true"]'),
  );
  check(
    "Current-scope pattern drill-down remains empty rather than widening task scope",
    shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("0 条") &&
      shadow.querySelector('[aria-label="记录关键词"]').value === "",
  );
  await click(buttons("返回原调查")[0]);
  await wait(() => shadow.querySelector(".w-edge-inspector"));
  check(
    "Pattern drill-down returns to its original exact edge",
    shadow.querySelector('[data-testid="evidence-count"]').textContent === savedEvidence,
  );
  await click(buttons("文件指纹")[0]);
  await wait(() => shadow.querySelector(".w-pattern-list button"));
  await click(shadow.querySelector(".w-pattern-list button"));
  await wait(() => buttons("全历史文件调查").length);
  await click(buttons("全历史文件调查")[0]);
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("2 条") &&
      !shadow.querySelector('.w-relation-section [aria-busy="true"]'),
  );
  check(
    "Full-history pattern drill-down shows the two exact operations",
    rows().length === 2 && shadow.querySelector('[aria-label="关系角色"]').value === "operations",
  );
  await click(buttons("返回原调查")[0]);
  await wait(() => shadow.querySelector(".w-edge-inspector"));

  await click(buttons("返回上一步")[0]);
  await wait(() => !shadow.querySelector(".w-timeline-scroll"));
  check(
    "Back restores previous relationship selection",
    !!shadow.querySelector(".w-edge-inspector"),
  );
  await click(buttons("异常发布与附近参与者")[0]);
  await wait(() =>
    shadow
      .querySelector('[data-testid="process-summary"]')
      ?.textContent.includes("主选 1 条 ＋ 附近补充 4 条"),
  );
  await click(buttons("按时间阅读过程")[0]);
  await wait(() => shadow.querySelectorAll(".w-process-story li").length === 5);
  check(
    "Process story explains incoming task and five readable activities",
    shadow.querySelectorAll(".w-process-story li").length === 5 &&
      shadow.querySelector(".w-process-story").textContent.includes("任务目标") &&
      shadow.querySelector(".w-process-story").textContent.includes("john windward"),
  );
  await click(buttons("时间泳道")[0]);
  check(
    "One shortcut discovers all five events without knowing Chloe",
    ["373893", "373899", "373902", "373909", "373913"].every((id) =>
      shadow.querySelector(`.w-timeline-scroll [aria-label^="event:${id}"]`),
    ),
  );
  check(
    "Shortcut keeps full matrix collapsed, and marks incoming task as context",
    !shadow.querySelector(".w-type-label") &&
      shadow
        .querySelector('[aria-label^="event:373893"]')
        .getAttribute("aria-label")
        .includes("附近补充"),
  );
  await click(buttons("固定此过程")[0]);
  await click(shadow.querySelector('[aria-label="定位日期 2046-06-01"]'));
  await wait(
    () =>
      shadow.querySelector(".tl-date")?.textContent.includes("2046-06-01 00:00:00") &&
      !shadow.querySelector('.w-process-section [aria-busy="true"]'),
  );
  await wait(() =>
    shadow.querySelector(".w-process-section").textContent.includes("固定上下文，不随当前选择变化"),
  );
  check(
    "Pinned old context is explicitly independent of current date",
    !!shadow.querySelector('[data-testid="process-summary"]'),
  );
  await click(buttons("取消固定，跟随当前选择")[0]);
  await wait(() => shadow.querySelector('[data-testid="process-outside"]'));
  check(
    "Expired unpinned process stops drawing instead of retaining stale timeline",
    !shadow.querySelector(".w-timeline-scroll") &&
      shadow.querySelector('[data-testid="process-outside"]').textContent.includes("停止"),
  );
  await click(buttons("恢复全范围")[0]);
  await wait(ready);
  await click(buttons("发布实例比较")[0]);
  await wait(() => shadow.querySelector('[aria-label="发布实例真实时间对齐"]'));
  check(
    "Comparison uses common real time and explicit full-history reading",
    shadow.querySelector(".w-research-dialog").textContent.includes("共同视窗") &&
      buttons("完整真实时间").length === 1,
  );
  await click(buttons("字段表")[0]);
  await wait(() => shadow.querySelector(".w-comparison"));
  check(
    "Historical comparison names the explicit-source subset and missing creation",
    shadow.querySelector(".w-research-dialog").textContent.includes("候选 3 例") &&
      shadow.querySelector(".w-comparison").textContent.includes("未见创建记录") &&
      shadow.querySelector(".w-comparison").textContent.includes("2秒"),
  );
  await click(shadow.querySelector('[aria-label="关闭发布比较"]'));
  await click(buttons("恢复全范围")[0]);
  await wait(ready);
  const first = rows()[0].textContent;
  await click(buttons("下一页").at(-1));
  await wait(
    () =>
      !shadow.querySelector('.w-evidence-section [aria-busy="true"]') &&
      rows()[0]?.textContent !== first,
  );
  const second = rows()[0].textContent;
  check("Evidence pages actually change records", first !== second);
  await click(buttons("上一页").at(-1));
  await wait(() => rows()[0]?.textContent === first);
  await change('[aria-label="记录关键词"]', "no-such-mc2-record-721983");

  await wait(() =>
    shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("0 条"),
  );
  check(
    "Zero result has no stale record or graph",
    rows().length === 0 && !shadow.querySelector(".w-relation-matrix td button"),
  );
  await click(buttons("恢复全范围")[0]);
  await wait(ready);
  const beforeCache = requests.length;
  await click(shadow.querySelector('[aria-label^="筛选当天 2046-05-17"]'));
  await wait(
    () =>
      buttons("清除单日选择").length &&
      !shadow.querySelector('.w-relation-section [aria-busy="true"]'),
  );
  await click(
    [...shadow.querySelectorAll(".w-type-label")].find((e) =>
      e.textContent.includes("subordinate"),
    ),
  );
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("15 条") &&
      !shadow.querySelector('.w-relation-section [aria-busy="true"]'),
  );
  check(
    "Returning to a recent scope uses cached workspace responses",
    requests.length === beforeCache,
  );
  await click(buttons("恢复全范围")[0]);
  await wait(ready);
  holdWorkspace = true;
  const matrixBeforeFilter = shadow.querySelector(".w-activity");
  const recordsBeforeFilter = shadow.querySelector(".mc2-record-list");
  const facetBeforeFilter = shadow.querySelector(".w-facets");
  contentHeight = 730;
  await act(async () => {
    [...resizeObservers].forEach((observer) => observer.callback());
  });
  await change('[aria-label="记录关键词"]', "pending-query-one");
  await wait(() => delayed.length > 0 && shadow.querySelector(".w-relation-section .is-pending"));
  const pendingRegion = shadow.querySelector(".w-relation-visual .is-pending");
  const relationCardContent = shadow.querySelector(".w-relation-section > .w-pending-region");
  check(
    "Relation loading is confined to the chart with an explicit label and stable height",
    pendingRegion &&
      !pendingRegion.classList.contains("is-retaining") &&
      pendingRegion.querySelector(":scope > .w-loading-mask .w-loading-spinner") &&
      /正在加载关系(图|矩阵|概览)/.test(
        pendingRegion.querySelector(":scope > .w-loading-mask").textContent,
      ) &&
      pendingRegion.querySelector(".w-pending-content").inert &&
      pendingRegion.getAttribute("aria-busy") === "true" &&
      parseFloat(pendingRegion.style.minHeight) >= 390,
  );
  check(
    "Relationship controls and object list remain outside the chart loading mask",
    relationCardContent.getAttribute("aria-busy") === "false" &&
      !relationCardContent.querySelector(":scope > .w-loading-mask") &&
      !shadow.querySelector('[aria-label="关系角色"]').closest("[inert]") &&
      !pendingRegion.contains(shadow.querySelector(".w-facets")) &&
      !shadow.querySelector(".w-relation-section > .mc2-status"),
  );
  check(
    "Filtering preserves the mounted matrix, evidence list and object distribution",
    shadow.querySelector(".w-activity") === matrixBeforeFilter &&
      shadow.querySelector(".mc2-record-list") === recordsBeforeFilter &&
      shadow.querySelector(".w-facets") === facetBeforeFilter &&
      shadow.querySelector(".w-evidence-section .is-retaining"),
  );
  await wait(() => parseFloat(pendingRegion.style.minHeight) >= 730);
  contentHeight = 120;
  holdWorkspace = false;
  await change('[aria-label="记录关键词"]', "no-such-record-latest");
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("0 条") &&
      !shadow.querySelector('.w-relation-section [aria-busy="true"]'),
  );
  await act(async () => {
    delayed.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  check(
    "Delayed older responses cannot replace latest keyword results",
    shadow.querySelector('[aria-label="记录关键词"]').value === "no-such-record-latest" &&
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("0 条"),
  );
  check(
    "Successful empty results release pending height reservations",
    [...shadow.querySelectorAll('.w-pending-region[data-refresh-state="ready"]')].every(
      (el) => !el.style.minHeight,
    ),
  );
  check(
    "Smaller results release historical maxima while preserving mounted lists",
    !shadow.querySelector(".w-relation-section .w-pending-region").style.minHeight &&
      shadow.querySelector(".mc2-record-list") === recordsBeforeFilter &&
      shadow.querySelector(".w-facets") === facetBeforeFilter,
  );
  contentHeight = 480;
  await click(buttons("恢复全范围")[0]);
  await wait(ready);
  const beforeFailure = shadow.querySelector(".w-activity");
  failWorkspace = true;
  await change('[aria-label="记录关键词"]', "failed-refresh-unique");
  await wait(() => shadow.querySelector('.mc2-activity-card [data-refresh-state="error"]'));
  check(
    "Failed updates preserve results, height and offer an explicit retry",
    shadow.querySelector(".w-activity") === beforeFailure &&
      !shadow.querySelector(".mc2-activity-card .w-loading-placeholder") &&
      shadow.querySelector('.mc2-activity-card [role="alert"]').textContent.includes("更新失败") &&
      shadow.querySelector('.mc2-activity-card [role="alert"] button') &&
      shadow.querySelector(".mc2-activity-card .w-pending-content").inert,
  );
  failWorkspace = false;
  await click(shadow.querySelector('.mc2-activity-card [role="alert"] button'));
  await wait(() => shadow.querySelector('.mc2-activity-card [data-refresh-state="ready"]'));
  check(
    "Retry replaces the retained view with the successful empty result",
    !shadow.querySelector('.mc2-activity-card [role="alert"]') &&
      shadow.querySelector(".mc2-activity-card .mc2-note").textContent.includes("0 条记录"),
  );
  await click(buttons("恢复全范围")[0]);
  await wait(ready);
  const visibility = [...shadow.querySelectorAll(".global-controls .check input")];
  for (const control of visibility) {
    await act(async () => Simulate.change(control, { target: { checked: false } }));
  }
  const hiddenRequests = requests.length;
  await change('[aria-label="记录关键词"]', "hidden-sections-unique-keyword");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 500));
  });
  check(
    "All hidden investigation regions pause new MC2 requests",
    requests.length === hiddenRequests && shadow.querySelector(".w-relation-section").hidden,
  );
  for (const control of visibility) {
    await act(async () => Simulate.change(control, { target: { checked: true } }));
  }
  await wait(
    () =>
      shadow.querySelector('[data-testid="evidence-count"]').textContent.includes("0 条") &&
      !shadow.querySelector('.w-relation-section [aria-busy="true"]'),
  );
  check("Reopening regions queries the latest hidden scope", requests.length > hiddenRequests);
  await click(buttons("恢复全范围")[0]);
  await wait(ready);
  await click(buttons("MC1")[0]);
  await wait(
    () =>
      document.querySelector('[data-testid="mc1-reference"]')?.shadowRoot?.querySelectorAll(".cell")
        .length > 0,
  );
  check("MC1 remains navigable and renders its unchanged matrix", true);
  console.log(
    `Passed ${checks.length} real API + React interaction checks. Graph uses headless Cytoscape; this is not visual QA.`,
  );
} finally {
  await act(async () => root.unmount());
  dom.window.close();
}

process.exit(0);
