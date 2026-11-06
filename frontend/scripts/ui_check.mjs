/**
 * 界面自检：驱动本机 Chrome 打开构建产物，测量布局与渲染成本，并截图。
 * 用法（先启动后端，它会托管 frontend/dist）：
 *   node scripts/ui_check.mjs http://127.0.0.1:8000
 */
import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const URL = process.argv[2] ?? "http://127.0.0.1:8000";
// 输出路径按脚本自身位置定位，避免 npm --prefix 与直接 node 调用时落到不同目录
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "build");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const TEST_NOTE = `UI 自检生成的测试笔记 ${Date.now()}`;

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
});

const page = await browser.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));
page.on("requestfailed", (r) => {
  // 组件主动取消的旧请求（AbortController）不算失败，否则每次换游标都会误报
  const reason = r.failure()?.errorText ?? "";
  if (reason === "net::ERR_ABORTED") return;
  errors.push(`请求失败 ${r.url()} (${reason})`);
});
page.on("response", (r) => {
  if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function measureLayout(tag) {
  const info = await page.evaluate(() => {
    const wrap = document.querySelector(".chart-wrap");
    const canvas = document.querySelector(".chart-wrap canvas");
    if (!wrap || !canvas) return null;
    const cw = wrap.getBoundingClientRect();
    const cc = canvas.getBoundingClientRect();
    return {
      wrapW: Math.round(cw.width),
      wrapH: Math.round(cw.height),
      canvasW: Math.round(cc.width),
      canvasH: Math.round(cc.height),
      rows: document.querySelectorAll(".stream-row").length,
    };
  });
  console.log(`[布局 ${tag}]`, JSON.stringify(info));
  return info;
}

console.log("== 概览 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".chart-wrap canvas", { timeout: 20000 });
await page.waitForSelector(".stream-row", { timeout: 20000 });
await wait(600);
await measureLayout("light");
await page.screenshot({ path: path.join(OUT, "ui-light.png") });

console.log("== 侧栏开关与宽度 ==");
const dockButton = (label) =>
  `[...document.querySelectorAll(".topbar-docks button")].find((n) => n.textContent?.trim() === "${label}")`;
const dockState = () =>
  page.evaluate(() => ({
    event: !!document.querySelector(".event-dock"),
    evidence: !!document.querySelector(".evidence-dock"),
    eventPressed: document
      .querySelectorAll(".topbar-docks button")[1]
      ?.getAttribute("aria-pressed"),
  }));

const dockInitial = await dockState();
if (!dockInitial.event) throw new Error("右侧事件流侧栏默认未显示");
// 两个侧栏默认开合状态不同（事件流开、证据关），按各自初始状态验证“翻转一次再还原”
for (const [label, key] of [
  ["事件流", "event"],
  ["证据", "evidence"],
]) {
  await page.evaluate(`(${dockButton(label)}).click()`);
  await wait(250);
  const toggled = await dockState();
  if (toggled[key] === dockInitial[key]) throw new Error(`${label}侧栏开关无效`);
  await page.evaluate(`(${dockButton(label)}).click()`);
  await wait(250);
  const restored = await dockState();
  if (restored[key] !== dockInitial[key]) throw new Error(`${label}侧栏未能还原`);
  console.log(`[侧栏 ${label}] 初始=${dockInitial[key]} 切换后=${toggled[key]} 还原=${restored[key]}`);
}
await page.evaluate(() => {
  const handle = document.querySelector(".dock-resizer-left");
  handle?.focus();
  handle?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
});
const resized = await page.$eval(".dock-resizer-left", (node) => node.getAttribute("aria-valuenow"));
if (!resized) throw new Error("右侧事件面板尺寸控制不可用");
await page.evaluate(() => {
  const slider = document.querySelector(".timebrush-slider");
  if (!(slider instanceof HTMLInputElement)) throw new Error("时间滑块未渲染");
  slider.focus();
});
await page.keyboard.press("Home");
await wait(250);
const sliderState = await page.evaluate(() => {
  const thumb = document.querySelector(".timebrush-thumb");
  return {
    value: document.querySelector(".timebrush-slider")?.value,
    thumb: thumb ? getComputedStyle(thumb).backgroundColor : "",
  };
});
if (!sliderState.value || sliderState.thumb === "rgba(0, 0, 0, 0)") throw new Error("时间滑块未显示或无法操作");
console.log("[尺寸 / 时间滑块]", JSON.stringify({ resized, ...sliderState }));
await page.setViewport({ width: 390, height: 844 });
const mobileBounds = await page.evaluate(() => ({
  body: document.body.scrollWidth,
  viewport: window.innerWidth,
  controlbar: Math.round(document.querySelector(".controlbar")?.getBoundingClientRect().height ?? 0),
}));
if (mobileBounds.body > mobileBounds.viewport + 1) throw new Error(`窄屏出现横向溢出：${JSON.stringify(mobileBounds)}`);
console.log("[窄屏]", JSON.stringify(mobileBounds));
await page.setViewport({ width: 1600, height: 1000 });

await page.goto(`${URL}/?theme=dark`, { waitUntil: "networkidle0" });
await page.waitForSelector(".chart-wrap canvas", { timeout: 20000 });
await wait(600);
await page.screenshot({ path: path.join(OUT, "ui-dark.png") });

console.log("== 选择事件并查看证据 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".stream-row", { timeout: 20000 });
const rows = await page.$$(".stream-row");
await rows[0].click();
await page.waitForSelector(".drawer .evidence, .drawer .empty-state", { timeout: 10000 });
await wait(500);
await page.screenshot({ path: path.join(OUT, "ui-evidence.png") });

console.log("== 锚点：定位到目标帖子附近 ==");
await page.evaluate(() => {
  const chip = [...document.querySelectorAll(".anchor-chip")].find((c) =>
    c.textContent?.includes("目标帖子"),
  );
  chip?.click();
});
await wait(800);
const anchorState = await page.evaluate(() => ({
  summary: document.querySelector(".status-summary")?.textContent,
  rows: document.querySelectorAll(".stream-row").length,
}));
console.log("[锚点后]", JSON.stringify(anchorState));
await page.screenshot({ path: path.join(OUT, "ui-anchor.png") });

console.log("== 切到自建数据集 ==");
await page.select(".topbar select", "CUSTOM");
await wait(1200);
const customState = await page.evaluate(() => ({
  summary: document.querySelector(".status-summary")?.textContent,
  rows: document.querySelectorAll(".stream-row").length,
  firstRow: document.querySelector(".stream-row")?.textContent?.slice(0, 80),
}));
console.log("[CUSTOM]", JSON.stringify(customState));
await page.screenshot({ path: path.join(OUT, "ui-custom.png") });

console.log("== CUSTOM 冻结案例 ==");
await page.waitForSelector(".case-chip", { timeout: 15000 });
const caseState = await page.evaluate(() => {
  const chips = [...document.querySelectorAll(".case-chip")];
  const bad = [...document.querySelectorAll(".case-chip .tag-warn, .case-chip .tag-risk")];
  return {
    count: chips.length,
    ok: document.querySelectorAll(".case-chip .tag-ok").length,
    titles: chips.map((chip) => chip.querySelector(".case-title")?.textContent?.trim()),
    flagged: bad.map((node) => node.textContent?.trim()),
  };
});
if (caseState.count !== 5) throw new Error(`冻结案例应为 5 条，实际 ${caseState.count}`);
if (caseState.ok !== 5) throw new Error(`案例状态不是全部一致：${JSON.stringify(caseState)}`);
console.log("[冻结案例]", JSON.stringify(caseState));
await page.screenshot({ path: path.join(OUT, "ui-cases.png") });

// 点“审批绕过”必须直接进入它冻结的对照，而不是自动挑一个别的正常运行
await page.evaluate(() => {
  const chip = [...document.querySelectorAll(".case-chip")].find((node) =>
    node.textContent?.includes("审批绕过"),
  );
  chip?.click();
});
await page.waitForSelector(".run-compare", { timeout: 20000 });
await wait(600);
const caseCompare = await page.evaluate(() => ({
  pair: document.querySelector(".run-compare .run-detail-head p")?.textContent?.trim() ?? "",
  auto: (document.querySelector(".run-compare .run-detail-head p")?.textContent ?? "").includes("自动选择"),
}));
if (!caseCompare.pair.includes("run-06309bfc") || !caseCompare.pair.includes("run-93d3d84d")) {
  throw new Error(`案例对照未使用冻结配对：${caseCompare.pair}`);
}
console.log("[案例对照]", JSON.stringify(caseCompare));
await page.screenshot({ path: path.join(OUT, "ui-case-compare.png") });

// 回到运行列表，继续测运行级筛选
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".stream-row", { timeout: 20000 });
await page.select(".topbar select", "CUSTOM");
await page.waitForSelector(".run-row-button", { timeout: 15000 });
await wait(600);

console.log("== CUSTOM 运行级筛选 ==");
await page.evaluate(() => document.querySelector(".run-row-button")?.click());
await page.waitForSelector(".run-detail-head", { timeout: 15000 });
await wait(1500);
const runState = await page.evaluate(() => ({
  summary: document.querySelector(".status-summary")?.textContent ?? "",
  lane: document.querySelector(".run-detail-head")?.textContent ?? "",
  stream: document.querySelector(".stream-head .muted")?.textContent ?? "",
}));
const laneEvents = Number(
  (runState.lane.match(/([\d,]+)\s*条事件/) ?? [])[1]?.replace(/,/g, "") ?? NaN,
);
const streamMatched = Number(
  (runState.stream.match(/([\d,]+)\s*条匹配/) ?? [])[1]?.replace(/,/g, "") ?? NaN,
);
if (!/运行/.test(runState.summary)) throw new Error(`选中运行后筛选摘要未写入 run_id：${runState.summary}`);
if (!Number.isFinite(laneEvents) || streamMatched !== laneEvents) {
  throw new Error(`运行画布与事件流口径不一致：画布 ${laneEvents} 条，事件流 ${streamMatched} 条`);
}
console.log(`[运行级筛选] 摘要=${runState.summary} · 画布 ${laneEvents} 条 = 事件流 ${streamMatched} 条`);
await page.screenshot({ path: path.join(OUT, "ui-custom-run.png") });

// 「与正常对照比较」入口：必须能从有已核验配对的运行进入对照
await page.evaluate(() => {
  const back = [...document.querySelectorAll(".run-detail-tools .btn")].find((b) =>
    b.textContent?.includes("返回运行列表"),
  );
  back?.click();
});
await page.waitForSelector(".run-row-button", { timeout: 15000 });
const runsPayload = await (await fetch(`${URL}/api/runs?dataset=CUSTOM`)).json();
const pairedRun = (runsPayload.items ?? []).find((item) => item.has_pair);
if (!pairedRun) throw new Error("没有可用于「与正常对照比较」的已核验配对运行");
await page.evaluate((runId) => {
  const row = [...document.querySelectorAll(".run-row-button")].find((n) =>
    (n.getAttribute("title") ?? "").includes(runId),
  );
  row?.click();
}, pairedRun.run_id);
await page.waitForSelector(".run-detail-head", { timeout: 15000 });
await wait(800);
const compareEntry = await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".run-detail-tools .btn")].find((b) =>
    b.textContent?.includes("与正常对照比较"),
  );
  return btn ? { text: btn.textContent?.trim(), title: btn.getAttribute("title"), disabled: btn.disabled } : null;
});
if (!compareEntry) throw new Error("运行详情缺少「与正常对照比较」入口");
if (compareEntry.disabled) throw new Error(`已核验配对的运行入口仍被禁用：${compareEntry.title}`);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".run-detail-tools .btn")].find((b) =>
    b.textContent?.includes("与正常对照比较"),
  );
  btn?.click();
});
await page.waitForSelector(".run-compare", { timeout: 20000 });
await wait(600);
const compareEntryState = await page.evaluate(() => ({
  pair: document.querySelector(".run-compare .run-detail-head p")?.textContent?.trim() ?? "",
  normal: document.querySelectorAll(".run-compare .pattern-table").length,
}));
if (!compareEntryState.pair.includes(pairedRun.normal_run_id)) {
  throw new Error(`「与正常对照比较」未进入该运行的已核验配对：${compareEntryState.pair}`);
}
console.log("[对照入口]", JSON.stringify({ ...compareEntry, run: pairedRun.run_id, ...compareEntryState }));
await page.screenshot({ path: path.join(OUT, "ui-compare-entry.png") });

