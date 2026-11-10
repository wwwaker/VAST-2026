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
// 输出路径按脚本自身位置定位，避免 npm --prefix 与直接 node 调用时落到不同目录；
// UI_CHECK_OUT 可指向本轮独立目录，避免覆盖历史截图
const OUT = process.env.UI_CHECK_OUT
  ? path.resolve(process.env.UI_CHECK_OUT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "build");
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
// 业务断言失败累计：结束时统一以非零退出码体现，不能降级成日志
const failures = [];
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

async function ensureDock(selector, label) {
  // 布局偏好按 dataset/task 记忆，切换后可能仍在应用；用「点击→等出现」重试避免反向点关
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.$(selector)) return true;
    const clicked = await page.evaluate((text) => {
      const btn = [...document.querySelectorAll(".topbar-docks button")].find((n) =>
        n.textContent?.trim().includes(text),
      );
      if (!btn) return false;
      btn.click();
      return true;
    }, label);
    if (!clicked) break;
    const appeared = await page.waitForSelector(selector, { timeout: 4000 }).then(
      () => true,
      () => false,
    );
    if (appeared) return true;
  }
  return !!(await page.$(selector));
}
const ensureEventDock = () => ensureDock(".event-dock", "事件流");
const ensureEvidenceDock = () => ensureDock(".evidence-dock", "证据");

/** F3：CUSTOM 单页没有事件流坞，通用事件查询改为页面「工具 → 事件查询」卡片。 */
async function ensureCustomStream() {
  if (!(await page.$('[data-testid="custom-page"]'))) return false;
  if (await page.$('[aria-label="事件查询"] .stream-row')) return true;
  await page.evaluate(() => {
    const tools = document.querySelector(".custom-tools");
    if (tools instanceof HTMLDetailsElement) tools.open = true;
    const btn = [...document.querySelectorAll(".custom-tools-menu button")].find(
      (n) => n.textContent?.trim() === "事件查询",
    );
    btn?.click();
  });
  await page.waitForSelector('[aria-label="事件查询"] .stream-row', { timeout: 15000 });
  return true;
}
const ensureStream = async () => ((await page.$('[data-testid="custom-page"]')) ? ensureCustomStream() : ensureEventDock());

/**
 * F2 起 MC2 与 MC1 一致，默认就是单页（无四任务/模式/视图标签），因此这里只负责
 * 重载并停在 MC2 单页。通用事件查询改由页面“工具 → 事件查询”打开，
 * 旧事件流侧栏与状态栏断言已随模板替换（见 交接/F2-交接报告.md）。
 */
