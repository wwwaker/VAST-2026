/**
 * F1 MC1 参考界面检查：真实浏览器路径 + 截图。
 * 用法（后端已在独立端口托管 frontend/dist）：
 *   node scripts/check_reference_ui.mjs http://127.0.0.1:8021
 * 截图与结果写入 build/reference-ui/F1/。
 */
import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const URL = process.argv[2] ?? "http://127.0.0.1:8021";
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "build", "reference-ui", "F1");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

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
  if ((r.failure()?.errorText ?? "") === "net::ERR_ABORTED") return;
  errors.push(`请求失败 ${r.url()} (${r.failure()?.errorText})`);
});
page.on("response", (r) => {
  if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log(`  截图 ${name}.png`);
};

async function selectDataset(id) {
  await page.evaluate((value) => {
    const select = document.querySelector(".dataset-field select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("未找到数据集选择器");
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, id);
}

async function setTheme(mode) {
  await page.evaluate((value) => {
    const selects = [...document.querySelectorAll(".topbar select")];
    const target = selects.find((node) => [...node.options].some((o) => o.value === value));
    if (!(target instanceof HTMLSelectElement)) throw new Error("未找到主题选择器");
    target.value = value;
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }, mode);
  await wait(250);
}

async function clickText(selector, text) {
  const handle = await page.evaluateHandle((sel, label) => {
    return [...document.querySelectorAll(sel)].find((node) => node.textContent?.trim() === label) ?? null;
  }, selector, text);
  const element = handle.asElement();
  if (!element) return false;
  await element.click();
  await wait(350);
  return true;
}

console.log(`== 打开 ${URL} ==`);
await page.goto(URL, { waitUntil: "networkidle0" });
await page.waitForSelector(".topbar", { timeout: 20000 });
await selectDataset("MC1");
await page.waitForSelector(".mc1-heat-cell", { timeout: 20000 });
await wait(1200);

// --- 默认页 ---
const heat = await page.evaluate(() => ({
  cells: document.querySelectorAll(".mc1-heat-cell").length,
  rows: document.querySelectorAll(".mc1-heat-label").length,
  cols: document.querySelectorAll(".mc1-heat-col").length,
  emptyCells: document.querySelectorAll(".mc1-heat-cell.is-empty").length,
  hasAnchorChip: !!document.querySelector(".mc1-anchor-chip"),
  networkNodes: document.querySelectorAll(".mc1-node").length,
  networkEdges: document.querySelectorAll(".mc1-edge-hit").length,
  flowSvg: !!document.querySelector(".mc1-lanes"),
  hasToolbarTabs: !!document.querySelector(".view-tabs"),
  modeTabs: document.querySelectorAll(".mode-tab").length,
}));
check("MC1 默认页存在热力图", heat.cells > 0, `cells=${heat.cells} cols=${heat.cols}`);
check("热力图 7 个角色行", heat.rows === 7, `rows=${heat.rows}`);
check("空状态与 0 区分", heat.emptyCells > 0, `empty=${heat.emptyCells}`);
check("锚点条存在", heat.hasAnchorChip);
check("回复网络 7 节点", heat.networkNodes === 7, `nodes=${heat.networkNodes}`);
check("回复网络边可点", heat.networkEdges > 0, `edges=${heat.networkEdges}`);
check("事件轨已渲染", heat.flowSvg);
check("MC1 不再显示兼容视图 tabs", !heat.hasToolbarTabs);
check("MC1 不再显示模式二级 tab", heat.modeTabs === 0, `modeTabs=${heat.modeTabs}`);
await shot("mc1-default-1600-light");

// --- 热力图与事件轨的列对齐 / 滚动同步 ---
const align = await page.evaluate(() => ({
  heat: document.querySelector(".mc1-heat-grid")?.getBoundingClientRect().width ?? 0,
  track: document.querySelector(".mc1-track-svg")?.getBoundingClientRect().width ?? 0,
  msgs: document.querySelectorAll(".mc1-track-msg").length,
  releases: document.querySelectorAll(".mc1-track-release").length,
  lanes: document.querySelectorAll(".mc1-track-lane-label").length,
}));
check("事件轨与热力图同宽同列", Math.abs(align.heat - align.track) <= 2, `heat=${align.heat} track=${align.track}`);
check("事件轨有真实消息点与发布", align.msgs > 0 && align.releases > 0, `msgs=${align.msgs} releases=${align.releases}`);
check("事件轨三轨齐备", align.lanes === 3, `lanes=${align.lanes}`);

// 按轮次粒度（列更宽）制造横向溢出后再验证滚动同步
await clickText(".seg-item", "按轮次");
await wait(1200);
const sync = await page.evaluate(async () => {
  const heat = document.querySelector(".mc1-heat-scroll");
  if (!(heat instanceof HTMLElement)) return { ok: false, reason: "no-heat-scroll" };
  heat.scrollLeft = 160;
  await new Promise((r) => setTimeout(r, 400));
  const track = document.querySelector(".mc1-track-scroll");
  const value = track instanceof HTMLElement ? track.scrollLeft : -1;
  const target = heat.scrollLeft;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  const canvas = document.querySelector(".canvas-area");
  const meta = {
    scrollWidth: heat.scrollWidth,
    clientWidth: heat.clientWidth,
    cols: document.querySelectorAll(".mc1-heat-col").length,
    canvasOverflow: canvas ? canvas.scrollWidth - canvas.clientWidth : -1,
  };
  heat.scrollLeft = 0;
  return { ok: Math.abs(value - target) <= 1 && target > 0, value, target, overflow, meta };
});
check(
  "横向滚动同步到事件轨",
  sync.ok,
  `heat=${sync.target} track=${sync.value} cols=${sync.meta?.cols} scrollW=${sync.meta?.scrollWidth} clientW=${sync.meta?.clientWidth}`,
);
check("宽表粒度画布无横向溢出", sync.meta?.canvasOverflow <= 1, `canvasOverflow=${sync.meta?.canvasOverflow}`);
await clickText(".seg-item", "按天");
await wait(900);

const scrolled = await page.evaluate(() => {
  const canvas = document.querySelector(".canvas-area");
  const track = document.querySelector('.mc1-card[aria-label="事件轨"]');
  if (!(canvas instanceof HTMLElement) || !(track instanceof HTMLElement)) return false;
  canvas.scrollTop = track.offsetTop - 60;
  return true;
});
if (scrolled) {
  await wait(500);
  await shot("mc1-event-track-1600-light");
  await page.evaluate(() => {
    const canvas = document.querySelector(".canvas-area");
    if (canvas instanceof HTMLElement) canvas.scrollTop = 0;
  });
  await wait(300);
}

// --- 点格 → 消息集合 → 展开正文 ---
const cellClicked = await page.evaluate(() => {
  const cell = [...document.querySelectorAll(".mc1-heat-cell")].find(
    (node) => !node.classList.contains("is-empty"),
  );
  if (!(cell instanceof HTMLElement)) return false;
  cell.click();
  return true;
});
check("点击热力格", cellClicked);
await page.waitForSelector(".mc1-detail-card", { timeout: 10000 });
await wait(800);
const detail = await page.evaluate(() => ({
  msgs: document.querySelectorAll(".mc1-detail-card .mc1-msg").length,
  title: document.querySelector(".mc1-detail-card strong")?.textContent?.trim() ?? "",
  emptyText: document.querySelector(".mc1-detail-card")?.textContent?.includes("没有匹配消息") ?? false,
  globalFilterChanged: !!document.querySelector(".mc1-detail-card .btn-quiet"),
}));
check("点格打开真实消息集合", detail.msgs > 0 || detail.emptyText, `msgs=${detail.msgs} title=${detail.title}`);
await shot("mc1-cell-1600-light");

if (detail.msgs > 0) {
  await page.evaluate(() => document.querySelector(".mc1-detail-card .mc1-msg-head")?.click());
  await wait(1100);
  const expanded = await page.evaluate(() => {
    const text = document.querySelector(".mc1-detail-card")?.textContent ?? "";
    return {
      outgoing: text.includes("外发内容"),
      deliberation: text.includes("内部审议"),
      raw: text.includes("原始字段"),
      eventId: text.includes("event_id"),
    };
  });
  check("展开消息显示外发内容", expanded.outgoing);
  check("展开消息显示内部审议", expanded.deliberation);
  check("展开消息显示原始字段", expanded.raw && expanded.eventId);
  await shot("mc1-message-detail-1600-light");
}

// --- 网络边证据 ---
await page.evaluate(() => {
  const hit = document.querySelector(".mc1-edge-hit");
  hit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await wait(900);
const edgeDetail = await page.evaluate(() => {
  const card = document.querySelector('[aria-label="回复边证据"]');
  return { exists: !!card, text: card?.textContent?.slice(0, 80) ?? "" };
});
check("点击网络边读取真实证据", edgeDetail.exists, edgeDetail.text);
await shot("mc1-edge-evidence-1600-light");

// --- 筛选面板与图表显隐 ---
check("打开筛选面板", await clickText(".mc1-toggle", "筛选"));
await wait(300);
check("筛选面板出现", await page.evaluate(() => !!document.querySelector(".mc1-filters")));
await shot("mc1-filters-1600-light");

check("关闭筛选面板", await clickText(".mc1-toggle", "筛选"));
await wait(200);

check("并排开关可用", await clickText(".mc1-toggle", "并排"));
await wait(500);
check(
  "并排布局生效",
  await page.evaluate(() => !!document.querySelector(".mc1-columns.is-side-by-side")),
);
await shot("mc1-side-by-side-1600-light");
await clickText(".mc1-toggle", "并排");
await wait(300);

check("隐藏事件轨", await clickText(".mc1-toggle", "事件轨"));
await wait(300);
check("事件轨可隐藏", await page.evaluate(() => !document.querySelector('.mc1-card[aria-label="事件轨"]')));
await clickText(".mc1-toggle", "事件轨");
await wait(600);
check("事件轨可恢复", await page.evaluate(() => !!document.querySelector('.mc1-card[aria-label="事件轨"]')));

// ================= R3：截断必须显式，且关键事件可达 =================
const trunc = await page.evaluate(() => {
  const box = document.querySelector('[data-testid="mc1-track-truncation"]');
  return {
    exists: !!box,
    text: (box?.textContent ?? "").replace(/\s+/g, " ").trim(),
    pinned: [...document.querySelectorAll(".mc1-track-msg.is-pinned, .mc1-track-release.is-pinned")].map((n) =>
      n.getAttribute("data-event-id"),
    ),
    drawn: document.querySelectorAll(".mc1-track-msg").length,
  };
});
check(
  "事件轨显式标注截断与真实条数",
  trunc.exists && trunc.text.includes("912") && trunc.text.includes("800"),
  trunc.text.slice(0, 130),
);
check(
  "截断时补入 17:25 确认与 18:00 解禁",
  trunc.pinned.includes("MC1:event:20460605_21_026") && trunc.pinned.includes("MC1:event:20460605_22_001"),
  `pinned=${trunc.pinned.join(",")}`,
);
await shot("mc1-review-truncation");

// ================= R4：事件轨点击要直接有可读结果 =================
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".topbar-docks button")].find((n) => n.textContent?.includes("证据"));
  if (btn?.getAttribute("aria-pressed") === "true") btn.click();
});
await wait(500);
check("证据坞初始关闭", await page.evaluate(() => !document.querySelector(".evidence-dock")));
await page.evaluate(() => {
  document.querySelector(".mc1-track-msg")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await wait(1400);
const trackOpen = await page.evaluate(() => ({
  dock: !!document.querySelector(".evidence-dock"),
  drawer: !!document.querySelector(".drawer"),
  text: (document.querySelector(".drawer")?.textContent ?? "").slice(0, 160),
  selected: document.querySelector(".mc1-track-msg.is-selected")?.getAttribute("data-event-id") ?? null,
}));
check(
  "点击事件轨直接打开事件详情",
  trackOpen.dock && trackOpen.drawer && trackOpen.text.length > 20,
  `selected=${trackOpen.selected}`,
);
await shot("mc1-review-track-drawer");
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".topbar-docks button")].find((n) => n.textContent?.includes("证据"));
  if (btn?.getAttribute("aria-pressed") === "true") btn.click();
});
await wait(400);