console.log("== MC1 双声道 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".stream-row", { timeout: 20000 });
await page.select(".topbar select", "MC1");
await page.waitForSelector(".stream-row", { timeout: 20000 });
await wait(500);

// 只筛含内部审议的事件
await page.evaluate(() => {
  const box = [...document.querySelectorAll(".stream-head label.check input")][0];
  box?.click();
});
await wait(1000);
const dualRows = await page.$$eval(".stream-row", (ns) => ns.length);
const dualChip = await page.$$eval(".stream-row .tag-delib", (ns) => ns.length);
console.log(`[仅含内心审议] 行数 ${dualRows} · 带标记 ${dualChip}`);

const rows2 = await page.$$(".stream-row");
await rows2[0].click();
await page.waitForSelector(".drawer .dual", { timeout: 10000 });
await wait(600);
const dual = await page.evaluate(() => ({
  width: Math.round(document.querySelector(".drawer")?.getBoundingClientRect().width ?? 0),
  coverage: document.querySelector(".dual-head .muted")?.textContent,
  left: document.querySelectorAll(".dual-body")[0]?.textContent?.slice(0, 60),
  right: document.querySelectorAll(".dual-body")[1]?.textContent?.slice(0, 60),
  tabs: [...document.querySelectorAll(".dual-tab")].map((t) => t.textContent),
  sources: [...document.querySelectorAll(".dual-source")].map((t) => t.textContent),
}));
console.log("[双声道]", JSON.stringify(dual, null, 1));
await page.screenshot({ path: path.join(OUT, "ui-dual.png") });

console.log("== 关系图 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".stream-row", { timeout: 20000 });
const rows3 = await page.$$(".stream-row");
await rows3[0].click();
await wait(600);
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".view-tab")].find((t) =>
    t.textContent?.includes("关系图"),
  );
  tab?.click();
});
await page.waitForSelector(".graph-node", { timeout: 15000 });
await wait(600);
const graph1 = await page.evaluate(() => ({
  nodes: document.querySelectorAll(".graph-node").length,
  edges: document.querySelectorAll(".graph-stage svg line").length,
  caption: document.querySelector(".graph-head p")?.textContent?.trim(),
  truncated: !!document.querySelector(".graph .callout-warn"),
}));
console.log("[关系图]", JSON.stringify(graph1));
await page.screenshot({ path: path.join(OUT, "ui-graph.png") });

