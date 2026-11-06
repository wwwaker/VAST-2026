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
await page.evaluate(() => {
  const back = [...document.querySelectorAll(".run-detail-tools .btn")].find((b) =>
    b.textContent?.includes("返回运行列表"),
  );
  back?.click();
});

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

console.log("== MC2 来源链 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".stream-row", { timeout: 20000 });
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".view-tab")].find((t) => t.textContent?.includes("来源链"));
  tab?.click();
});
await page.waitForSelector(".trace-view", { timeout: 15000 });
await page.waitForSelector(".canvas-subbar .seg-item", { timeout: 15000 });
// 用第一个日志明确记录的 content_source 事件作为链根
await page.evaluate(() => document.querySelector(".canvas-subbar .seg-item")?.click());
await page.waitForSelector(".trace-lanes", { timeout: 15000 });
await wait(600);
const traceState = await page.evaluate(() => ({
  chips: document.querySelectorAll(".canvas-subbar .seg-item").length,
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

// 切到 MC1 时来源链标签必须消失，避免把 MC2 的链画到别的数据集上
await page.select(".topbar select", "MC1");
await wait(900);
const mc1Tabs = await page.$$eval(".view-tab", (ns) => ns.map((n) => n.textContent?.trim()));
if (mc1Tabs.includes("来源链")) throw new Error("MC1 下不应出现来源链标签");
console.log("[数据集隔离]", JSON.stringify(mc1Tabs));

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
