/**
 * F2 · MC2 参考风格单页验收（浏览器）。
 *
 * 依赖真实后端（默认 http://127.0.0.1:8016），不做 mock、不准备 --fresh 数据。
 * 覆盖：单页结构、目标帖定位、来源链/文件/候选、系统背景聚合、历史实例、干预单选、
 * 转移矩阵、时间窗对照与返回、统一阅读面板、筛选与图表显隐、键盘、响应式、深浅色、
 * 数据集隔离、带根/文件的快照保存，以及失败态不崩溃。
 *
 * 复核回归（2026-11-09 独立复核 R1–R6 / K1–K2）：底部打开后阅读面板是否真的可见、
 * 历史阶段与转移证据的正文 ID、缺失引用恢复（不请求/不留旧正文/重存保留）、
 * 候选文件恢复后的身份、恢复后切数据集回到默认链根、隐藏来源链后的恢复落点与显式定位、
 * 关闭回焦（含 SVG 与已卸载行）、文件行“设为链根”。
 *
 * 输出：UI_CHECK_OUT 或 build/reference-ui/F2/final；
 * 清理：仅删除本次创建的案例，保留用户已有笔记与案例。
 */
import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:8016";
const out = process.env.UI_CHECK_OUT
  ? path.resolve(process.env.UI_CHECK_OUT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../build/reference-ui/F2/final");
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
const created = [];
const results = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
page.on("response", (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, fn) => {
  try {
    fn();
    results.push({ label, ok: true });
    console.log(`PASS ${label}`);
  } catch (err) {
    results.push({ label, ok: false, detail: String(err?.message ?? err) });
    console.error(`FAIL ${label}: ${err?.message ?? err}`);
  }
};
const shot = async (name) => {
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log(`  截图 ${name}.png`);
};
const openTools = () =>
  page.evaluate(() => {
    const tools = document.querySelector(".mc2-tools");
    if (tools instanceof HTMLDetailsElement) tools.open = true;
  });
const clickText = async (selector, text) => {
  const found = await page.evaluate((sel, label) => {
    const node = [...document.querySelectorAll(sel)].find((n) => n.textContent?.trim().includes(label));
    node?.click();
    return !!node;
  }, selector, text);
  assert.ok(found, `找不到 ${selector} 中的「${text}」`);
};
const openTool = async (label) => {
  await openTools();
  await clickText(".mc2-tools-menu button", label);
  await sleep(400);
};
const closeCard = async (label) => {
  await page.evaluate((aria) => {
    const card = document.querySelector(`[aria-label="${aria}"]`);
    const btn = card ? [...card.querySelectorAll(".mc2-card-head .btn")].find((b) => b.textContent?.includes("返回 MC2")) : null;
    btn?.click();
  }, label);
  await sleep(400);
};
const readerCount = () => page.evaluate(() => document.querySelectorAll(".mc2-reader").length);
const scrollToCard = (aria) => page.evaluate(
  (label) => document.querySelector(`[aria-label="${label}"]`)?.scrollIntoView({ block: "start" }),
  aria,
);
const ensureEvidence = async () => {
  if (!(await page.$(".drawer"))) await clickText(".topbar-docks button", "证据");
  await page.waitForSelector(".drawer");
};

try {
  // ---------- 1. 首屏与结构 ----------
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="mc2-page"]', { timeout: 30000 });
  await page.select(".dataset-field select", "MC2");
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
  await page.waitForSelector(".trace-lanes", { timeout: 30000 });
  await sleep(1200);
  const structure = await page.evaluate(() => ({
    taskTabs: document.querySelectorAll(".task-tab").length,
    modeTabs: document.querySelectorAll(".mode-tab").length,
    viewTabs: document.querySelectorAll(".view-tab").length,
    eventDock: !!document.querySelector(".event-dock"),
    statusbar: !!document.querySelector(".statusbar"),
    chain: !!document.querySelector('[data-testid="mc2-trace-card"]'),
    chart: !!document.querySelector('[aria-label="活动时间分布"] .chart-wrap canvas'),
    system: document.querySelectorAll(".system-node").length,
    reader: document.querySelectorAll(".mc2-reader").length,
    context: [...document.querySelectorAll(".mc2-context > *")].map((n) => n.textContent?.replace(/\s+/g, " ").trim()),
    root: document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "",
    window: document.querySelector(".mc2-window")?.textContent?.trim() ?? "",
  }));
  check("MC2 是单页：无重复任务/模式/视图导航，无事件流坞与状态栏", () => {
    assert.equal(structure.taskTabs, 0);
    assert.equal(structure.modeTabs, 0);
    assert.equal(structure.viewTabs, 0);
    assert.equal(structure.eventDock, false);
    assert.equal(structure.statusbar, false);
  });
  check("首屏有真实图形：来源链 + 活动分布 + 系统背景聚合", () => {
    assert.ok(structure.chain);
    assert.ok(structure.chart);
    assert.ok(structure.system >= 8, `聚合组 ${structure.system}`);
    assert.equal(structure.reader, 0);
  });
  check("范围例外常显：系统背景/历史干预不随筛选，回放遮蔽状态可见", () => {
    const text = structure.context.join(" | ");
    assert.ok(text.includes("系统背景=全量类型聚合"), text);
    assert.ok(text.includes("历史/干预=固定全量分析"), text);
    assert.ok(text.includes("回放遮蔽"), text);
  });
  check("默认链根来自 manifest 目标帖 373902（2046-05-17 11:21）", () => {
    assert.match(structure.root, /MC2:event:373902/);
    assert.ok(structure.window.includes("全时间范围"), structure.window);
  });
  await shot("default-1600-light");

  // ---------- 2. 目标帖定位 ----------
  const beforeLocate = await page.evaluate(() => ({
    window: document.querySelector(".mc2-window")?.textContent?.trim(),
    root: document.querySelector(".mc2-root-event")?.textContent?.trim(),
  }));
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".mc2-anchor-chip")].find((c) => c.textContent?.includes("目标帖子"));
    const action = chip ? [...chip.querySelectorAll(".mc2-anchor-action")].find((b) => b.textContent?.trim() === "定位") : null;
    action?.click();
  });
  await sleep(1200);
  const located = await page.evaluate(() => ({
    window: document.querySelector(".mc2-window")?.textContent?.trim(),
    root: document.querySelector(".mc2-root-event")?.textContent?.trim(),
    head: document.querySelector(".trace-head")?.textContent?.replace(/\s+/g, " ") ?? "",
    chip: document.querySelector(".mc2-anchor-chip")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("定位目标帖只改链根/当前文件，不改统一时间窗", () => {
    assert.equal(located.window, beforeLocate.window);
    assert.match(located.root, /MC2:event:373902/);
    assert.ok(located.head.includes("SwiftWren"), located.head);
    assert.ok(located.chip.includes("11:21"), located.chip);
  });
  await shot("target-located-1600-light");

  // ---------- 3. 来源链与记录层 ----------
  const trace = await page.evaluate(() => ({
    chips: document.querySelectorAll(".trace-roots .seg-item").length,
    candidate: document.querySelector(".trace-chain .tag-warn")?.textContent?.trim() ?? "",
    status: [...document.querySelectorAll(".trace-chain .callout code")].map((n) => n.textContent?.trim()),
    head: document.querySelector(".trace-head .muted")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    records: [...document.querySelectorAll(".trace-chain .trace-item")].map((n) => n.textContent?.replace(/\s+/g, " ").trim()),
    lanes: !!document.querySelector(".trace-lanes"),
    fileLabel: !!document.querySelector(".trace-lanes text"),
  }));
  check("来源链：3 个日志记录根、记录边/候选边/预算可见", () => {
    assert.equal(trace.chips, 3);
    assert.ok(trace.lanes && trace.fileLabel);
    assert.ok(trace.head.includes("记录边"), trace.head);
    assert.ok(trace.head.includes("候选边"), trace.head);
  });
  check("候选层明确标注“不能据此认定传播”，metadata_only 不伪装正文", () => {
    assert.ok(trace.records.some((row) => row.includes("候选")), JSON.stringify(trace.records));
    assert.ok(trace.status.includes("metadata_only"), JSON.stringify(trace.status));
    const chainText = trace.records.join(" ");
    assert.ok(chainText.includes("create_file") && chainText.includes("delete_file"), chainText);
  });

  // 点记录打开事件阅读面板（唯一面板）
  const recordId = await page.evaluate(() => {
    const row = document.querySelector(".trace-chain .trace-item");
    row?.click();
    return row?.closest("li")?.querySelector(".mono")?.textContent?.trim() ?? "";
  });
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
  await sleep(500);
  const eventReader = await page.evaluate(() => ({
    readers: document.querySelectorAll(".mc2-reader").length,
    id: document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim(),
    raw: document.querySelectorAll('[data-testid="mc2-event-detail"] .mc2-raw-details').length,
    actions: [...document.querySelectorAll('[data-testid="mc2-event-detail"] .mc2-msg-actions .btn')].map((n) => n.textContent?.trim()),
    sourceNote: document.querySelector('[data-testid="mc2-event-detail"] .callout-warn strong')?.textContent?.trim() ?? "",
    contentButton: !!document.querySelector('[data-testid="mc2-event-detail"] .callout-warn .btn'),
  }));
  check("记录层点击 → 唯一阅读面板显示原始记录与完整 raw/details", () => {
    assert.equal(eventReader.readers, 1);
    assert.match(eventReader.id ?? "", /^MC2:event:/);
    assert.equal(eventReader.raw, 2);
    assert.ok(eventReader.actions.some((t) => t === "支持"));
  });
  await shot("event-reader-1600-light");

  // Esc 关闭并回焦触发控件
  await page.keyboard.press("Escape");
  await sleep(400);
  const escState = await page.evaluate(() => ({
    readers: document.querySelectorAll(".mc2-reader").length,
    focusId: document.activeElement?.getAttribute("data-event-id") ?? null,
    chainItemFocused: document.activeElement?.classList.contains("trace-item") ?? false,
  }));
  check("Esc 关闭阅读面板，焦点回到触发行", () => {
    assert.equal(escState.readers, 0);
    assert.ok(escState.chainItemFocused || escState.focusId, JSON.stringify(escState));
  });

  // 目标帖（链根）本身可读，并说明“只有来源文件名、没有正文”
  await page.evaluate(() => document.querySelector(".mc2-root-event")?.click());
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
  await page.waitForSelector('[data-testid="mc2-event-detail"] .callout-warn', { timeout: 20000 });
  const rootEvent = await page.evaluate(() => ({
    id: document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim(),
    sourceNote: document.querySelector('[data-testid="mc2-event-detail"] .callout-warn strong')?.textContent?.trim() ?? "",
    contentButton: !!document.querySelector('[data-testid="mc2-event-detail"] .callout-warn .btn'),
  }));
  check("目标帖原始记录可读，metadata_only 明确缺正文并给出文件轨迹入口", () => {
    assert.match(rootEvent.id ?? "", /MC2:event:373902/);
    assert.ok(rootEvent.sourceNote.includes("没有提供正文"), rootEvent.sourceNote);
    assert.ok(rootEvent.contentButton);
  });
  await page.keyboard.press("Escape");
  await sleep(300);

  // ---------- 4. 文件轨迹 ----------
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".trace-chain .btn")].find((b) => b.textContent?.includes("查看文件轨迹"));
    btn?.click();
  });
  await page.waitForSelector('[data-testid="mc2-file-detail"] .file-track', { timeout: 20000 });
  await sleep(800);
  const file = await page.evaluate(() => ({
    readers: document.querySelectorAll(".mc2-reader").length,
    status: document.querySelector('[data-testid="mc2-file-detail"] .file-track .tag')?.textContent?.trim(),
    rows: document.querySelectorAll('[data-testid="mc2-file-detail"] .file-events .stream-row').length,
    statusText: document.querySelector('[data-testid="mc2-file-detail"] .file-track .callout')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    facts: document.querySelector('[data-testid="mc2-file-detail"] .file-facts')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    reopen: document.querySelector(".trace-head .btn")?.textContent?.trim() ?? "",
  }));
  check("文件轨迹：状态与事件数一致，正文缺失原因可见", () => {
    assert.equal(file.readers, 1);
    assert.equal(file.status, "仅有元数据");
    assert.ok(file.rows >= 2, `rows ${file.rows}`);
    assert.ok(file.facts.includes("size_hint"), file.facts);
    assert.ok(file.reopen.includes("重新打开"), file.reopen);
  });
  await shot("file-reader-1600-light");

  // 文件轨迹里点事件行 → 同一面板切换到事件
  await page.evaluate(() => document.querySelector('[data-testid="mc2-file-detail"] .file-events .stream-row')?.click());
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
  await sleep(400);
  const readersAfterSwitch = await readerCount();
  check("文件轨迹 → 事件记录在同一阅读面板内切换（不叠第二个面板）", () => {
    assert.equal(readersAfterSwitch, 1);
  });
  await page.keyboard.press("Escape");
  await sleep(300);

  // 候选文件
  await page.evaluate(() => {
    const row = [...document.querySelectorAll(".trace-chain .trace-item")].find((n) => n.textContent?.includes("候选"));
    row?.click();
  });
  await page.waitForSelector('[data-testid="mc2-file-detail"] .callout-warn', { timeout: 20000 });
  await sleep(500);
  const candidate = await page.evaluate(() => ({
    note: document.querySelector('[data-testid="mc2-file-detail"] .callout-warn')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    path: document.querySelector('[data-testid="mc2-file-detail"] .mc2-reader-title strong')?.textContent?.trim() ?? "",
  }));
  check("候选文件打开后先说明“不是传播证据”，路径为候选文件", () => {
    assert.ok(candidate.note.includes("不等于传播证据"), candidate.note);
    assert.ok(candidate.path.includes("SwiftWren_further_instructions"), candidate.path);
  });
  await shot("candidate-file-1600-light");
  await page.keyboard.press("Escape");
  await sleep(300);

  // ---------- 5. 系统背景 → 成员 → 实体事件 ----------
  await page.evaluate(() => {
    document.querySelector('[aria-label="系统背景"]')?.scrollIntoView({ block: "start" });
    const node = [...document.querySelectorAll(".system-node")].find((n) => n.textContent?.includes("Agent 执行者")) ?? document.querySelector(".system-node");
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector(".system-side .trace-item", { timeout: 20000 });
  await sleep(500);
  const system = await page.evaluate(() => ({
    members: document.querySelectorAll(".system-side .trace-item").length,
    memberTitle: document.querySelector(".system-side .trace-item")?.getAttribute("title") ?? "",
    note: [...document.querySelectorAll(".system-side p")].map((n) => n.textContent?.replace(/\s+/g, " ").trim()).join(" | "),
    scale: document.querySelector(".system-map .trace-head .muted")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("系统背景只展开真实成员 ID，注明样本与全量关系", () => {
    assert.ok(system.members >= 1, JSON.stringify(system));
    assert.match(system.memberTitle, /^MC2:agent:/);
    assert.ok(system.scale.includes("聚合成"), system.scale);
    assert.ok(system.note.includes("20"), system.note);
  });
  await shot("system-expanded-1600-light");

  await page.evaluate(() => document.querySelector(".system-side .trace-item")?.click());
  await page.waitForSelector('[data-testid="mc2-entity-detail"] .stream-row', { timeout: 30000 });
  await sleep(800);
  const entity = await page.evaluate(() => ({
    readers: document.querySelectorAll(".mc2-reader").length,
    scope: document.querySelector('[data-testid="mc2-entity-detail"] .mc2-msgs-scope')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    rows: document.querySelectorAll('[data-testid="mc2-entity-detail"] .stream-row').length,
  }));
  check("成员 → 阅读面板显示该实体在“当前筛选 ∩ 参与者”下的事件样本", () => {
    assert.equal(entity.readers, 1);
    assert.ok(entity.scope.includes("当前筛选"), entity.scope);
    assert.ok(entity.rows > 0);
  });
  await shot("entity-reader-1600-light");

  // 焦点已写入 → 实体关系工具可用
  await openTool("实体关系");
  await page.waitForSelector(".graph-node", { timeout: 30000 });
  await sleep(600);
  const graph = await page.evaluate(() => ({
    nodes: document.querySelectorAll(".graph-node").length,
    head: document.querySelector('[aria-label="实体关系"] .graph-head p')?.textContent?.trim() ?? "",
  }));
  check("实体关系以阅读面板/系统背景选中的实体为中心展开", () => {
    assert.ok(graph.nodes > 0, JSON.stringify(graph));
  });
  await shot("graph-1600-light");
  await closeCard("实体关系");

  // ---------- 6. 历史实例 ----------
  await openTool("历史实例");
  await page.waitForSelector('[aria-label="历史实例阶段对齐"] .pattern-table', { timeout: 30000 });
  await sleep(600);
  const patterns = await page.evaluate(() => ({
    columns: document.querySelectorAll(".pattern-table thead th").length,
    rows: document.querySelectorAll(".pattern-table tbody tr").length,
    missing: document.querySelectorAll(".pattern-missing").length,
    present: document.querySelectorAll(".pattern-present").length,
    missingText: document.querySelector(".pattern-missing")?.getAttribute("title") ?? document.querySelector(".pattern-missing")?.textContent ?? "",
    scope: document.querySelector('[aria-label="历史实例阶段对齐"] .trace-head')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    cardNote: document.querySelector('[aria-label="历史实例阶段对齐"] .mc2-card-head p')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("历史实例：3 条链 × 阶段表，missing 显式且不补零", () => {
    assert.equal(patterns.columns, 4);
    assert.ok(patterns.missing >= 2, JSON.stringify(patterns));
    assert.ok(patterns.present > 0);
  });
  check("历史实例固定全量分析，卡片注明不受筛选/时间窗影响", () => {
    assert.ok(patterns.cardNote.includes("固定全量分析"), patterns.cardNote);
    assert.ok(patterns.scope.includes("共") && patterns.scope.includes("条"), patterns.scope);
  });
  await scrollToCard("历史实例阶段对齐");
  await sleep(300);
  await shot("history-1600-light");
  await closeCard("历史实例阶段对齐");

  // ---------- 7. 干预论证（单选） ----------
  await openTool("干预论证");
  await page.waitForSelector('[aria-label="候选干预"] .intervention-view', { timeout: 30000 });
  await sleep(800);
  const intervention = await page.evaluate(() => ({
    coverage: document.querySelector(".intervention-view h3")?.textContent ?? "",
    cut: document.querySelector(".intervention-view .callout-warn strong")?.textContent ?? "",
    sampled: document.querySelectorAll(".intervention-view .intervention-actions button[aria-pressed='true']").length,
    limit: document.querySelector('[aria-label="候选干预"] .callout-warn')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("干预论证：覆盖 3/3，明确拒绝“切断证明”", () => {
    assert.ok(intervention.coverage.includes("3/3"), intervention.coverage);
    assert.ok(intervention.cut.includes("无法"), intervention.cut);
    assert.equal(intervention.sampled, 0);
  });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".intervention-view button")].find((b) => b.textContent?.includes("选为干预位置"));
    btn?.click();
  });
  await sleep(700);
  const selected = await page.evaluate(() => ({
    pressed: [...document.querySelectorAll(".intervention-view button")].filter((b) => b.getAttribute("aria-pressed") === "true").length,
    cancels: [...document.querySelectorAll(".intervention-view button")].filter((b) => b.textContent.includes("取消选择该干预位置")).length,
    position: document.querySelector(".intervention-view .intervention-actions")?.textContent?.includes("单一活动选择") ?? false,
  }));
  check("干预位置最多单选一个，按钮切换为取消该位置", () => {
    assert.equal(selected.pressed, 1, JSON.stringify(selected));
    assert.equal(selected.cancels, 1);
  });
  await scrollToCard("候选干预");
  await sleep(300);
  await shot("intervention-selected-1600-light");
  await closeCard("候选干预");

  // ---------- 8. 转移矩阵 ----------
  await openTool("转移矩阵");
  await page.waitForSelector('[aria-label="转移矩阵"] .transition-table', { timeout: 40000 });
  await sleep(800);
  const matrix = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".transition-cell")].filter((n) => !n.classList.contains("transition-cell-empty"));
    return {
      cells: cells.length,
      types: document.querySelectorAll(".transition-table thead th").length - 1,
      firstTitle: cells[0]?.getAttribute("title") ?? "",
      text: document.querySelector('[aria-label="转移矩阵"]')?.textContent ?? "",
      lowSample: document.querySelectorAll(".transition-cell-low").length,
    };
  });
  check("转移矩阵非空：24 类型、样本对与低样本标记", () => {
    assert.ok(matrix.cells >= 10, JSON.stringify(matrix));
    assert.ok(matrix.types >= 20, `types ${matrix.types}`);
    assert.ok(matrix.firstTitle.includes("对"), matrix.firstTitle);
    assert.ok(matrix.text.includes("不表示因果"), "缺少不表示因果说明");
    assert.ok(!matrix.text.includes("13.78"), "未实现校正前不得展示 13.78 倍");
  });
  await page.evaluate(() => {
    const cell = [...document.querySelectorAll(".transition-cell")].find((n) => !n.classList.contains("transition-cell-empty"));
    cell?.click();
  });
  await page.waitForSelector('[aria-label="转移矩阵"] .transition-evidence', { timeout: 20000 });
  await sleep(700);
  const evidence = await page.evaluate(() => ({
    header: document.querySelector(".transition-evidence .trace-head")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    pairs: document.querySelectorAll(".transition-evidence .transition-pair").length,
    twoSides: (document.querySelector(".transition-pair")?.querySelectorAll(".trace-item").length ?? 0) === 2,
  }));
  const supportN = Number((matrix.firstTitle.match(/(\d+)\s*对/) ?? [])[1] ?? NaN);
  const evidenceN = Number((evidence.header.match(/支持\s*([\d,]+)\s*对/) ?? [])[1]?.replace(/,/g, "") ?? NaN);
  check("格内样本数与证据列表一致，相邻对同时给源与后继事件", () => {
    assert.ok(Number.isFinite(supportN) && supportN === evidenceN, `格 ${supportN} 对，列表 ${evidenceN} 对`);
    assert.ok(evidence.twoSides);
  });
  await page.evaluate(() => document.querySelector(".transition-evidence")?.scrollIntoView({ block: "center" }));
  await sleep(300);
  await shot("transitions-evidence-1600-light");
  await closeCard("转移矩阵");

  // ---------- 9. 时间窗对照与返回 ----------
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll('[aria-label="活动时间分布"] .anchor-chip')].find((c) => c.textContent?.includes("目标帖子"));
    chip?.click();
  });
  await sleep(900);
  await openTool("时间窗对照");
  await page.waitForSelector('[aria-label="时间窗对照"] .compare-row', { timeout: 30000 });
  await sleep(700);
  const compare = await page.evaluate(() => ({
    rows: document.querySelectorAll(".compare-row").length,
    head: document.querySelector(".compare-head")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("时间窗对照入口保留，按当前窗口给出对照行", () => {
    assert.ok(compare.rows >= 2, JSON.stringify(compare));
    assert.ok(compare.head.includes("当前"), compare.head);
  });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[aria-label="对照方式"] .seg-item')].find((b) => b.textContent?.includes("手选历史窗"));
    btn?.click();
  });
  await page.waitForSelector(".compare-manual-field input", { timeout: 15000 });
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll(".compare-manual-field input")];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(inputs[0], "2046-05-17T08:00");
    inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    setter?.call(inputs[1], "2046-05-17T09:00");
    inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".compare-manual-actions .btn")].find((b) => b.textContent?.includes("应用历史窗"));
    btn?.click();
  });
  await sleep(900);
  const manual = await page.evaluate(() => ({
    head: document.querySelector(".compare-head")?.textContent ?? "",
    mode: [...document.querySelectorAll('[aria-label="对照方式"] .seg-item')].find((b) => b.classList.contains("seg-active"))?.textContent?.trim(),
  }));
  check("手选历史窗生效，窗口写回共享状态", () => {
    assert.ok(manual.head.includes("08:00") && manual.head.includes("09:00"), manual.head);
    assert.equal(manual.mode, "手选历史窗");
  });
  await scrollToCard("时间窗对照");
  await sleep(300);
  await shot("compare-manual-1600-light");
  await page.evaluate(() => document.querySelector(".compare-row-button")?.click());
  await page.waitForSelector(".compare-return-banner", { timeout: 15000 });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".compare-return-banner .btn")].find((b) => b.textContent?.includes("返回比较"));
    btn?.click();
  });
  await page.waitForSelector('[aria-label="时间窗对照"] .compare-row-button', { timeout: 20000 });
  await sleep(700);
  const restored = await page.evaluate(() => ({
    head: document.querySelector(".compare-head")?.textContent ?? "",
    mode: [...document.querySelectorAll('[aria-label="对照方式"] .seg-item')].find((b) => b.classList.contains("seg-active"))?.textContent?.trim(),
  }));
  check("下钻后“返回比较”恢复手选历史窗与对照方式", () => {
    assert.ok(restored.head.includes("08:00"), restored.head);
    assert.equal(restored.mode, "手选历史窗");
  });
  await scrollToCard("时间窗对照");
  await sleep(300);
  await shot("compare-return-1600-light");
  await closeCard("时间窗对照");

  // ---------- 10. 筛选与显隐 ----------
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll(".mc2-toggle")].find((b) => b.textContent?.trim() === "筛选");
    toggle?.click();
  });
  await sleep(600);
  const filterPanel = await page.evaluate(() => ({
    chips: document.querySelectorAll(".mc2-chip").length,
    note: [...document.querySelectorAll(".mc2-filter-group p")].map((n) => n.textContent).join(" "),
    window: document.querySelector(".mc2-filters .mono")?.textContent ?? "",
  }));
  check("筛选面板列出统一时间窗、类别/类型与适用范围说明", () => {
    assert.ok(filterPanel.chips >= 32, `chips ${filterPanel.chips}`);
    assert.ok(filterPanel.note.includes("系统背景"), filterPanel.note);
    assert.ok(filterPanel.window.includes("2046"), filterPanel.window);
  });
  await shot("filters-1600-light");
  // 关闭筛选，避免影响后续截图
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll(".mc2-toggle")].find((b) => b.textContent?.trim() === "筛选");
    toggle?.click();
  });
  await sleep(500);

  // 图表显隐
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll(".mc2-toggle")].find((b) => b.textContent?.trim() === "活动分布");
    toggle?.click();
  });
  await sleep(400);
  const hidden = await page.evaluate(() => ({
    chart: !!document.querySelector('[aria-label="活动时间分布"]'),
    pressed: [...document.querySelectorAll(".mc2-toggle")].find((b) => b.textContent?.trim() === "活动分布")?.getAttribute("aria-pressed"),
  }));
  check("图表显隐可关掉活动分布并保留来源链", () => {
    assert.equal(hidden.chart, false);
    assert.equal(hidden.pressed, "false");
  });
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll(".mc2-toggle")].find((b) => b.textContent?.trim() === "活动分布");
    toggle?.click();
  });
  await sleep(500);

  // ---------- 11. 键盘 ----------
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll(".mc2-toggle")].find((b) => b.textContent?.trim() === "活动分布");
    toggle?.focus();
  });
  const pressedBefore = await page.evaluate(() => document.activeElement?.getAttribute("aria-pressed"));
  await page.keyboard.press("Enter");
  await sleep(400);
  const pressedAfter = await page.evaluate(() => [...document.querySelectorAll(".mc2-toggle")].find((b) => b.textContent?.trim() === "活动分布")?.getAttribute("aria-pressed"));
  check("显隐按钮可键盘操作（Enter 改变 aria-pressed）", () => {
    assert.ok(pressedBefore !== null);
    assert.notEqual(pressedAfter, pressedBefore);
  });
  if (pressedAfter !== pressedBefore) {
    await page.keyboard.press("Enter");
    await sleep(300);
  }

  // ---------- 12. 快照（带根与当前文件） ----------
  const snapshotClaim = `F2 快照检查 ${Date.now()}`;
  let caseId = null;
  let baseSnapshot = null;
  try {
    // 先选一条真实事件（阅读面板 → 证据侧栏默认“消息”页）
    await openTool("事件查询");
    await page.waitForSelector('[aria-label="事件查询"] .stream-row', { timeout: 30000 });
    await page.evaluate(() => document.querySelector('[aria-label="事件查询"] .stream-row')?.click());
    await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
    await ensureEvidence();
    // 默认“消息”页，先把当前事件加入证据篮（空篮不能保存案例）
    await page.waitForSelector(".basket-add .btn", { timeout: 20000 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".basket-add .btn")].find((b) => b.textContent?.includes("支持"));
      btn?.click();
    });
    await sleep(400);
    await clickText(".tabs .tab", "证据篮");
    await page.waitForSelector('.basket input[placeholder="案例标题"]', { timeout: 15000 });
    await page.type('.basket input[placeholder="案例标题"]', snapshotClaim);
    const waiting = page.waitForResponse((r) => r.url().endsWith("/api/cases") && r.request().method() === "POST");
    await clickText(".basket .btn", "保存当前案例");
    const response = await waiting;
    const item = await response.json();
    assert.equal(response.status(), 201, JSON.stringify(item));
    caseId = item.case_id;
    created.push(caseId);
    const snapshot = item.snapshot;
    baseSnapshot = snapshot;
    check("保存调查写入真实链根/当前文件与统一时间窗，不产生第二份筛选", () => {
      assert.match(snapshot.trace_object.rootEventId ?? "", /^MC2:event:/);
      assert.match(snapshot.trace_object.fileId ?? "", /SwiftWren/);
      assert.equal(snapshot.dataset_id, "MC2");
      assert.ok(!("playing" in snapshot.replay));
    });
    await shot("snapshot-save-1600-light");
  } catch (err) {
    check("快照保存（MC2 链根/文件）", () => { throw err; });
  }

  // ---------- 12.5 独立复核回归：R1–R6 / K1–K2 ----------
  const closeDrawer = async () => {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".drawer-head .btn")].find((b) => b.textContent?.trim() === "关闭");
      btn?.click();
    });
    await sleep(400);
  };
  const drawerBasket = async () => {
    if (!(await page.$(".drawer"))) await clickText(".topbar-docks button", "证据");
    await clickText(".tabs .tab", "证据篮");
    await page.waitForSelector(".basket");
  };
  const saveFromBasket = async (title) => {
    await drawerBasket();
    if (await page.$(".basket > .callout .mono")) await clickText(".basket .btn", "取消关联");
    await page.waitForSelector('.basket input[placeholder="案例标题"]');
    await page.type('.basket input[placeholder="案例标题"]', title);
    const waiting = page.waitForResponse((r) => r.url().endsWith("/api/cases") && r.request().method() === "POST");
    await clickText(".basket .btn", "保存当前案例");
    const res = await waiting;
    const item = await res.json();
    assert.equal(res.status(), 201, JSON.stringify(item).slice(0, 300));
    created.push(item.case_id);
    return item;
  };
  const restoreCase = async (id) => {
    await drawerBasket();
    await page.waitForFunction(
      (caseId) => [...document.querySelectorAll(".saved-investigations .drawer-actions")].some((n) => n.querySelector("a")?.href.includes(caseId)),
      {},
      id,
    );
    await page.evaluate(
      (caseId) => [...document.querySelectorAll(".saved-investigations .drawer-actions")].find((n) => n.querySelector("a")?.href.includes(caseId))?.querySelector("button")?.click(),
      id,
    );
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((n) => n.textContent?.includes("已恢复调查")));
    await sleep(1000);
  };
  const postCase = async (snapshot, title) => {
    const res = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_id: "MC2", title, snapshot }),
    });
    const item = await res.json();
    assert.equal(res.status, 201, JSON.stringify(item).slice(0, 300));
    created.push(item.case_id);
    return item;
  };
  const reloadMc2 = async () => {
    await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
    await page.waitForSelector(".trace-lanes", { timeout: 30000 });
    await sleep(900);
  };
  const readerBox = () =>
    page.evaluate(() => {
      const node = document.querySelector(".mc2-reader");
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const close = [...node.querySelectorAll(".btn")].find((b) => b.textContent?.trim() === "关闭");
      const closeRect = close?.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        vh: window.innerHeight,
        closeVisible: !!closeRect && closeRect.top >= 0 && closeRect.bottom <= window.innerHeight + 1,
      };
    });
  const openQueryAtBottom = async () => {
    await closeDrawer();
    // 工具菜单是开关：已经打开时再点会关闭，先看是否已在页面
    if (!(await page.$('[aria-label="事件查询"]'))) await openTool("事件查询");
    await page.waitForSelector('[aria-label="事件查询"] .stream-row', { timeout: 30000 });
    await page.evaluate(() => document.querySelector('[aria-label="事件查询"]')?.scrollIntoView({ block: "end" }));
    await sleep(400);
  };
  const missingFileId = "MC2:file_path:missing-independent-review.txt";
  const missingRequests = [];
  page.on("request", (r) => {
    if (r.url().includes("missing-independent-review")) missingRequests.push(r.url());
  });
  const http404 = [];
  page.on("response", (r) => {
    if (r.status() === 404) http404.push(r.url());
  });

  // R1：从页面底部打开对象，阅读面板必须实际可见
  await openQueryAtBottom();
  await page.evaluate(() => document.querySelector('[aria-label="事件查询"] .stream-row')?.click());
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
  await sleep(500);
  const pinned1600 = await readerBox();
  check("R1 1600 从底部事件查询打开后，阅读面板标题与关闭在视口内", () => {
    assert.ok(pinned1600, "没有打开阅读面板");
    assert.ok(pinned1600.top >= 0 && pinned1600.top < pinned1600.vh, JSON.stringify(pinned1600));
    assert.ok(pinned1600.closeVisible, JSON.stringify(pinned1600));
  });
  await shot("reader-pinned-1600-light");

  await page.setViewport({ width: 1366, height: 768 });
  await reloadMc2();
  await openQueryAtBottom();
  await page.evaluate(() => document.querySelector('[aria-label="事件查询"] .stream-row')?.click());
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
  await sleep(500);
  const pinned1366 = await readerBox();
  check("R1 1366 底部打开后阅读面板仍在视口内", () => {
    assert.ok(pinned1366, "没有打开阅读面板");
    assert.ok(pinned1366.top >= 0 && pinned1366.top < pinned1366.vh, JSON.stringify(pinned1366));
  });
  await shot("reader-pinned-1366-light");

  // R2：历史阶段与转移证据打开的必须是同一条事件
  await page.setViewport({ width: 1600, height: 1000 });
  await reloadMc2();
  await page.evaluate(() => document.querySelector(".mc2-root-event")?.click());
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
  const rootReaderId = await page.evaluate(
    () => document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim() ?? "",
  );
  await openTool("历史实例");
  await page.waitForSelector(".pattern-event", { timeout: 30000 });
  await sleep(500);
  const stageLabel = await page.evaluate(() => document.querySelector(".pattern-event")?.textContent?.trim() ?? "");
  await page.evaluate(() => document.querySelector(".pattern-event")?.click());
  await page.waitForFunction(
    (digits) => document.querySelector('[data-testid="mc2-event-detail"] .mc2-reader-title strong')?.textContent?.includes(digits),
    {},
    stageLabel.replace("#", ""),
  );
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono', { timeout: 20000 });
  await sleep(400);
  const historyReader = await page.evaluate(() => ({
    id: document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim() ?? "",
    top: Math.round(document.querySelector(".mc2-reader")?.getBoundingClientRect().top ?? -999),
  }));
  check("R2 历史阶段点击后阅读面板切换到该事件且可见", () => {
    assert.notEqual(historyReader.id, rootReaderId);
    assert.ok(historyReader.id.endsWith(stageLabel.replace("#", "")), JSON.stringify({ historyReader, stageLabel }));
    assert.ok(historyReader.top >= 0);
  });
  await shot("history-reader-fixed-1600-light");

  await openTool("转移矩阵");
  await page.waitForSelector(".transition-cell", { timeout: 30000 });
  await sleep(700);
  await page.evaluate(() => {
    const cell = [...document.querySelectorAll(".transition-cell")].find((c) => !c.classList.contains("transition-cell-empty"));
    cell?.click();
  });
  await page.waitForSelector(".transition-evidence .trace-item", { timeout: 20000 });
  await sleep(400);
  const evidenceTime = await page.evaluate(
    () => document.querySelector(".transition-evidence .trace-item .mono")?.textContent?.trim() ?? "",
  );
  await page.evaluate(() => document.querySelector(".transition-evidence .trace-item")?.click());
  await page.waitForFunction(
    (time) => document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta')?.textContent?.includes(time),
    {},
    evidenceTime,
  );
  const matrixReader = await page.evaluate(() => ({
    id: document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim() ?? "",
    meta: document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("R2 转移证据点击后阅读面板显示该源事件正文", () => {
    assert.notEqual(matrixReader.id, historyReader.id);
    assert.ok(matrixReader.meta.includes(evidenceTime), JSON.stringify({ matrixReader, evidenceTime }));
  });
  await shot("matrix-reader-fixed-1600-light");

  // R3：缺失文件恢复不请求、不留旧面板，重存仍保留原引用
  assert.ok(baseSnapshot, "缺少可用的基础快照");
  const missingSnap = {
    ...baseSnapshot,
    selection: { kind: "file", id: missingFileId },
    trace_object: { ...baseSnapshot.trace_object, fileId: missingFileId },
  };
  const missingCase = await postCase(missingSnap, `F2 缺失文件 ${Date.now()}`);
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
  await sleep(600);
  await restoreCase(missingCase.case_id);
  await closeDrawer();
  await sleep(800);
  const missingState = await page.evaluate(() => ({
    notice: document.querySelector(".canvas-area > .callout")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    fileReader: !!document.querySelector('[data-testid="mc2-file-detail"]'),
    root: document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "",
  }));
  check("R3 缺失文件恢复只保留通知，不打开阅读面板也不请求对象", () => {
    assert.ok(missingState.notice.includes("缺失引用"), JSON.stringify(missingState));
    assert.equal(missingState.fileReader, false);
    assert.equal(missingRequests.length, 0, JSON.stringify(missingRequests));
  });
  const resaved = await saveFromBasket(`F2 缺失重存 ${Date.now()}`);
  check("R3 缺失引用重存后仍保留原 selection 与当前文件", () => {
    assert.equal(resaved.snapshot.selection.kind, "file");
    assert.equal(resaved.snapshot.selection.id, missingFileId);
    assert.equal(resaved.snapshot.trace_object.fileId, missingFileId);
  });
  await closeDrawer();
  await page.evaluate(() => document.querySelector(".canvas-area")?.scrollTo(0, 0));
  await shot("missing-file-restore-1600-light");

  // 只有一个缺失文件 + 有效事件选择：应打开事件，不请求缺失文件
  const eventOnlySnap = {
    ...baseSnapshot,
    selection: { kind: "event", id: baseSnapshot.trace_object.rootEventId, timeUs: baseSnapshot.selection?.timeUs ?? null },
    trace_object: { ...baseSnapshot.trace_object, fileId: missingFileId },
  };
  const eventOnlyCase = await postCase(eventOnlySnap, `F2 缺失文件+有效事件 ${Date.now()}`);
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
  await sleep(600);
  await restoreCase(eventOnlyCase.case_id);
  await closeDrawer();
  await sleep(600);
  const eventOnlyState = await page.evaluate(() => ({
    eventReader: document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim() ?? "",
    fileReader: !!document.querySelector('[data-testid="mc2-file-detail"]'),
  }));
  check("R3 事件有效、文件缺失时打开事件且不请求缺失文件", () => {
    assert.equal(eventOnlyState.eventReader, baseSnapshot.trace_object.rootEventId);
    assert.equal(eventOnlyState.fileReader, false);
    assert.equal(missingRequests.length, 0, JSON.stringify(missingRequests));
  });

  // R4：候选文件保存/恢复后仍标明候选与传播局限；记录文件不误标
  await reloadMc2();
  const candidateClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".trace-chain .trace-item")].find((b) => b.textContent?.includes("候选"));
    btn?.click();
    return !!btn;
  });
  assert.ok(candidateClicked, "找不到候选文件行");
  await page.waitForSelector('[data-testid="mc2-file-detail"]', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="mc2-file-kind"]')?.textContent?.includes("候选"));
  const candidateBefore = await page.evaluate(() => ({
    kind: document.querySelector('[data-testid="mc2-file-kind"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    file: document.querySelector('[data-testid="mc2-file-detail"] .mc2-reader-title strong')?.textContent ?? "",
  }));
  const candidateCase = await saveFromBasket(`F2 候选恢复 ${Date.now()}`);
  check("R4 候选文件保存写入原 fileId", () => {
    assert.match(candidateCase.snapshot.trace_object.fileId ?? "", /SwiftWren_further_instructions/);
  });
  await closeDrawer();
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
  await sleep(600);
  await restoreCase(candidateCase.case_id);
  await closeDrawer();
  await page.waitForSelector('[data-testid="mc2-file-detail"]', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="mc2-file-kind"]')?.textContent?.includes("候选"));
  const candidateAfter = await page.evaluate(() => ({
    kind: document.querySelector('[data-testid="mc2-file-kind"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    meta: document.querySelector('[data-testid="mc2-file-detail"] .mc2-reader-title + p')?.textContent?.replace(/\s+/g, " ").trim()
      ?? document.querySelector('[data-testid="mc2-file-detail"] .mc2-detail-head p')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("R4 候选文件恢复后仍标明候选与“不等于传播证据”", () => {
    assert.ok(candidateAfter.kind.includes("候选"), JSON.stringify(candidateAfter));
    assert.ok(candidateAfter.kind.includes("传播"), JSON.stringify(candidateAfter));
    assert.ok(candidateAfter.meta.includes("候选"), JSON.stringify(candidateAfter));
  });
  await shot("candidate-restored-1600-light");

  // R4 边界：换根后旧文件不在新根结果里，身份必须退回“关系待核实”，不能沿用旧候选
  const switched = await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".trace-roots .seg-item")].find((b) => b.textContent?.includes("MellowOtter"));
    chip?.click();
    return { found: !!chip };
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="mc2-file-kind"]')?.textContent?.includes("待核实"), { timeout: 20000 });
  await sleep(600);
  const afterSwitch = await page.evaluate(() => ({
    root: document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "",
    file: document.querySelector('[data-testid="mc2-file-detail"] .mc2-reader-title strong')?.textContent ?? "",
    kind: document.querySelector('[data-testid="mc2-file-kind"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("R4 换根后旧文件不在新链结果里，身份退回“关系待核实”", () => {
    assert.ok(switched.found, "找不到 MellowOtter 链根");
    assert.notEqual(afterSwitch.root, baseSnapshot.trace_object.rootEventId, JSON.stringify(afterSwitch));
    assert.ok(afterSwitch.file.includes("SwiftWren_further"), JSON.stringify(afterSwitch));
    assert.ok(afterSwitch.kind.includes("待核实"), JSON.stringify(afterSwitch));
    assert.ok(!afterSwitch.kind.includes("仅因文件名前缀"), JSON.stringify(afterSwitch));
  });
  await shot("file-kind-after-root-switch-1600-light");

  // 记录文件（内容可用性按钮）不应被标成候选
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".trace-chain .btn")].find((b) => b.textContent?.includes("查看文件轨迹"));
    btn?.click();
  });
  await page.waitForSelector('[data-testid="mc2-file-detail"]', { timeout: 20000 });
  await sleep(700);
  const recorded = await page.evaluate(() => ({
    kind: !!document.querySelector('[data-testid="mc2-file-kind"]'),
    meta: document.querySelector('[data-testid="mc2-file-detail"] .mc2-detail-head p')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("R4 已记录的内容文件不误标候选", () => {
    assert.equal(recorded.kind, false, JSON.stringify(recorded));
    assert.ok(recorded.meta.includes("记录"), JSON.stringify(recorded));
  });

  // R5：恢复无根快照保持空；之后切换数据集回到 MC2 重新初始化默认链根
  const noRootSnap = {
    ...baseSnapshot,
    task: "overview",
    mode: "time",
    task_modes: { ...baseSnapshot.task_modes, overview: "time" },
    selection: null,
    trace_object: { ...baseSnapshot.trace_object, rootEventId: null, fileId: null },
  };
  const noRootCase = await postCase(noRootSnap, `F2 无根快照 ${Date.now()}`);
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
  await sleep(600);
  await restoreCase(noRootCase.case_id);
  await closeDrawer();
  await sleep(800);
  const noRoot = await page.evaluate(() => ({
    root: document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "",
    hint: document.querySelector(".trace-roots .muted")?.textContent?.trim() ?? "",
    lanes: !!document.querySelector(".trace-lanes"),
  }));
  check("R5 恢复无根快照不擅自补默认链根", () => {
    assert.equal(noRoot.root, "");
    assert.ok(noRoot.hint.includes("尚未选择链根"), JSON.stringify(noRoot));
  });
  await shot("no-root-restored-1600-light");
  await page.select(".dataset-field select", "MC1");
  await page.waitForSelector(".mc1-page", { timeout: 30000 });
  await page.select(".dataset-field select", "MC2");
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
  await page.waitForSelector(".trace-lanes", { timeout: 30000 });
  await sleep(900);
  const reinit = await page.evaluate(() => ({
    root: document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "",
    lanes: !!document.querySelector(".trace-lanes"),
  }));
  check("R5 恢复过案例后切换数据集，回 MC2 仍重新初始化默认链根", () => {
    assert.match(reinit.root, /^MC2:event:/, JSON.stringify(reinit));
    assert.ok(reinit.lanes, JSON.stringify(reinit));
  });

  // R6：隐藏来源链后，恢复来源调查与“定位目标帖”都能重新展开
  // 先用一次刷新挂载证据篮（案例由接口创建，列表在抽屉挂载时读取），再隐藏来源链恢复
  const rootCase = await postCase(
    {
      ...baseSnapshot,
      task: "trace",
      mode: "source",
      task_modes: { ...baseSnapshot.task_modes, trace: "source" },
      selection: { kind: "event", id: baseSnapshot.trace_object.rootEventId, timeUs: baseSnapshot.selection?.timeUs ?? null },
    },
    `F2 隐藏后恢复来源 ${Date.now()}`,
  );
  await reloadMc2();
  await drawerBasket();
  await closeDrawer();
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll(".mc2-toggle")].find((n) => n.textContent?.trim() === "来源链");
    toggle?.click();
  });
  await sleep(400);
  const chainHidden = await page.evaluate(() => !document.querySelector('[data-testid="mc2-trace-card"]'));
  check("R6 显隐按钮可隐藏来源链", () => assert.equal(chainHidden, true));
  await restoreCase(rootCase.case_id);
  await closeDrawer();
  await sleep(900);
  const restoredChain = await page.evaluate(() => ({
    card: !!document.querySelector('[data-testid="mc2-trace-card"]'),
    root: document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "",
  }));
  check("R6 隐藏后恢复来源调查会重新展开并对准原链根", () => {
    assert.equal(restoredChain.card, true);
    assert.equal(restoredChain.root, baseSnapshot.trace_object.rootEventId);
  });
  await shot("hidden-chain-restored-1600-light");
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll(".mc2-toggle")].find((n) => n.textContent?.trim() === "来源链");
    toggle?.click();
  });
  await sleep(300);
  await page.evaluate(() => document.querySelector('[data-testid="mc2-target-post"]')?.click());
  await sleep(900);
  const relocated = await page.evaluate(() => ({
    card: !!document.querySelector('[data-testid="mc2-trace-card"]'),
    root: document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "",
    visible: (() => {
      const node = document.querySelector('[data-testid="mc2-trace-card"]');
      const rect = node?.getBoundingClientRect();
      return !!rect && rect.top < window.innerHeight && rect.bottom > 0;
    })(),
  }));
  check("R6 来源链隐藏时“定位目标帖”能重新展开并滚动到它", () => {
    assert.equal(relocated.card, true);
    assert.match(relocated.root, /^MC2:event:/);
    assert.equal(relocated.visible, true);
  });

  // K1：SVG 触发与“文件行→事件”切换后的关闭回焦
  await reloadMc2();
  await page.evaluate(() => {
    // 来源图里文件与事件都可点；这里要的是事件节点（文件节点打开的是文件轨迹）
    const g = [...document.querySelectorAll(".mc2-svg-hit")].find((n) => n.getAttribute("aria-label")?.includes("查看事件"));
    if (g instanceof SVGElement) g.focus();
    g?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
  await page.evaluate(() => {
    const close = [...document.querySelectorAll('[data-testid="mc2-event-detail"] .btn')].find((b) => b.textContent?.trim() === "关闭");
    close?.click();
  });
  await sleep(500);
  const svgFocus = await page.evaluate(() => ({
    inSvg: !!document.activeElement?.closest("svg"),
    tag: document.activeElement?.tagName ?? "",
  }));
  check("K1 从来源图打开事件后关闭，焦点回到 SVG 触发点", () => {
    assert.equal(svgFocus.inSvg, true, JSON.stringify(svgFocus));
  });

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".trace-chain .btn")].find((b) => b.textContent?.includes("查看文件轨迹"));
    btn?.click();
  });
  await page.waitForSelector(".file-track-row", { timeout: 20000 });
  await sleep(600);
  await page.evaluate(() => document.querySelector(".file-track-row .stream-row")?.click());
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
  await page.keyboard.press("Escape");
  await sleep(500);
  const fileFocus = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? "",
    connected: !!document.activeElement?.isConnected,
    body: document.activeElement === document.body,
  }));
  check("K1 文件行切到事件后关闭，焦点落在仍可见的控件而不是 BODY", () => {
    assert.equal(fileFocus.body, false, JSON.stringify(fileFocus));
    assert.equal(fileFocus.connected, true, JSON.stringify(fileFocus));
  });

  // K2：文件行的“设为链根”按钮真正换根
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".trace-chain .btn")].find((b) => b.textContent?.includes("查看文件轨迹"));
    btn?.click();
  });
  await page.waitForSelector(".file-track-root", { timeout: 20000 });
  await sleep(600);
  const rootBefore = await page.evaluate(() => document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "");
  await page.evaluate(() => document.querySelector(".file-track-root")?.click());
  await page.waitForFunction((previous) => document.querySelector(".mc2-root-event")?.textContent?.trim() !== previous, {}, rootBefore);
  await sleep(800);
  const rootAfter = await page.evaluate(() => ({
    root: document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "",
    lanes: !!document.querySelector(".trace-lanes"),
  }));
  check("K2 文件行“设为链根”按钮换根并重绘来源链", () => {
    assert.match(rootAfter.root, /^MC2:event:/);
    assert.notEqual(rootAfter.root, rootBefore);
    assert.ok(rootAfter.lanes);
  });
  await shot("file-root-button-1600-light");

  // ---------- 13. 响应式与主题 ----------
  const scrollTop = () =>
    page.evaluate(() => {
      document.querySelector(".canvas-area")?.scrollTo(0, 0);
    });
  // 重新加载，让响应式证据回到默认窗口/默认链根，而不是保留前面的对照下钻状态；
  // 证据侧栏的布局偏好会记住上次打开，需在重载后再收起
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".trace-lanes", { timeout: 30000 });
  await sleep(1200);
  await closeDrawer();
  await page.setViewport({ width: 1366, height: 768 });
  await sleep(700);
  await scrollTop();
  await sleep(300);
  await shot("default-1366-light");
  const at1366 = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    viewport: window.innerWidth,
    canvas: Math.round(document.querySelector(".chart-wrap canvas")?.getBoundingClientRect().width ?? 0),
  }));
  check("1366×768 无横向溢出，活动图仍有可用宽度", () => {
    assert.ok(at1366.body <= at1366.viewport + 1, JSON.stringify(at1366));
    assert.ok(at1366.canvas > 700, JSON.stringify(at1366));
  });

  await page.setViewport({ width: 1024, height: 768 });
  await sleep(700);
  await scrollTop();
  await sleep(300);
  await shot("default-1024-light");
  const at1024 = await page.evaluate(() => {
    const layout = getComputedStyle(document.querySelector(".mc2-layout"));
    return {
      body: document.body.scrollWidth,
      viewport: window.innerWidth,
      column: layout.flexDirection,
      cards: document.querySelectorAll(".mc2-card").length,
    };
  });
  check("1024 上下重排为单列且不横向溢出", () => {
    assert.ok(at1024.body <= at1024.viewport + 1, JSON.stringify(at1024));
    assert.equal(at1024.column, "column");
  });

  await page.setViewport({ width: 390, height: 844 });
  await sleep(700);
  await scrollTop();
  await sleep(300);
  await shot("default-390-light");
  const at390 = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    viewport: window.innerWidth,
    page: Math.round(document.querySelector(".mc2-page")?.getBoundingClientRect().width ?? 0),
  }));
  check("390 无页面横向溢出", () => {
    assert.ok(at390.body <= at390.viewport + 1, JSON.stringify(at390));
  });
  // 窄屏点目标帖链根（窗口/回放游标可能已把文件操作遮蔽，链根一定可读）
  const narrowClick = await page.evaluate(() => {
    const row = document.querySelector(".mc2-root-event");
    row?.click();
    return { found: !!row, text: row?.textContent?.trim() ?? null };
  });
  console.log("  390 click", JSON.stringify(narrowClick));
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
  await sleep(500);
  const narrowReader = await page.evaluate(() => {
    const rect = document.querySelector(".mc2-reader")?.getBoundingClientRect();
    const close = [...document.querySelectorAll(".mc2-reader .btn")].find((b) => b.textContent?.trim() === "关闭");
    const closeRect = close?.getBoundingClientRect();
    return {
      width: Math.round(rect?.width ?? 0),
      closeVisible: closeRect ? closeRect.right <= window.innerWidth + 1 && closeRect.bottom <= window.innerHeight + 1 : false,
      body: document.body.scrollWidth,
    };
  });
  check("390 详情为可关闭浮层，不挤出横向滚动", () => {
    assert.ok(narrowReader.width <= 390, JSON.stringify(narrowReader));
    assert.ok(narrowReader.closeVisible, JSON.stringify(narrowReader));
    assert.ok(narrowReader.body <= 391, JSON.stringify(narrowReader));
  });
  await shot("event-reader-390-light");
  await page.keyboard.press("Escape");
  await sleep(300);

  // R1 窄屏：同样从底部事件查询打开，浮层必须可见并可关闭
  await openQueryAtBottom();
  await page.evaluate(() => document.querySelector('[aria-label="事件查询"] .stream-row')?.click());
  await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 20000 });
  await sleep(500);
  const pinned390 = await readerBox();
  check("R1 390 从底部打开对象后浮层仍在视口内且可关闭", () => {
    assert.ok(pinned390, "没有打开阅读面板");
    assert.ok(pinned390.top >= 0 && pinned390.top < pinned390.vh, JSON.stringify(pinned390));
    assert.ok(pinned390.closeVisible, JSON.stringify(pinned390));
  });
  await shot("reader-pinned-390-light");

  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto(`${base}/?theme=dark`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
  await sleep(1200);
  // 布局偏好会记住上次打开的侧栏；深色默认首屏先收起，避免遮住页面
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".drawer-head .btn")].find((b) => b.textContent?.trim() === "关闭");
    btn?.click();
  });
  await sleep(500);
  await scrollTop();
  await sleep(300);
  await shot("default-1600-dark");

  // ---------- 14. 数据集隔离 ----------
  await page.select(".dataset-field select", "MC1");
  await page.waitForSelector(".mc1-page", { timeout: 30000 });
  const mc1 = await page.evaluate(() => ({
    mc2: !!document.querySelector('[data-testid="mc2-page"]'),
    chain: !!(document.querySelector('[data-testid="mc2-trace-card"]')),
    viewTabs: document.querySelectorAll(".view-tab").length,
  }));
  await page.select(".dataset-field select", "MC2");
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
  await sleep(1200);
  const back = await page.evaluate(() => ({
    root: document.querySelector(".mc2-root-event")?.textContent?.trim() ?? "",
    file: !!document.querySelector('[data-testid="mc2-file-detail"]'),
  }));
  check("换到 MC1 后 MC2 卡片/链根不残留；回到 MC2 重新落到目标根", () => {
    assert.equal(mc1.mc2, false);
    assert.equal(mc1.chain, false);
    assert.match(back.root, /^MC2:event:/);
  });

  // ---------- 15. 失败态不崩溃 ----------
  await page.setRequestInterception(true);
  const blocker = (request) => {
    if (request.url().includes("/api/traces?") || request.url().includes("/api/system-overview")) {
      request.abort();
    } else {
      request.continue();
    }
  };
  page.on("request", blocker);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
  await sleep(1500);
  const degraded = await page.evaluate(() => ({
    page: !!document.querySelector('[data-testid="mc2-page"]'),
    error: document.querySelector('[data-testid="mc2-trace-card"] .callout-warn strong')?.textContent?.trim() ?? "",
    retry: !!document.querySelector('[data-testid="mc2-trace-card"] .callout-warn .btn'),
    chart: !!document.querySelector('[aria-label="活动时间分布"]'),
  }));
  check("来源链请求失败时卡片给出错误说明与重试，页面其余区域仍可用", () => {
    assert.ok(degraded.page);
    assert.ok(degraded.error.length > 0, JSON.stringify(degraded));
    assert.ok(degraded.retry);
    assert.ok(degraded.chart);
  });
  await shot("error-state-1600-light");
  page.off("request", blocker);
  await page.setRequestInterception(false);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".trace-lanes", { timeout: 30000 });
  await sleep(800);
  const recovered = await page.evaluate(() => ({
    error: !!document.querySelector('[data-testid="mc2-trace-card"] .callout-warn strong'),
    lanes: !!document.querySelector(".trace-lanes"),
  }));
  check("恢复网络后来源链可重新加载", () => {
    assert.equal(recovered.error, false);
    assert.ok(recovered.lanes);
  });

  check("已知缺失引用不产生 404 请求", () => {
    assert.deepEqual(http404, [], JSON.stringify(http404));
  });

  const uniqueErrors = [...new Set(errors)];
  check("除注入的失败请求外，无控制台/网络错误", () => {
    const unexpected = uniqueErrors.filter((line) => !line.includes("net::ERR_FAILED") && !line.includes("Failed to load resource"));
    assert.deepEqual(unexpected, []);
  });

  fs.writeFileSync(
    path.join(out, "f2-mc2-result.json"),
    JSON.stringify({ base, at: new Date().toISOString(), results, errors: uniqueErrors, created }, null, 2),
  );
  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}${failed.length ? `，失败 ${failed.length}` : ""}`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  for (const id of created) {
    const r = await fetch(`${base}/api/cases/${id}`, { method: "DELETE" });
    console.log(`cleanup ${id}: ${r.status}`);
  }
  await browser.close();
}