// 点击另一个节点改变中心
await page.evaluate(() => {
  const nodes = [...document.querySelectorAll(".graph-node")];
  nodes[nodes.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await wait(900);
const graph2 = await page.evaluate(() => document.querySelector(".graph-head p")?.textContent?.trim());
console.log("[切换中心]", graph2);
await page.screenshot({ path: path.join(OUT, "ui-graph2.png") });

console.log("== MC2 系统背景 ==");
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".canvas-subbar .seg-item")].find((b) =>
    b.textContent?.includes("系统背景"),
  );
  btn?.click();
});
await page.waitForSelector(".system-canvas", { timeout: 20000 });
await wait(900);
const systemMap = await page.evaluate(() => ({
  nodes: document.querySelectorAll(".system-node").length,
  edges: document.querySelectorAll(".system-canvas path").length,
  caption: document.querySelector(".system-map .trace-head .muted")?.textContent?.trim(),
  spotlight: !!document.querySelector(".system-map .callout .role-chip"),
  orgItems: document.querySelectorAll(".org-list li").length,
}));
if (systemMap.nodes < 8) throw new Error(`系统背景应聚合出至少 8 个组，实际 ${systemMap.nodes}`);
if (!systemMap.caption?.includes("聚合成")) throw new Error(`缺少聚合说明：${systemMap.caption}`);
console.log("[系统背景]", JSON.stringify(systemMap));
await page.screenshot({ path: path.join(OUT, "ui-system-map.png") });