// ================= R1：点格只读"当前窗口 ∩ 该格" =================
await page.evaluate(() => {
  const chip = [...document.querySelectorAll(".mc1-anchor-chip")].find((n) =>
    n.textContent?.includes("首条内部确认"),
  );
  chip?.querySelector(".mc1-anchor-action")?.click();
});
await wait(1300);
const r1 = await page.evaluate(() => {
  const cell = [...document.querySelectorAll(".mc1-heat-cell")]
    .filter((n) => (n.getAttribute("aria-label") ?? "").startsWith("Legal-Agent"))
    .pop();
  if (!(cell instanceof HTMLElement)) return null;
  const nums = [...cell.querySelectorAll(".mc1-cell-nums em")].map((n) => Number(n.textContent));
  const expected = nums.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  cell.click();
  return { expected, label: cell.getAttribute("aria-label") };
});
await page.waitForSelector('[data-testid="mc1-cell-detail"]', { timeout: 10000 });
await wait(1200);
const r1Detail = await page.evaluate(() => {
  const card = document.querySelector('[data-testid="mc1-cell-detail"]');
  return {
    total: Number(card?.getAttribute("data-total") ?? -1),
    window: card?.querySelector(".mc1-detail-head .mono")?.textContent?.replace(/\s+/g, " ") ?? "",
    rows: card?.querySelectorAll(".mc1-msg").length ?? 0,
    firstTime: card?.querySelector(".mc1-msg-time")?.textContent?.trim() ?? "",
  };
});
check("点格详情总数 = 该格显示条数", r1Detail.total === r1?.expected, `total=${r1Detail.total} expected=${r1?.expected} label=${r1?.label}`);
check("点格详情收窄到当前窗口", r1Detail.window.includes("16:55") && r1Detail.window.includes("17:55"), r1Detail.window);
check("点格详情首条时间在窗口内", /1[67]:/.test(r1Detail.firstTime), r1Detail.firstTime);
await shot("mc1-review-cell-window");