async function open(theme = "light") {
  await page.goto(`${URL}/?theme=${theme}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".topbar", { timeout: 20000 });
  if (!(await page.$('[data-testid="mc2-page"]'))) {
    await page.select(".dataset-field select", "MC2");
  }
  await page.waitForSelector('[data-testid="mc2-page"]', { timeout: 20000 });
  await wait(600);
}

/** 打开页面“工具”菜单里的某一项（事件查询 / 历史实例 / 干预论证 / 转移矩阵 / 时间窗对照…）。 */
async function openTool(label) {
  await page.evaluate(() => {
    const tools = document.querySelector(".mc2-tools");
    if (tools instanceof HTMLDetailsElement) tools.open = true;
  });
  const clicked = await page.evaluate((text) => {
    const btn = [...document.querySelectorAll(".mc2-tools-menu button")].find(
      (n) => n.textContent?.trim() === text,
    );
    btn?.click();
    return !!btn;
  }, label);
  if (!clicked) throw new Error(`工具菜单缺少「${label}」`);
  await wait(500);
}

/** 通用事件查询卡：F2 用它替代旧事件流侧栏，保留“选中事件→证据/笔记”的路径。 */
async function openEventQuery() {
  if (await page.$('[aria-label="事件查询"] .stream-row')) return;
  await openTool("事件查询");
  await page.waitForSelector('[aria-label="事件查询"] .stream-row', { timeout: 20000 });
  await wait(400);
}

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

console.log("== 单页首屏 ==");
await open("light");
await page.waitForSelector(".chart-wrap canvas", { timeout: 20000 });
await page.waitForSelector(".trace-lanes", { timeout: 20000 });
await wait(600);
const firstScreen = await page.evaluate(() => ({
  taskTabs: document.querySelectorAll(".task-tab").length,
  modeTabs: document.querySelectorAll(".mode-tab").length,
  viewTabs: document.querySelectorAll(".view-tab").length,
  eventDock: !!document.querySelector(".event-dock"),
  statusbar: !!document.querySelector(".statusbar"),
  chainRoot: document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "",
  canvas: !!document.querySelector(".chart-wrap canvas"),
  systemNodes: document.querySelectorAll(".system-node").length,
  context: [...document.querySelectorAll(".mc2-context > *")].map((n) => n.textContent?.replace(/\s+/g, " ").trim()),
}));
if (firstScreen.taskTabs || firstScreen.modeTabs || firstScreen.viewTabs) {
  throw new Error(`MC2 不应再有四任务/模式/视图重复导航：${JSON.stringify(firstScreen)}`);
}
if (!firstScreen.canvas || firstScreen.systemNodes < 8) {
  throw new Error(`首屏缺少真实活动图或系统背景：${JSON.stringify(firstScreen)}`);
}
if (!/MC2:event:\d+/.test(firstScreen.chainRoot)) {
  throw new Error(`首屏来源链没有默认目标帖链根：${firstScreen.chainRoot}`);
}
console.log("[单页首屏]", JSON.stringify(firstScreen));
// 事件查询卡替代旧事件流侧栏
await openEventQuery();
await wait(400);
await measureLayout("light");
await page.screenshot({ path: path.join(OUT, "ui-light.png") });

console.log("== 侧栏开关与宽度 ==");
const dockButton = (label) =>
  `[...document.querySelectorAll(".topbar-docks button")].find((n) => n.textContent?.trim() === "${label}")`;
const dockState = () =>
  page.evaluate(() => ({
    event: !!document.querySelector(".event-dock"),
    evidence: !!document.querySelector(".evidence-dock"),
    reader: !!document.querySelector(".mc2-reader"),
  }));

const dockInitial = await dockState();
// 单页只保留证据侧栏；事件流改为页面内查询卡，不再占停靠位
for (const [label, key] of [["证据", "evidence"]]) {
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
// 停靠尺寸是旧架构的几何断言；新模板只要求侧栏能开合，这里在坞打开时顺带验证尺寸控制
let resized = null;
if (await page.$(".dock-resizer-left")) {
  await page.evaluate(() => {
    const handle = document.querySelector(".dock-resizer-left");
    handle?.focus();
    handle?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  });
  resized = await page.$eval(".dock-resizer-left", (node) => node.getAttribute("aria-valuenow"));
  if (!resized) throw new Error("右侧事件面板尺寸控制不可用");
} else {
  console.log("[尺寸] 证据坞未打开，跳过停靠尺寸断言（新模板不要求固定停靠）");
}
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

await open("dark");
await page.waitForSelector(".chart-wrap canvas", { timeout: 20000 });
await wait(600);
await page.screenshot({ path: path.join(OUT, "ui-dark.png") });

console.log("== 选择事件并查看证据 ==");
await open("light");
await openEventQuery();
const rows = await page.$$('[aria-label="事件查询"] .stream-row');
await rows[0].click();
// 点事件行打开页面唯一的阅读面板（替代旧事件流→详情抽屉）
await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 15000 });
const readerState = await page.evaluate(() => ({
  id: document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim(),
  raw: document.querySelectorAll('[data-testid="mc2-event-detail"] .mc2-raw-details').length,
  selected: document.querySelector('.stream-row.stream-row-active')?.getAttribute('data-event-id') ?? null,
}));
if (!readerState.id) throw new Error(`阅读面板没有事件 ID：${JSON.stringify(readerState)}`);
if (readerState.raw < 2) throw new Error(`阅读面板缺少 raw/details 完整载荷：${JSON.stringify(readerState)}`);
console.log("[阅读面板]", JSON.stringify(readerState));
await ensureEvidenceDock();
await page.waitForSelector(".drawer .evidence, .drawer .empty-state", { timeout: 10000 });
await wait(500);
await page.screenshot({ path: path.join(OUT, "ui-evidence.png") });

console.log("== 锚点：定位到目标帖子 ==");
await open("light");
await page.waitForSelector(".trace-lanes", { timeout: 20000 });
const beforeLocate = await page.evaluate(() => ({
  window: document.querySelector(".mc2-window")?.textContent?.trim(),
  root: document.querySelector(".mc2-root-event")?.textContent?.trim(),
}));
await page.evaluate(() => {
  const chip = [...document.querySelectorAll(".mc2-anchor-chip")].find((c) =>
    c.textContent?.includes("目标帖子"),
  );
  const action = chip ? [...chip.querySelectorAll(".mc2-anchor-action")].find((b) => b.textContent?.trim() === "定位") : null;
  action?.click();
});
await wait(1200);
const anchorState = await page.evaluate(() => ({
  window: document.querySelector(".mc2-window")?.textContent?.trim(),
  root: document.querySelector(".mc2-root-event")?.textContent?.trim(),
  rows: document.querySelectorAll('[aria-label="事件查询"] .stream-row').length,
  reader: !!document.querySelector(".mc2-reader"),
}));
// 定位目标帖只改链根/当前文件，不动统一时间窗（旧版“点锚点就换窗口”已弃用）
if (anchorState.window !== beforeLocate.window) {
  throw new Error(`定位目标帖不应改动统一时间窗：${beforeLocate.window} → ${anchorState.window}`);
}
if (!anchorState.root) throw new Error(`定位后缺少链根：${JSON.stringify(anchorState)}`);
console.log("[定位后]", JSON.stringify({ beforeLocate, ...anchorState }));
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
await page.waitForSelector(".custom-case-chip", { timeout: 15000 });
const caseState = await page.evaluate(() => {
  const chips = [...document.querySelectorAll(".custom-case-chip")];
  const bad = [...chips].flatMap((chip) => [...chip.querySelectorAll(".tag-warn, .tag-risk")]);
  return {
    count: chips.length,
    ok: document.querySelectorAll(".custom-case-chip .tag-ok").length,
    titles: chips.map((chip) => chip.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    flagged: bad.map((node) => node.textContent?.trim()),
  };
});
if (caseState.count !== 5) throw new Error(`冻结案例应为 5 条，实际 ${caseState.count}`);
if (caseState.ok !== 5) throw new Error(`案例状态不是全部一致：${JSON.stringify(caseState)}`);
console.log("[冻结案例]", JSON.stringify(caseState));
await page.screenshot({ path: path.join(OUT, "ui-cases.png") });

// 点“审批绕过”必须直接进入它冻结的对照，而不是自动挑一个别的正常运行
await page.click('.custom-case-chip[data-case-id="custom-bypass-review"]');
await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 20000 });
await wait(600);
const caseCompare = await page.evaluate(() => {
  const head = document.querySelector('[data-testid="custom-pair"] .custom-card-head')?.textContent ?? "";
  return { pair: head.replace(/\s+/g, " ").trim(), auto: head.includes("自动选择") };
});
if (!caseCompare.pair.includes("run-06309bfc") || !caseCompare.pair.includes("run-93d3d84d")) {
  throw new Error(`案例对照未使用冻结配对：${caseCompare.pair}`);
}
if (caseCompare.auto) throw new Error(`固定 baseline 的案例被当作自动解析：${caseCompare.pair}`);
console.log("[案例对照]", JSON.stringify(caseCompare));
await page.screenshot({ path: path.join(OUT, "ui-case-compare.png") });

console.log("== 预置案例结论导出 ==");
await ensureStream();
const presetCases = await (await fetch(`${URL}/api/cases?dataset=CUSTOM`)).json();
const presetCase = (presetCases.items ?? []).find((item) => item.title.includes("审批绕过"));
if (!presetCase) throw new Error("找不到“审批绕过”预置案例");
const presetClaim = `自检预置案例结论 ${Date.now()}`;
try {
  const presetRows = await page.$$(".stream-row");
  await presetRows[0].click();
  // F3：加入证据篮在页面阅读区（唯一正文入口）
  await page.waitForSelector(".custom-msg-actions .btn", { timeout: 10000 });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".custom-msg-actions .btn")].find((b) => b.textContent?.includes("支持"));
    btn?.click();
  });
  await ensureEvidenceDock();
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".tabs .tab")].find((t) => t.textContent?.includes("证据篮"));
    tab?.click();
  });
  await page.waitForSelector(".basket .finding-form", { timeout: 10000 });
  const presetBasket = await page.evaluate(() => ({
    title: document.querySelector(".basket .callout strong")?.textContent?.trim() ?? "",
    exportLinks: document.querySelectorAll(".basket .callout a[href*='/export']").length,
  }));
  if (!presetBasket.title.includes("审批绕过")) throw new Error(`证据篮未关联预置案例：${presetBasket.title}`);
  if (presetBasket.exportLinks !== 2) throw new Error(`预置案例导出入口数量异常：${presetBasket.exportLinks}`);

  await page.type(".finding-form input.text-input", presetClaim);
  await page.type(".finding-form textarea", "预置案例只读，结论写入独立 notes.db");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".finding-form .btn")].find((b) => b.textContent?.includes("保存结论"));
    btn?.click();
  });
  await page.waitForFunction(
    (text) => [...document.querySelectorAll(".finding-list strong")].some((n) => n.textContent?.includes(text)),
    { timeout: 15000 },
    presetClaim,
  );
  const presetExport = await fetch(`${URL}/api/cases/${presetCase.case_id}/export?format=md`);
  const presetMarkdown = await presetExport.text();
  if (presetExport.status !== 200) throw new Error(`预置案例导出失败：${presetExport.status}`);
  if (!presetMarkdown.includes(presetClaim)) throw new Error("预置案例导出缺少新结论");
  if (!presetMarkdown.includes("数据版本")) throw new Error("预置案例导出缺少数据版本");
  console.log("[预置案例导出]", JSON.stringify({ caseId: presetCase.case_id, ...presetBasket, chars: presetMarkdown.length }));
  await page.screenshot({ path: path.join(OUT, "ui-preset-export.png") });
} finally {
  // 预置案例只读，不能删；只清理本次写入的结论
  const findings = await (await fetch(`${URL}/api/findings?case_id=${presetCase.case_id}`)).json();
  const target = (findings.items ?? []).find((item) => item.claim === presetClaim);
  if (target?.finding_id) {
    const removed = await fetch(`${URL}/api/findings/${target.finding_id}`, { method: "DELETE" });
    console.log(`[清理] 删除预置案例自检结论 ${target.finding_id} → ${removed.status}`);
  }
}

// 回到运行列表，继续测运行级筛选（F3：CUSTOM 单页，事件查询是页内工具卡）
await open("light");
await page.select(".topbar select", "CUSTOM");
await page.waitForSelector('[data-testid="custom-overview"]', { timeout: 15000 });
await page.waitForFunction(() => document.querySelectorAll(".custom-overview-body").length > 0);
await ensureStream();
await wait(600);

console.log("== CUSTOM 运行级筛选 ==");
await page.evaluate(() => document.querySelector(".custom-run-identity")?.click());
await page.waitForSelector('[data-testid="custom-run"]', { timeout: 15000 });
await wait(1200);
await ensureStream();
await page.waitForSelector(".stream-head", { timeout: 10000 });
await wait(900);
const runState = await page.evaluate(() => ({
  chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
  scope: document.querySelector('[data-testid="custom-run-scope"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  lane: document.querySelector('[data-testid="custom-run"] .custom-card-head')?.textContent ?? "",
  stream: document.querySelector(".stream-head .muted")?.textContent ?? "",
  streamHead: document.querySelector(".stream-head")?.textContent ?? "",
  rows: document.querySelectorAll(".stream-row").length,
}));
const laneEvents = Number((runState.scope.match(/当前可见\s*([\d,]+)/) ?? [])[1]?.replace(/,/g, "") ?? NaN);
const streamMatched = Number((runState.stream.match(/([\d,]+)\s*条匹配/) ?? [])[1]?.replace(/,/g, "") ?? NaN);
if (!runState.chip.includes("运行 ")) throw new Error(`选中运行后对象摘要未写入 run：${runState.chip}`);
if (!Number.isFinite(laneEvents) || streamMatched !== laneEvents) {
  // 业务断言不允许降级为日志：累计失败并在结束时以非零退出码体现
  failures.push(
    `运行画布与事件流口径不一致：画布 ${laneEvents} 条，事件流 ${streamMatched} 条（stream-head=${JSON.stringify(runState.streamHead)} rows=${runState.rows}）`,
  );
  console.error(
    `FAIL 运行画布与事件流口径：画布 ${laneEvents} 条，事件流 ${streamMatched} 条（stream-head 为空或未打开事件流）`,
  );
} else {
  console.log(`[运行级筛选] 对象=${runState.chip} · 画布 ${laneEvents} 条 = 事件流 ${streamMatched} 条`);
}
await page.screenshot({ path: path.join(OUT, "ui-custom-run.png") });

// 「与正常对照比较」入口：必须能从有已核验配对的运行进入对照
await page.evaluate(() => {
  const back = [...document.querySelectorAll(".custom-run .custom-card-actions .btn")].find((b) =>
    b.textContent?.includes("返回运行集合"),
  );
  back?.click();
});
await page.waitForSelector('[data-testid="custom-overview"]', { timeout: 15000 });
const runsPayload = await (await fetch(`${URL}/api/runs?dataset=CUSTOM`)).json();
const pairedRun = (runsPayload.items ?? []).find((item) => item.has_pair);
if (!pairedRun) throw new Error("没有可用于「与正常对照比较」的已核验配对运行");
await page.evaluate((runId) => {
  document.querySelector(`.custom-overview-row[data-run-id="${runId}"] .custom-run-identity`)?.click();
}, pairedRun.run_id);
await page.waitForSelector('[data-testid="custom-run"]', { timeout: 15000 });
await wait(800);
const compareEntry = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-testid="custom-run"] .custom-card-actions .btn')].find((b) =>
    b.textContent?.includes("与正常对照比较"),
  );
  return btn ? { text: btn.textContent?.trim(), title: btn.getAttribute("title"), disabled: btn.disabled } : null;
});
if (!compareEntry) throw new Error("运行详情缺少「与正常对照比较」入口");
if (compareEntry.disabled) throw new Error(`已核验配对的运行入口仍被禁用：${compareEntry.title}`);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-testid="custom-run"] .custom-card-actions .btn')].find((b) =>
    b.textContent?.includes("与正常对照比较"),
  );
  btn?.click();
});
await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 20000 });
await wait(600);
const compareEntryState = await page.evaluate(() => ({
  pair: document.querySelector('[data-testid="custom-pair"] .custom-card-head')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  normal: document.querySelectorAll(".custom-pair-row").length,
}));
if (!compareEntryState.pair.includes(pairedRun.normal_run_id)) {
  throw new Error(`「与正常对照比较」未进入该运行的已核验配对：${compareEntryState.pair}`);
}
if (compareEntryState.normal !== 7) throw new Error(`配对阶段行应为 7，实际 ${compareEntryState.normal}`);
console.log("[对照入口]", JSON.stringify({ ...compareEntry, run: pairedRun.run_id, ...compareEntryState }));
await page.screenshot({ path: path.join(OUT, "ui-compare-entry.png") });

console.log("== MC1 双声道 ==");
await open("light");
await page.select(".topbar select", "MC1");
await page.waitForSelector(".mc1-page");
// 通用事件查询现在收在页面「工具」菜单里
await page.evaluate(() => {
  const tools = document.querySelector(".mc1-tools");
  if (tools instanceof HTMLDetailsElement) tools.open = true;
});
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".mc1-tools-menu button")].find((n) => n.textContent?.trim() === "事件查询");
  btn?.click();
});
await page.waitForSelector(".mc1-card .stream-row", { timeout: 20000 });
await wait(800);

// 只筛含内部审议的事件
await page.evaluate(() => {
  const box = [...document.querySelectorAll(".stream-head label.check input")][0];
  box?.click();
});
await wait(1000);
const dualRows = await page.$$eval(".mc1-card .stream-row", (ns) => ns.length);
const dualChip = await page.$$eval(".mc1-card .stream-row .tag-delib", (ns) => ns.length);
console.log(`[仅含内心审议] 行数 ${dualRows} · 带标记 ${dualChip}`);

const rows2 = await page.$$(".mc1-card .stream-row");
await rows2[0].click();
await page.waitForSelector(".mc1-reader .dual", { timeout: 15000 });
await wait(600);
const dual = await page.evaluate(() => ({
  width: Math.round(document.querySelector(".mc1-reader")?.getBoundingClientRect().width ?? 0),
  coverage: document.querySelector(".mc1-reader .dual-head .muted")?.textContent,
  left: document.querySelectorAll(".mc1-reader .dual-body")[0]?.textContent?.slice(0, 60),
  right: document.querySelectorAll(".mc1-reader .dual-body")[1]?.textContent?.slice(0, 60),
  tabs: [...document.querySelectorAll(".mc1-reader .dual-tab")].map((t) => t.textContent),
  sources: [...document.querySelectorAll(".mc1-reader .dual-source")].map((t) => t.textContent),
}));
if (!dual.left || !dual.right) throw new Error(`阅读面板没有双声道内容：${JSON.stringify(dual)}`);
console.log("[双声道]", JSON.stringify(dual, null, 1));
await page.screenshot({ path: path.join(OUT, "ui-dual.png") });

console.log("== 关系图 ==");
await open("light");
// F2：先由系统背景成员建立焦点，再用“工具 → 实体关系”打开局部图（旧视图标签已移除）
await page.waitForSelector(".system-node", { timeout: 20000 });
await page.evaluate(() => {
  const node = [...document.querySelectorAll(".system-node")].find((n) => n.textContent?.includes("Agent 执行者")) ?? document.querySelector(".system-node");
  node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await page.waitForSelector(".system-side .trace-item", { timeout: 15000 });
await page.evaluate(() => document.querySelector(".system-side .trace-item")?.click());
await page.waitForSelector('[data-testid="mc2-entity-detail"]', { timeout: 15000 });
await openTool("实体关系");
await page.waitForSelector(".graph-node", { timeout: 20000 });
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
// 系统背景是单页常驻卡片；若被显隐按钮关掉，先打开再滚到卡片
await page.evaluate(() => {
  const toggle = [...document.querySelectorAll(".mc2-toggle")].find((b) => b.textContent?.trim() === "系统背景");
  if (toggle && toggle.getAttribute("aria-pressed") === "false") toggle.click();
  document.querySelector('[aria-label="系统背景"]')?.scrollIntoView({ block: "start" });
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
await open("light");
await page.waitForSelector(".trace-lanes", { timeout: 20000 });
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
await openTool("历史实例");
await page.waitForSelector('[aria-label="历史实例阶段对齐"] .pattern-table', { timeout: 15000 });
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

await openTool("干预论证");
await page.waitForSelector('[aria-label="候选干预"] .intervention-view', { timeout: 15000 });
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
await openTool("转移矩阵");
await page.waitForSelector('[aria-label="转移矩阵"] .transition-table', { timeout: 30000 });
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

console.log("== MC1 参考单页（F1 新入口）==");
await page.waitForSelector(".mc1-page", { timeout: 20000 });
await page.waitForSelector(".mc1-heat-cell", { timeout: 20000 });
await page.waitForSelector(".mc1-track-svg", { timeout: 20000 });
await wait(800);
// 回复分类已迁入事件轨卡片的常显审计行，不再依赖整套决策泳道
const mc1Page = await page.evaluate(() => ({
  agents: document.querySelectorAll(".mc1-heat-label").length,
  columns: document.querySelectorAll(".mc1-heat-col").length,
  emptyCells: document.querySelectorAll(".mc1-heat-cell.is-empty").length,
  anchors: document.querySelectorAll(".mc1-anchor-chip").length,
  messages: document.querySelectorAll(".mc1-track-msg").length,
  releases: document.querySelectorAll(".mc1-track-release").length,
  audit: document.querySelector('[data-testid="mc1-reply-audit"]')?.textContent ?? "",
  networkNodes: document.querySelectorAll(".mc1-node").length,
  taskTabs: document.querySelectorAll(".task-tab").length,
}));
if (mc1Page.agents !== 7) throw new Error(`MC1 热力图应有 7 个角色行，实际 ${mc1Page.agents}`);
if (mc1Page.columns < 2) throw new Error(`MC1 热力图缺少时间列：${mc1Page.columns}`);
if (mc1Page.anchors !== 3) throw new Error(`锚点行应并置 3 个锚点，实际 ${mc1Page.anchors}`);
if (mc1Page.messages < 10) throw new Error(`事件轨消息点过少：${mc1Page.messages}`);
if (mc1Page.releases < 1) throw new Error("事件轨缺少公开发布方块");
if (!mc1Page.audit.includes("future")) throw new Error("缺少回复分类计数（future）");
if (mc1Page.taskTabs !== 0) throw new Error(`MC1 不应再显示四任务导航，实际 ${mc1Page.taskTabs}`);
if (mc1Page.networkNodes !== 7) throw new Error(`回复网络应有 7 个节点，实际 ${mc1Page.networkNodes}`);
// 旧规则面板的“待确认预期”提示未迁移到单页，已登记为暂缓（见 功能迁移登记.md）
console.log("[MC1 单页]", JSON.stringify({ ...mc1Page, audit: mc1Page.audit.slice(0, 60) }));
await page.screenshot({ path: path.join(OUT, "ui-mc1.png") });

console.log("== 基线比较 ==");
await open("light");
// 活动分布的锚点仍写统一时间窗；对照改由“工具 → 时间窗对照”打开
await page.waitForSelector('[aria-label="活动时间分布"] .anchor-chip', { timeout: 20000 });
await page.evaluate(() => document.querySelector('[aria-label="活动时间分布"] .anchor-chip')?.click());
await wait(900);
await openTool("时间窗对照");
await page.waitForSelector('[aria-label="时间窗对照"] .compare-row', { timeout: 15000 });
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

console.log("== 基线比较：手选历史窗与下钻返回 ==");
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[aria-label="对照方式"] .seg-item')].find((b) =>
    b.textContent?.includes("手选历史窗"),
  );
  btn?.click();
});
await page.waitForSelector(".compare-manual-field input", { timeout: 10000 });
// datetime-local 由 React 受控：必须用原生 setter 并派发 input 事件
await page.evaluate(() => {
  const inputs = [...document.querySelectorAll(".compare-manual-field input")];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(inputs[0], "2046-05-17T08:00");
  inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
  setter?.call(inputs[1], "2046-05-17T09:00");
  inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
});
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".compare-manual-actions .btn")].find((b) =>
    b.textContent?.includes("应用历史窗"),
  );
  btn?.click();
});
await wait(900);
const manualCompare = await page.evaluate(() => ({
  head: document.querySelector(".compare-head")?.textContent ?? "",
  rows: document.querySelectorAll(".compare-row-button").length,
  mode: [...document.querySelectorAll('[aria-label="对照方式"] .seg-item')]
    .find((b) => b.classList.contains("seg-active"))?.textContent?.trim(),
  overlap: document.querySelector(".compare .callout-warn strong")?.textContent?.trim() ?? "",
}));
if (!manualCompare.head.includes("08:00") || !manualCompare.head.includes("09:00")) {
  throw new Error(`手选历史窗未生效：${manualCompare.head}`);
}
if (manualCompare.mode !== "手选历史窗") throw new Error(`对照方式未切换：${manualCompare.mode}`);
if (manualCompare.overlap.includes("相交")) throw new Error("手选窗不应与当前窗口相交");
console.log("[手选历史窗]", JSON.stringify(manualCompare));
await page.screenshot({ path: path.join(OUT, "ui-compare-manual.png") });

// 下钻保存比较状态；返回后必须恢复 08:00–09:00 与手选模式
await page.evaluate(() => document.querySelector(".compare-row-button")?.click());
await page.waitForSelector(".compare-return-banner", { timeout: 10000 });
const returnBanner = await page.$eval(".compare-return-banner", (node) => node.textContent?.trim());
if (!returnBanner?.includes("正在查看比较证据")) throw new Error(`缺少比较返回入口：${returnBanner}`);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".compare-return-banner .btn")].find((b) =>
    b.textContent?.includes("返回比较"),
  );
  btn?.click();
});
await page.waitForSelector(".compare-row-button", { timeout: 15000 });
await wait(800);
const restoredCompare = await page.evaluate(() => ({
  head: document.querySelector(".compare-head")?.textContent ?? "",
  mode: [...document.querySelectorAll('[aria-label="对照方式"] .seg-item')]
    .find((b) => b.classList.contains("seg-active"))?.textContent?.trim(),
}));
if (!restoredCompare.head.includes("08:00") || restoredCompare.mode !== "手选历史窗") {
  throw new Error(`返回比较后未恢复历史窗：${JSON.stringify(restoredCompare)}`);
}
console.log("[返回比较]", JSON.stringify(restoredCompare));
await page.screenshot({ path: path.join(OUT, "ui-compare-return.png") });

console.log("== 调查笔记 ==");
await open("light");
await openEventQuery();
const rows4 = await page.$$('[aria-label="事件查询"] .stream-row');
await rows4[0].click();
await ensureEvidenceDock();
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

// 刷新页面，确认笔记没有丢（单页没有常驻事件流，需重新打开查询卡）
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector('[data-testid="mc2-page"]', { timeout: 20000 });
await openEventQuery();
const rows5 = await page.$$('[aria-label="事件查询"] .stream-row');
await rows5[0].click();
await ensureEvidenceDock();
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
await open("light");
await openEventQuery();
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

// ↓ 在事件列表内移动选择：方向键只在列表获得焦点时生效，不抢其他控件的方向键
await page.evaluate(() => document.querySelector(".stream-row")?.focus());
await wait(200);
await page.keyboard.press("ArrowDown");
await wait(700);
const kbdSelect = await page.evaluate(() => ({
  focused: document.activeElement?.getAttribute("data-event-id") ?? null,
  selected: document.querySelector(".stream-row-active")?.getAttribute("data-event-id") ?? null,
  reader: !!document.querySelector(".mc2-reader"),
}));
console.log("[↓ / Enter]", JSON.stringify(kbdSelect));
if (!kbdSelect.focused || kbdSelect.focused !== kbdSelect.selected) {
  failures.push(`事件列表方向键未同步选中行：${JSON.stringify(kbdSelect)}`);
}
if (!kbdSelect.reader) failures.push("事件列表方向键未打开阅读面板");

// Esc 先关阅读面板（页面捕获阶段），不顺手清时间窗
await page.keyboard.press("Escape");
await wait(400);
const readerClosed = await page.evaluate(() => ({
  reader: !!document.querySelector(".mc2-reader"),
  drawer: !!document.querySelector(".drawer"),
}));
console.log(`[Esc 关详情] ${JSON.stringify(readerClosed)}`);
if (readerClosed.reader) failures.push("Esc 未能关闭阅读面板");

// / 聚焦关键词
await page.keyboard.press("/");
await wait(300);
const focused = await page.evaluate(() => document.activeElement?.tagName + ":" + document.activeElement?.getAttribute("type"));
console.log(`[/] 焦点=${focused}`);

console.log("== 证据篮与结论导出 ==");
await open("light");
await openEventQuery();
const caseTitle = `自检案例 ${Date.now()}`;
let caseId = null;
try {
  const rows5 = await page.$$('[aria-label="事件查询"] .stream-row');
  await rows5[0].click();
  await ensureEvidenceDock();
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
// 单页的控制条不再放开发用“渲染基准”按钮；基准视图仍可用 ?bench=1 进入（与 MC1 相同）
await page.goto(`${URL}/?theme=light&bench=1`, { waitUntil: "networkidle0" });
await page.waitForSelector(".bench-actions .btn", { timeout: 20000 });
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

if (failures.length > 0) {
  console.error(`\n业务断言失败 ${failures.length} 项：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exitCode = 1;
}
if (errors.length > 0) {
  console.error(`\n浏览器错误 ${errors.length} 项`);
  process.exitCode = 1;
}

await browser.close();