// 展开一个组：只返回真实实体 ID，成员数与聚合数一致
await page.evaluate(() => {
  const nodes = [...document.querySelectorAll(".system-node")];
  const target = nodes.find((n) => n.textContent?.includes("Agent 执行者")) ?? nodes[0];
  target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await page.waitForSelector(".system-side .trace-item", { timeout: 15000 });
const expanded = await page.evaluate(() => ({
  members: document.querySelectorAll(".system-side .trace-item").length,
  first: document.querySelector(".system-side .trace-item .mono")?.textContent?.trim(),
}));
console.log("[展开组]", JSON.stringify(expanded));
await page.screenshot({ path: path.join(OUT, "ui-system-expand.png") });

console.log("== MC2 来源链 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".stream-row", { timeout: 20000 });
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".view-tab")].find((t) => t.textContent?.includes("来源链"));
  tab?.click();
});
await page.waitForSelector(".trace-view", { timeout: 15000 });
await page.waitForSelector(".trace-roots .seg-item", { timeout: 15000 });
// 用第一个日志明确记录的 content_source 事件作为链根
await page.evaluate(() => document.querySelector(".trace-roots .seg-item")?.click());
await page.waitForSelector(".trace-lanes", { timeout: 15000 });
await wait(600);
const traceState = await page.evaluate(() => ({
  chips: document.querySelectorAll(".trace-roots .seg-item").length,
  hasCandidate: !!document.querySelector(".trace-chain .tag-warn"),
  status: [...document.querySelectorAll(".trace-chain .callout code")].map((n) => n.textContent?.trim()),
  recorded: document.querySelector(".trace-head .muted")?.textContent?.trim(),
}));
if (traceState.chips < 3) throw new Error(`来源链根候选不足：${traceState.chips}`);
if (!traceState.status.includes("metadata_only")) {
  throw new Error(`目标文件内容状态应为 metadata_only，实际 ${JSON.stringify(traceState.status)}`);
}
console.log("[来源链]", JSON.stringify(traceState));
await page.screenshot({ path: path.join(OUT, "ui-trace.png") });