// 角色筛选冲突：不能读到被排除角色的消息
await page.evaluate(() => {
  const toggle = [...document.querySelectorAll(".mc1-toggle")].find((n) => n.textContent?.trim() === "筛选");
  toggle?.click();
});
await wait(400);
const actorFiltered = await page.evaluate(() => {
  const button = document.querySelector('[data-actor-id="MC1:agent:social_media_agent"]');
  if (!(button instanceof HTMLElement)) return false;
  button.click();
  return true;
});
await wait(1200);
check(
  "角色筛选生效",
  actorFiltered &&
    (await page.evaluate(
      () => document.querySelector('[data-actor-id="MC1:agent:social_media_agent"]')?.getAttribute("aria-pressed") === "true",
    )),
);
await page.evaluate(() => {
  const cell = [...document.querySelectorAll(".mc1-heat-cell")]
    .filter((n) => (n.getAttribute("aria-label") ?? "").startsWith("Legal-Agent"))
    .pop();
  cell?.click();
});
await wait(900);
const conflict = await page.evaluate(() => {
  const card = document.querySelector('[data-testid="mc1-cell-detail"]');
  return {
    total: Number(card?.getAttribute("data-total") ?? -1),
    note: card?.querySelector(".callout")?.textContent?.trim() ?? "",
  };
});
check("角色筛选冲突时按空集处理", conflict.total === 0 && conflict.note.includes("按空集处理"), `total=${conflict.total} note=${conflict.note.slice(0, 60)}`);
await clickText(".btn", "清空筛选");
await wait(1000);
await page.evaluate(() => {
  const toggle = [...document.querySelectorAll(".mc1-toggle")].find((n) => n.textContent?.trim() === "筛选");
  if (document.querySelector(".mc1-filters")) toggle?.click();
});
await wait(300);