// 打开文件轨迹：事件数与内容状态必须与来源链一致
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".trace-chain .btn")].find((b) =>
    b.textContent?.includes("查看文件轨迹"),
  );
  btn?.click();
});
await page.waitForSelector(".file-events .stream-row", { timeout: 15000 });
const fileTrack = await page.evaluate(() => ({
  rows: document.querySelectorAll(".file-events .stream-row").length,
  status: document.querySelector(".file-track .tag")?.textContent?.trim(),
  matched: document.querySelector(".file-track .muted")?.textContent?.trim(),
}));
if (fileTrack.status !== "仅有元数据") throw new Error(`文件轨迹状态文案异常：${fileTrack.status}`);
console.log("[文件轨迹]", JSON.stringify(fileTrack));
await page.screenshot({ path: path.join(OUT, "ui-file-track.png") });

console.log("== MC2 历史实例与干预论证 ==");
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".canvas-subbar .seg-item")].find((b) =>
    b.textContent?.includes("历史实例"),
  );
  btn?.click();
});
await page.waitForSelector(".pattern-table", { timeout: 15000 });
await wait(500);
const patterns = await page.evaluate(() => ({
  columns: document.querySelectorAll(".pattern-table thead th").length,
  rows: document.querySelectorAll(".pattern-table tbody tr").length,
  missing: document.querySelectorAll(".pattern-missing").length,
  present: document.querySelectorAll(".pattern-present").length,
}));
if (patterns.columns !== 4) throw new Error(`历史实例应有 3 条链 + 阶段列，实际 ${patterns.columns}`);
if (patterns.missing < 2) throw new Error(`应保留缺失阶段单元格，实际 ${patterns.missing}`);
console.log("[历史实例]", JSON.stringify(patterns));
await page.screenshot({ path: path.join(OUT, "ui-patterns.png") });

await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".canvas-subbar .seg-item")].find((b) =>
    b.textContent?.includes("干预论证"),
  );
  btn?.click();
});
await page.waitForSelector(".intervention-view", { timeout: 15000 });
await wait(600);
const intervention = await page.evaluate(() => ({
  coverage: document.querySelector(".intervention-view h3")?.textContent ?? "",
  cut: document.querySelector(".intervention-view .callout-warn strong")?.textContent ?? "",
  rows: document.querySelectorAll(".intervention-view .pattern-table tbody tr").length,
}));
if (!intervention.coverage.includes("3/3")) throw new Error(`覆盖应为 3/3：${intervention.coverage}`);
if (!intervention.cut.includes("无法")) throw new Error(`切断证明应明确拒绝：${intervention.cut}`);
console.log("[干预论证]", JSON.stringify(intervention));
await page.screenshot({ path: path.join(OUT, "ui-intervention.png") });

console.log("== MC2 转移矩阵 ==");
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".canvas-subbar .seg-item")].find((b) =>
    b.textContent?.includes("转移矩阵"),
  );
  btn?.click();
});
await page.waitForSelector(".transition-table", { timeout: 20000 });
await wait(600);
const matrixState = await page.evaluate(() => {
  const cells = [...document.querySelectorAll(".transition-cell")].filter(
    (n) => !n.classList.contains("transition-cell-empty"),
  );
  const first = cells[0];
  return {
    cells: cells.length,
    types: document.querySelectorAll(".transition-table thead th").length - 1,
    lowSample: document.querySelectorAll(".transition-cell-low").length,
    text: document.querySelector(".transition-view")?.textContent ?? "",
    firstTitle: first?.getAttribute("title") ?? "",
  };
});
if (matrixState.cells < 10) throw new Error(`转移矩阵非空格过少：${matrixState.cells}`);
if (!matrixState.text.includes("不表示因果")) throw new Error("转移矩阵缺少“不表示因果”说明");
if (matrixState.text.includes("13.78")) throw new Error("未实现校正前不得展示 13.78 倍");
await page.evaluate(() => {
  const cell = [...document.querySelectorAll(".transition-cell")].find(
    (n) => !n.classList.contains("transition-cell-empty"),
  );
  cell?.click();
});
await page.waitForSelector(".transition-evidence", { timeout: 15000 });
await wait(500);
const matrixEvidence = await page.evaluate(() => ({
  header: document.querySelector(".transition-evidence .trace-head")?.textContent?.trim() ?? "",
  pairs: document.querySelectorAll(".transition-evidence .transition-pair").length,
  twoSides: (document.querySelector(".transition-pair")?.querySelectorAll(".trace-item").length ?? 0) === 2,
}));
const supportN = Number((matrixState.firstTitle.match(/(\d+)\s*对/) ?? [])[1] ?? NaN);
const evidenceN = Number((matrixEvidence.header.match(/支持\s*([\d,]+)\s*对/) ?? [])[1]?.replace(/,/g, "") ?? NaN);
if (!Number.isFinite(supportN) || supportN !== evidenceN) {
  throw new Error(`矩阵格与证据列表口径不一致：格 ${supportN} 对，列表 ${evidenceN} 对`);
}
if (!matrixEvidence.twoSides) throw new Error("相邻对列表应同时展示源与后继两条事件");
console.log("[转移矩阵]", JSON.stringify({ ...matrixState, firstTitle: undefined, evidenceN }));
await page.screenshot({ path: path.join(OUT, "ui-transitions.png") });

// 切到 MC1 时来源链标签必须消失，避免把 MC2 的链画到别的数据集上
await page.select(".topbar select", "MC1");
await wait(900);
const mc1Tabs = await page.$$eval(".view-tab", (ns) => ns.map((n) => n.textContent?.trim()));
if (mc1Tabs.includes("来源链")) throw new Error("MC1 下不应出现来源链标签");
console.log("[数据集隔离]", JSON.stringify(mc1Tabs));

console.log("== MC1 活动矩阵与决策泳道 ==");
await page.waitForSelector(".mc1-workspace", { timeout: 20000 });
await page.waitForSelector(".activity-table tbody tr", { timeout: 20000 });
await page.waitForSelector(".mc1-lanes", { timeout: 20000 });
await wait(800);
const mc1Workspace = await page.evaluate(() => ({
  agents: document.querySelectorAll(".activity-table tbody tr").length,
  columns: document.querySelectorAll(".activity-table thead th").length - 1,
  emptyCells: document.querySelectorAll(".activity-cell-empty").length,
  anchors: document.querySelectorAll(".mc1-anchor").length,
  messages: document.querySelectorAll(".mc1-lanes circle").length,
  releases: document.querySelectorAll(".mc1-lanes rect").length,
  candidates: document.querySelectorAll(".mc1-candidate").length,
  pending: document.querySelector(".mc1-workspace")?.textContent?.includes("待确认预期") ?? false,
  audit: document.querySelector(".mc1-audit")?.textContent ?? "",
}));
if (mc1Workspace.agents !== 7) throw new Error(`MC1 活动矩阵应有 7 个 agent，实际 ${mc1Workspace.agents}`);
if (mc1Workspace.columns < 2) throw new Error(`MC1 活动矩阵缺少时间列：${mc1Workspace.columns}`);
if (mc1Workspace.anchors !== 3) throw new Error(`决策泳道应并置 3 个锚点，实际 ${mc1Workspace.anchors}`);
if (mc1Workspace.messages < 10) throw new Error(`决策泳道消息点过少：${mc1Workspace.messages}`);
if (!mc1Workspace.audit.includes("future")) throw new Error("缺少回复分类计数（future）");
if (!mc1Workspace.pending) throw new Error("没有制度依据的规则应显示“待确认预期”");
console.log("[MC1 工作区]", JSON.stringify(mc1Workspace));
await page.screenshot({ path: path.join(OUT, "ui-mc1.png") });