// ================= R2：渠道按钮与真实筛选同源 =================
await clickText(".seg-item", "公开发布");
await wait(1100);
const channelPressed = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.seg[aria-label="渠道范围"] .seg-item')]
      .filter((n) => n.getAttribute("aria-pressed") === "true")
      .map((n) => n.textContent.trim()),
  );
const scopePublic = await page.evaluate(() => ({
  counts: document.querySelector(".mc1-heat-counts")?.textContent?.replace(/\s+/g, " ") ?? "",
}));
scopePublic.pressed = await channelPressed();
check("公开渠道按钮与请求一致", scopePublic.pressed.includes("公开发布") && !/匹配消息 912/.test(scopePublic.counts), scopePublic.counts);
await clickText(".btn", "清空筛选");
await wait(1200);
const scopeCleared = await page.evaluate(() => ({
  counts: document.querySelector(".mc1-heat-counts")?.textContent?.replace(/\s+/g, " ") ?? "",
  custom: !!document.querySelector('[data-testid="mc1-custom-scope"]'),
}));
scopeCleared.pressed = await channelPressed();
check(
  "清空后渠道按钮回到全部渠道",
  scopeCleared.pressed.length === 1 && scopeCleared.pressed[0] === "全部渠道" && !scopeCleared.custom,
  scopeCleared.pressed.join(","),
);
check("清空后计数回到 912", /匹配消息 912/.test(scopeCleared.counts), scopeCleared.counts);
await shot("mc1-review-scope-clear");

// ================= R5：键盘开关与焦点返回 =================
const kbKey = await page.evaluate(() => {
  const cell = [...document.querySelectorAll(".mc1-heat-cell")].find((n) => !n.classList.contains("is-empty"));
  if (!(cell instanceof HTMLElement)) return null;
  cell.focus();
  return cell.getAttribute("data-cell-key");
});
await page.keyboard.press("Enter");
await wait(900);
const kbOpen = await page.evaluate(() => !!document.querySelector('[data-testid="mc1-cell-detail"]'));
check("键盘 Enter 打开格详情", kbOpen);
// 先展开一条消息，使 selectedEventId 有值（复现「关闭」被全局 Enter 抢走）
await page.evaluate(() => document.querySelector('[data-testid="mc1-cell-detail"] .mc1-msg-head')?.click());
await wait(1000);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-testid="mc1-cell-detail"] .btn-quiet')].find(
    (n) => n.textContent?.trim() === "关闭",
  );
  btn?.focus();
});
await page.keyboard.press("Enter");
await wait(600);
const kbClose = await page.evaluate(() => ({
  detail: !!document.querySelector('[data-testid="mc1-cell-detail"]'),
  drawer: !!document.querySelector(".evidence-dock .drawer"),
  activeKey: document.activeElement?.getAttribute("data-cell-key") ?? null,
}));
check("Enter 关闭详情不会误开证据坞", !kbClose.detail && !kbClose.drawer, `detail=${kbClose.detail} drawer=${kbClose.drawer}`);
check("关闭后焦点回到触发格", kbClose.activeKey === kbKey, `active=${kbClose.activeKey}`);
const envFocus = await page.evaluate(() => {
  const env = document.querySelector(".mc1-track-env");
  if (!env || typeof env.focus !== "function") return false;
  env.focus();
  return document.activeElement === env;
});
check("环境标记可键盘聚焦", envFocus);
if (envFocus) {
  await page.keyboard.press("Enter");
  await wait(500);
  check("Enter 打开环境记录详情", await page.evaluate(() => !!document.querySelector('[data-testid="mc1-env-detail"]')));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid="mc1-env-detail"] .btn-quiet')].find(
      (n) => n.textContent?.trim() === "关闭",
    );
    btn?.click();
  });
  await wait(500);
  check(
    "环境详情可关闭",
    await page.evaluate(() => !document.querySelector('[data-testid="mc1-env-detail"]')),
  );
}
await shot("mc1-review-keyboard");

// ================= R7：补入关键事件不得绕过渠道/角色筛选 =================
await clickText(".seg-item", "公开发布");
await wait(1400);
const pinPublic = await page.evaluate(() => ({
  msgs: document.querySelectorAll(".mc1-track-msg").length,
  internal: document.querySelectorAll(".mc1-track-msg:not(.is-public)").length,
  pinned: document.querySelectorAll(".mc1-track-msg.is-pinned, .mc1-track-release.is-pinned").length,
  counts: document.querySelector(".mc1-heat-counts")?.textContent?.replace(/\s+/g, " ") ?? "",
  truncated: !!document.querySelector('[data-testid="mc1-track-truncation"]'),
}));
check("公开渠道事件轨 = 77 条且无内部记录", pinPublic.msgs === 77 && pinPublic.internal === 0, JSON.stringify(pinPublic));
check("公开渠道不出现补入标记", pinPublic.pinned === 0 && !pinPublic.truncated, `pinned=${pinPublic.pinned}`);
await shot("mc1-review-public-track");