console.log("== 基线比较 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".anchor-chip", { timeout: 20000 });
await page.evaluate(() => document.querySelector(".anchor-chip")?.click());
await wait(900);
// 通过主画布视图标签打开基线比较
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".view-tab")].find((c) =>
    c.textContent?.includes("比较"),
  );
  tab?.click();
});
await page.waitForSelector(".compare-row", { timeout: 15000 });
await wait(700);
const cmp = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".compare-row")].slice(1);
  return {
    rows: rows.length,
    deviated: document.querySelectorAll(".compare-deviated").length,
    head: document.querySelector(".compare-head p")?.textContent?.trim().slice(0, 110),
    top: rows.slice(0, 3).map((r) => [...r.children].map((c) => c.textContent.trim()).join(" | ")),
  };
});
console.log("[比较]", JSON.stringify(cmp, null, 1));
await page.screenshot({ path: path.join(OUT, "ui-compare.png") });

console.log("== 调查笔记 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".stream-row", { timeout: 20000 });
const rows4 = await page.$$(".stream-row");
await rows4[0].click();
await wait(500);
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("笔记"));
  tab?.click();
});
await page.waitForSelector(".notes-editor textarea", { timeout: 10000 });
await page.type(".notes-editor textarea", TEST_NOTE, { delay: 0 });
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".notes-actions .btn")].find((b) =>
    b.textContent?.includes("保存笔记"),
  );
  btn?.click();
});
await wait(900);
const notesState = await page.evaluate(() => ({
  count: document.querySelectorAll(".note-item").length,
  first: document.querySelector(".note-body")?.textContent?.slice(0, 40),
  attached: document.querySelector(".note-meta .mono")?.textContent,
  badge: document.querySelector(".status-actions .badge")?.textContent,
}));
console.log("[笔记]", JSON.stringify(notesState));
await page.screenshot({ path: path.join(OUT, "ui-notes.png") });

// 刷新页面，确认笔记没有丢
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector(".stream-row", { timeout: 20000 });
const rows5 = await page.$$(".stream-row");
await rows5[0].click();
await wait(500);
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("笔记"));
  tab?.click();
});
await wait(600);
const afterReload = await page.evaluate(() => document.querySelectorAll(".note-item").length);
console.log(`[刷新后] 笔记数 ${afterReload}`);

// 仅清理本次运行生成的测试笔记，保留用户已有笔记。
await page.evaluate((testNote) => {
  const item = [...document.querySelectorAll(".note-item")].find((node) =>
    node.querySelector(".note-body")?.textContent === testNote,
  );
  item?.querySelector(".note-del")?.click();
}, TEST_NOTE);
await wait(800);
const cleaned = await page.evaluate(() => document.querySelectorAll(".note-item").length);
console.log(`[清理后] 笔记数 ${cleaned}`);