await clickText(".seg-item", "全部渠道");
await wait(1200);
await page.evaluate(() => {
  const toggle = [...document.querySelectorAll(".mc1-toggle")].find((n) => n.textContent?.trim() === "筛选");
  toggle?.click();
});
await wait(400);
await page.evaluate(() => document.querySelector('[data-actor-id="MC1:agent:pr_agent"]')?.click());
await page.evaluate(() => {
  const toggle = [...document.querySelectorAll(".mc1-toggle")].find((n) => n.textContent?.trim() === "筛选");
  if (document.querySelector(".mc1-filters")) toggle?.click();
});
await wait(1500);
const pinActor = await page.evaluate(() => ({
  msgs: document.querySelectorAll(".mc1-track-msg").length,
  pinned: document.querySelectorAll(".mc1-track-msg.is-pinned").length,
  actorLabel: [...document.querySelectorAll(".mc1-track-msg")]
    .slice(0, 3)
    .map((n) => n.getAttribute("aria-label") ?? ""),
}));
check("PR-Agent 筛选下事件轨 = 101 条且无补入", pinActor.msgs === 101 && pinActor.pinned === 0, `msgs=${pinActor.msgs} pinned=${pinActor.pinned}`);
await clickText(".btn", "清空筛选");
await wait(1200);

// ================= R8：网络节点不替换角色筛选 =================
await page.evaluate(() => {
  const toggle = [...document.querySelectorAll(".mc1-toggle")].find((n) => n.textContent?.trim() === "筛选");
  toggle?.click();
});
await wait(400);
await page.evaluate(() => document.querySelector('[data-actor-id="MC1:agent:social_media_agent"]')?.click());
await page.evaluate(() => {
  const toggle = [...document.querySelectorAll(".mc1-toggle")].find((n) => n.textContent?.trim() === "筛选");
  if (document.querySelector(".mc1-filters")) toggle?.click();
});
await wait(1200);
await page.evaluate(() => {
  const node = [...document.querySelectorAll(".mc1-node")].find((n) =>
    (n.getAttribute("aria-label") ?? "").startsWith("Legal-Agent"),
  );
  if (node instanceof SVGElement) node.focus();
  node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await wait(1200);
const nodeConflict = await page.evaluate(() => {
  const card = document.querySelector('[aria-label="节点消息"]');
  return {
    exists: !!card,
    text: (card?.textContent ?? "").replace(/\s+/g, " ").slice(0, 120),
    total: Number((card?.textContent ?? "").match(/共 (\d+) 条/)?.[1] ?? -1),
    rows: card?.querySelectorAll(".mc1-msg").length ?? 0,
  };
});
check(
  "角色筛选冲突时节点详情为空集",
  nodeConflict.exists && nodeConflict.total === 0 && nodeConflict.rows === 0 && nodeConflict.text.includes("按空集处理"),
  JSON.stringify(nodeConflict),
);
await shot("mc1-review-node-conflict");
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[aria-label="节点消息"] .btn-quiet')].find(
    (n) => n.textContent?.trim() === "关闭",
  );
  btn?.click();
});
await wait(400);
await clickText(".btn", "清空筛选");
await wait(1200);

// ================= R9：环境/边/节点的键盘关闭焦点 =================
const envKey = await page.evaluate(() => {
  const env = document.querySelector(".mc1-track-env");
  if (!env || typeof env.focus !== "function") return null;
  env.focus();
  return env.getAttribute("data-context-id");
});
await page.keyboard.press("Enter");
await wait(600);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-testid="mc1-env-detail"] .btn-quiet')].find(
    (n) => n.textContent?.trim() === "关闭",
  );
  btn?.focus();
});
await page.keyboard.press("Enter");
await wait(500);
const envFocusBack = await page.evaluate(() => ({
  detail: !!document.querySelector('[data-testid="mc1-env-detail"]'),
  active: document.activeElement?.getAttribute("data-context-id") ?? null,
  tag: document.activeElement?.tagName ?? "",
}));
check(
  "环境详情键盘关闭后焦点回到原标记",
  !envFocusBack.detail && envFocusBack.active === envKey,
  `active=${envFocusBack.active} tag=${envFocusBack.tag}`,
);

const edgeKey = await page.evaluate(() => {
  const edge = document.querySelector(".mc1-edge-hit");
  if (!edge || typeof edge.focus !== "function") return null;
  edge.focus();
  return edge.getAttribute("aria-label");
});
await page.keyboard.press("Enter");
await wait(700);
check("键盘 Enter 打开边详情", await page.evaluate(() => !!document.querySelector('[aria-label="回复边证据"]')));
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[aria-label="回复边证据"] .btn-quiet')].find(
    (n) => n.textContent?.trim() === "关闭",
  );
  btn?.focus();
});
await page.keyboard.press("Enter");
await wait(500);
const edgeFocusBack = await page.evaluate(() => ({
  detail: !!document.querySelector('[aria-label="回复边证据"]'),
  active: document.activeElement?.getAttribute("aria-label") ?? null,
}));
check(
  "边详情键盘关闭后焦点回到原边",
  !edgeFocusBack.detail && edgeFocusBack.active === edgeKey,
  `active=${edgeFocusBack.active}`,
);