console.log("== 键盘操作 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".stream-row", { timeout: 20000 });
await page.evaluate(() => document.body.focus());
await wait(400);

// ? 打开快捷键说明
await page.keyboard.press("?");
await wait(400);
const helpOpen = await page.evaluate(() => !!document.querySelector(".modal"));
await page.screenshot({ path: path.join(OUT, "ui-hotkeys.png") });
await page.keyboard.press("Escape");
await wait(300);
const helpClosed = await page.evaluate(() => !document.querySelector(".modal"));
console.log(`[? / Esc] 打开=${helpOpen} 关闭=${helpClosed}`);

// 方向键移动游标
const before = await page.$eval(".timebrush-readout", (n) => n.textContent.trim());
await page.keyboard.press("ArrowLeft");
await wait(400);
const after = await page.$eval(".timebrush-readout", (n) => n.textContent.trim());
console.log(`[←] ${before.slice(0, 16)} -> ${after.slice(0, 16)}  变化=${before !== after}`);

// 空格播放
await page.keyboard.press("Space");
await wait(500);
const playing = await page.$eval(".timebrush-row .btn", (n) => n.textContent.trim());
await page.keyboard.press("Space");
await wait(300);
console.log(`[空格] 播放态按钮文案=${playing}`);

// ↓ 选中事件并打开侧栏
await page.keyboard.press("ArrowDown");
await wait(700);
const kbdSelect = await page.evaluate(() => ({
  selected: document.querySelector(".stream-row-active")?.textContent?.slice(0, 30) ?? null,
  drawer: !!document.querySelector(".drawer"),
}));
console.log("[↓ / Enter]", JSON.stringify(kbdSelect));

// Esc 关闭侧栏
await page.keyboard.press("Escape");
await wait(400);
const drawerClosed = await page.evaluate(() => !document.querySelector(".drawer"));
console.log(`[Esc 关侧栏] ${drawerClosed}`);

// / 聚焦关键词
await page.keyboard.press("/");
await wait(300);
const focused = await page.evaluate(() => document.activeElement?.tagName + ":" + document.activeElement?.getAttribute("type"));
console.log(`[/] 焦点=${focused}`);

console.log("== 证据篮与结论导出 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".stream-row", { timeout: 20000 });
const caseTitle = `自检案例 ${Date.now()}`;
let caseId = null;
try {
  const rows5 = await page.$$(".stream-row");
  await rows5[0].click();
  await wait(500);
  // 加入证据篮（支持）
  await page.waitForSelector(".basket-add .btn", { timeout: 10000 });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".basket-add .btn")].find((b) => b.textContent?.includes("支持"));
    btn?.click();
  });
  // 切到证据篮页
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".tabs .tab")].find((t) => t.textContent?.includes("证据篮"));
    tab?.click();
  });
  await page.waitForSelector(".basket", { timeout: 10000 });
  const basketCount = await page.evaluate(() => document.querySelectorAll(".basket .trace-list li").length);
  if (basketCount < 1) throw new Error("证据篮里没有条目");

  // 保存案例
  await page.type(".basket > .callout input.text-input", caseTitle);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".basket .btn")].find((b) => b.textContent?.includes("保存当前案例"));
    btn?.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".basket .callout strong")?.textContent?.includes("自检案例"),
    { timeout: 15000 },
  );
  caseId = await page.evaluate(() => document.querySelector(".basket .callout .mono")?.textContent?.trim() ?? "");
  if (!caseId.startsWith("case-")) throw new Error(`案例 ID 异常：${caseId}`);

  // 写结论
  await page.type(".finding-form input.text-input", "自检主张：来源文件可追踪");
  await page.type(".finding-form textarea", "证据来自 post_content_source 关系");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".finding-form .btn")].find((b) => b.textContent?.includes("保存结论"));
    btn?.click();
  });
  await page.waitForFunction(
    (text) => [...document.querySelectorAll(".finding-list strong")].some((n) => n.textContent?.includes(text)),
    { timeout: 15000 },
    "自检主张",
  );
  const findingState = await page.evaluate(() => ({
    findings: document.querySelectorAll(".finding-list li").length,
    message: document.querySelector(".basket > p.muted")?.textContent?.trim() ?? "",
    evidence: document.querySelector(".finding-list li .muted")?.textContent?.trim() ?? "",
  }));
  console.log("[证据篮]", JSON.stringify({ basketCount, caseId, ...findingState }));
  await page.screenshot({ path: path.join(OUT, "ui-basket.png") });

  // 导出 Markdown 必须包含主张、证据与数据版本
  const response = await fetch(`${URL}/api/cases/${caseId}/export?format=md`);
  const markdown = await response.text();
  if (!markdown.includes("自检主张")) throw new Error("导出缺少主张");
  if (!markdown.includes("数据版本")) throw new Error("导出缺少数据版本");
  if (!markdown.includes("MC2:event:")) throw new Error("导出缺少证据引用");
  console.log(`[导出] ${response.status} · ${markdown.length} 字符 · 含主张/版本/证据`);
} finally {
  // 自检产生的用户案例必须清掉，避免污染 notes.db
  if (caseId) {
    const removed = await fetch(`${URL}/api/cases/${caseId}`, { method: "DELETE" });
    console.log(`[清理] 删除自检案例 ${caseId} → ${removed.status}`);
  }
}

console.log("== 渲染基准 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".topbar", { timeout: 10000 });
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".topbar .btn")].find((b) =>
    b.textContent?.includes("渲染基准"),
  );
  btn?.click();
});
await page.waitForSelector(".bench-actions .btn", { timeout: 10000 });
await wait(600);

const labels = await page.$$eval(".bench-actions .btn", (ns) => ns.map((n) => n.textContent.trim()));
for (let i = 0; i < labels.length; i++) {
  const btns = await page.$$(".bench-actions .btn");
  await btns[i].click();
  await wait(900);
}
await page.screenshot({ path: path.join(OUT, "ui-bench.png") });

const table = await page.$$eval(".bench-table tr", (rows) =>
  rows.slice(1).map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim())),
);
console.log("\n== 渲染结果 ==");
for (const row of table) console.log("  " + row.join(" | "));

console.log("\n== 控制台错误 ==", errors.length ? errors.slice(0, 5) : "无");

await browser.close();