const nodeKey = await page.evaluate(() => {
  const node = document.querySelector(".mc1-node");
  if (!node || typeof node.focus !== "function") return null;
  node.focus();
  return node.getAttribute("aria-label");
});
await page.keyboard.press("Enter");
await wait(700);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[aria-label="节点消息"] .btn-quiet')].find(
    (n) => n.textContent?.trim() === "关闭",
  );
  btn?.focus();
});
await page.keyboard.press("Enter");
await wait(500);
const nodeFocusBack = await page.evaluate(() => ({
  detail: !!document.querySelector('[aria-label="节点消息"]'),
  active: document.activeElement?.getAttribute("aria-label") ?? null,
}));
check(
  "节点详情键盘关闭后焦点回到原节点",
  !nodeFocusBack.detail && nodeFocusBack.active === nodeKey,
  `active=${nodeFocusBack.active}`,
);
await shot("mc1-review-focus-return");

// --- 深色主题 ---
await setTheme("dark");
await wait(500);
await shot("mc1-default-dark");
check("深色主题下热力图可读", await page.evaluate(() => {
  const cell = document.querySelector(".mc1-heat-cell");
  if (!cell) return false;
  const style = getComputedStyle(cell);
  return style.color !== style.backgroundColor;
}));
await setTheme("light");
await wait(300);

// --- 尺寸 ---
await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
await wait(700);
await shot("mc1-1366-light");

await page.setViewport({ width: 1024, height: 900, deviceScaleFactor: 1 });
await wait(700);
const at1024 = await page.evaluate(() => {
  const columns = document.querySelector(".mc1-columns");
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    colsDirection: columns ? getComputedStyle(columns).flexDirection : "none",
  };
});
check("1024 无页面横向溢出", at1024.overflow <= 1, `overflow=${at1024.overflow}`);
await shot("mc1-1024-light");

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await wait(700);
// 打开一个详情再关闭，验证窄屏可关闭
await page.evaluate(() => {
  const cell = [...document.querySelectorAll(".mc1-heat-cell")].find(
    (node) => !node.classList.contains("is-empty"),
  );
  cell?.click();
});
await wait(900);
const narrow = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - window.innerWidth,
  detail: !!document.querySelector(".mc1-detail-card"),
}));
check("390 无页面横向溢出", narrow.overflow <= 1, `overflow=${narrow.overflow}`);
await shot("mc1-390-detail");
check("390 详情可关闭", await clickText(".mc1-detail-card .btn-quiet", "关闭"));
await wait(300);
check("390 关闭后详情消失", await page.evaluate(() => !document.querySelector(".mc1-detail-card")));
await shot("mc1-390-light");

// --- MC2 / CUSTOM 最小回归 ---
await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
for (const id of ["MC2", "CUSTOM"]) {
  await selectDataset(id);
  await wait(1500);
  const state = await page.evaluate(() => ({
    canvas: !!document.querySelector(".canvas-area"),
    hasContent: (document.querySelector(".canvas-area")?.textContent ?? "").trim().length > 40,
    heat: !!document.querySelector(".mc1-heat-cell"),
  }));
  check(`${id} 页面仍可打开`, state.canvas && state.hasContent, `heat=${state.heat}`);
  await shot(`mc1-regression-${id}`);
}

const uniqueErrors = [...new Set(errors)];
check("无控制台/网络错误", uniqueErrors.length === 0, uniqueErrors.slice(0, 3).join(" | "));

const failed = results.filter((item) => !item.ok);
fs.writeFileSync(
  path.join(OUT, "check-reference-ui.json"),
  JSON.stringify({ url: URL, at: new Date().toISOString(), results, errors: uniqueErrors }, null, 2),
);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (uniqueErrors.length) console.log("错误：\n" + uniqueErrors.slice(0, 10).join("\n"));

await browser.close();
process.exit(failed.length ? 1 : 0);
