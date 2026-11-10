/**
 * F3 · CUSTOM 参考风格单页验收（浏览器）。
 *
 * 依赖真实后端与主库（默认 http://127.0.0.1:8040），不做 mock、不准备 --fresh 数据。
 * 覆盖：运行×阶段概览与批量摘要（无 N+1）、集合条件与范围、单运行与审计、
 * 正常配对两侧同尺度、五条冻结案例、唯一阅读区与几何、快照恢复、焦点与异步、
 * 草稿与导出、跨集回归。
 *
 * 输出：UI_CHECK_OUT 或 build/reference-ui/F3/custom；
 * 清理：仅删除本轮创建的案例，保留用户已有内容。
 */
import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:8040";
const out = process.env.UI_CHECK_OUT
  ? path.resolve(process.env.UI_CHECK_OUT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../build/reference-ui/F3/custom");
fs.mkdirSync(out, { recursive: true });

const EV = {
  bypassResult: "8a655819-3b06-4146-9cc3-d5bca0095e4d",
  bypassAttempt: "08148a87-df33-4706-8b2a-a4e3b0aedaa3",
  deniedResult: "817383af-5269-4d52-82c0-597be442afc5",
  stalePublishedResult: "d6bc3fdb-9d6c-4875-8a5e-24c0b8900235",
};

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
const requests = [];
/** 本轮有意注入的失败（notes 500），不计入“意外 HTTP/控制台错误”。 */
const intentional = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
page.on("response", (r) => {
  if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  requests.push({ url: r.url(), status: r.status(), at: Date.now() });
});

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
const apiGet = async (p) => (await fetch(`${base}${p}`)).json();
const apiPost = async (p, body) => {
  const res = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  assert.ok(res.status < 300, `POST ${p} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const clickText = async (selector, text) => {
  const found = await page.evaluate((sel, label) => {
    const node = [...document.querySelectorAll(sel)].find((n) => n.textContent?.trim().includes(label));
    node?.click();
    return !!node;
  }, selector, text);
  assert.ok(found, `找不到 ${selector} 中的「${text}」`);
  await sleep(250);
};
const openTools = () =>
  page.evaluate(() => {
    const tools = document.querySelector(".custom-tools");
    if (tools instanceof HTMLDetailsElement) tools.open = true;
  });
const openTool = async (label) => {
  await openTools();
  await clickText(".custom-tools-menu button", label);
  await sleep(600);
};
const overview = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll(".custom-overview-body")];
    return {
      count: rows.length,
      cells: rows.map((row) => row.querySelectorAll(".custom-stage-cell").length),
      states: [...document.querySelectorAll(".custom-stage-cell")].map((cell) => cell.dataset.stageState),
      countText: document.querySelector('[data-testid="custom-overview-count"]')?.textContent?.trim() ?? "",
      dictionary: [...document.querySelectorAll(".custom-overview-head span")].map((n) => n.textContent?.trim()),
    };
  });
const readerInfo = () =>
  page.evaluate(() => {
    const reader = document.querySelector('[data-testid="custom-reader"]');
    return {
      count: document.querySelectorAll('[data-testid="custom-reader"]').length,
      id: reader?.querySelector(".custom-msg-meta .mono")?.textContent?.trim() ?? "",
      owner: reader?.querySelector('[data-testid="custom-event-owner"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      title: reader?.querySelector(".custom-reader-title strong")?.textContent?.trim() ?? "",
      meta: reader?.querySelector(".custom-msg-meta")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    };
  });
const objectChip = () => page.$eval('[data-testid="custom-object-chip"]', (n) => n.textContent?.trim() ?? "");
const runScope = () => page.$eval('[data-testid="custom-run-scope"]', (n) => n.textContent?.replace(/\s+/g, " ").trim() ?? "");
const waitOverview = async () => {
  await page.waitForSelector('[data-testid="custom-overview"]', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll(".custom-overview-body").length > 0, { timeout: 30000 });
  await sleep(400);
};
const ensureDrawer = async () => {
  if (!(await page.$(".drawer"))) await clickText(".topbar-docks button", "证据");
  await page.waitForSelector(".drawer");
};
const drawerTab = async (label) => {
  await ensureDrawer();
  await clickText(".tabs .tab", label);
};
const closeDrawer = async () => {
  if (await page.$(".drawer")) {
    await page.evaluate(() => {
      const btn = document.querySelector(".drawer-head .btn");
      btn?.click();
    });
    await sleep(300);
  }
};
const saveCase = async (title) => {
  await drawerTab("证据篮");
  await page.waitForSelector(".basket");
  if (await page.$(".basket > .callout .mono")) await clickText(".basket .btn", "取消关联");
  await page.waitForSelector('.basket input[placeholder="案例标题"]');
  await page.click('.basket input[placeholder="案例标题"]');
  await page.type('.basket input[placeholder="案例标题"]', title);
  const waiter = page.waitForResponse((r) => r.url().endsWith("/api/cases") && r.request().method() === "POST");
  await clickText(".basket .btn", "保存当前案例");
  const res = await waiter;
  const item = await res.json();
  assert.ok(res.status() < 300, `保存案例失败 ${res.status()} ${JSON.stringify(item)}`);
  created.push(item.case_id);
  fs.writeFileSync(path.join(out, "created-cases.json"), JSON.stringify(created, null, 2));
  await page.waitForFunction((id) => document.querySelector(".basket .callout .mono")?.textContent === id, {}, item.case_id);
  return item;
};
const restoreFromBasket = async (caseId) => {
  await drawerTab("证据篮");
  await page.waitForFunction(
    (id) => [...document.querySelectorAll(".saved-investigations .drawer-actions")].some((n) => n.querySelector("a")?.href.includes(id)),
    { timeout: 20000 },
    caseId,
  );
  await page.evaluate((id) => {
    const row = [...document.querySelectorAll(".saved-investigations .drawer-actions")].find((n) => n.querySelector("a")?.href.includes(id));
    row?.querySelector(".restore-investigation")?.click();
  }, caseId);
  await page.waitForFunction(() => document.querySelector(".callout[role='status']")?.textContent?.includes("已恢复调查"), { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 400 });
};
const resetDataset = async (id) => {
  await page.select(".dataset-field select", id);
  await sleep(600);
};
const openRunById = async (runId) => {
  await page.waitForSelector(`[data-run-id="${runId}"] .custom-run-identity`, { timeout: 20000 });
  await page.evaluate((id) => {
    const row = document.querySelector(`.custom-overview-row[data-run-id="${id}"]`);
    row?.querySelector(".custom-run-identity")?.click();
  }, runId);
  await page.waitForSelector('[data-testid="custom-run"]', { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 400 });
};
const openCase = async (caseId) => {
  await page.waitForSelector(`.custom-case-chip[data-case-id="${caseId}"]`, { timeout: 20000 });
  await page.click(`.custom-case-chip[data-case-id="${caseId}"]`);
  await page.waitForNetworkIdle({ idleTime: 500 });
};
const ensureEventsPanel = async () => {
  if (!(await page.$('[aria-label="事件查询"]'))) await openTool("事件查询");
  await page.waitForSelector(".stream-row", { timeout: 20000 });
};
const expandTrack = async (stageKey, side) => {
  await page.waitForSelector(`.custom-track[data-stage-key="${stageKey}"][data-side="${side}"]`, { timeout: 20000 });
  await page.click(`.custom-track[data-stage-key="${stageKey}"][data-side="${side}"]`);
  await sleep(250);
};
const openEventButton = async (eventId) => {
  await page.waitForSelector(`[data-event-id="${eventId}"]`, { timeout: 20000 });
  await page.evaluate((id) => {
    const node = [...document.querySelectorAll(`[data-event-id="${id}"]`)].find((n) => n.tagName === "BUTTON") ?? document.querySelector(`[data-event-id="${id}"]`);
    node?.click();
  }, eventId);
  await page.waitForSelector('[data-testid="custom-reader"]', { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 400 });
};
const closeReader = async () => {
  await page.evaluate(() => document.querySelector('[data-testid="custom-reader"] .custom-detail-actions .btn')?.click());
  await sleep(250);
};
const setSlider = async (valueUs) => {
  await page.waitForSelector(".timebrush-slider", { timeout: 20000 });
  await page.$eval(".timebrush-slider", (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, valueUs);
  await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => {});
  await sleep(600);
};

try {
  // ================= 1. 首屏与结构 =================
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();

  const structure = await page.evaluate(() => ({
    taskTabs: document.querySelectorAll(".task-tab").length,
    modeTabs: document.querySelectorAll(".mode-tab").length,
    viewTabs: document.querySelectorAll(".view-tab").length,
    eventDock: !!document.querySelector(".event-dock"),
    statusbar: !!document.querySelector(".statusbar"),
    customWorkspace: !!document.querySelector(".custom-workspace"),
    page: !!document.querySelector('[data-testid="custom-page"]'),
    runRows: document.querySelectorAll(".custom-overview-body").length,
    readers: document.querySelectorAll('[data-testid="custom-reader"]').length,
    caseChips: document.querySelectorAll(".custom-case-chip").length,
    context: [...document.querySelectorAll(".custom-context > *")].map((n) => n.textContent?.replace(/\s+/g, " ").trim()),
  }));
  check("CUSTOM 是单页：旧四任务/模式/视图标签、事件坞、状态条与旧壳全部退出", () => {
    assert.equal(structure.taskTabs, 0);
    assert.equal(structure.modeTabs, 0);
    assert.equal(structure.viewTabs, 0);
    assert.equal(structure.eventDock, false);
    assert.equal(structure.statusbar, false);
    assert.equal(structure.customWorkspace, false);
    assert.equal(structure.page, true);
  });
  check("首屏主图是运行×阶段概览：32 行，无默认阅读区", () => {
    assert.equal(structure.runRows, 32, `行数 ${structure.runRows}`);
    assert.equal(structure.readers, 0);
    assert.equal(structure.caseChips, 5, `案例 ${structure.caseChips}`);
  });

  const runsApi = await apiGet("/api/runs?dataset=CUSTOM&include_stages=true&limit=200");
  const apiStages = runsApi.stage_dictionary.map((s) => s.label);
  const apiRuns = runsApi.items;
  const first = await overview();
  check("七阶段列来自 stage_dictionary，顺序一致", () => {
    assert.equal(first.dictionary.length, apiStages.length + 2, `列 ${first.dictionary.length}`);
    assert.deepEqual(first.dictionary.slice(1, 1 + apiStages.length), apiStages);
  });
  check("每行 7 个阶段格；格数与批量摘要一致", () => {
    assert.ok(first.cells.every((n) => n === 7), JSON.stringify(first.cells.slice(0, 3)));
    assert.equal(first.states.length, 32 * 7, `DOM 格 ${first.states.length}`);
  });
  check("集合范围标签：完整运行摘要 + 运行内相对时间", () => {
    const text = structure.context.join(" | ");
    assert.ok(text.includes("集合=完整运行摘要"), text);
    assert.ok(text.includes("运行内=相对起点时间"), text);
  });
  check("概览没有逐 run 详情/配对 N+1", () => {
    const detail = requests.filter((r) => /\/api\/runs\/run-/.test(r.url));
    const pair = requests.filter((r) => /\/api\/run-comparisons/.test(r.url));
    assert.equal(detail.length, 0, JSON.stringify(detail.map((r) => r.url)));
    assert.equal(pair.length, 0);
  });
  await shot("default-1600-light");

  // ================= 2. 集合条件与范围 =================
  const selects = await page.$$(".custom-collection select");
  check("集合条件提供 model/fixture/scenario/observed 四个筛选", () => assert.equal(selects.length, 4));
  await page.evaluate(() => {
    const list = [...document.querySelectorAll(".custom-collection select")];
    const scenario = list[2];
    const observed = list[3];
    scenario.value = "all";
    scenario.dispatchEvent(new Event("change", { bubbles: true }));
    observed.value = "false";
    observed.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(500);
  const observedFalse = await overview();
  check("observed=false 匹配 11 个运行", () => {
    assert.equal(observedFalse.count, 11, observedFalse.countText);
    assert.ok(observedFalse.countText.includes("11 / 32"), observedFalse.countText);
  });

  await page.evaluate(() => {
    const scenario = [...document.querySelectorAll(".custom-collection select")][2];
    scenario.value = "stale_version";
    scenario.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(500);
  const staleFalse = await overview();
  check("叠加 scenario=stale_version 匹配 3 个运行", () => {
    assert.equal(staleFalse.count, 3, staleFalse.countText);
  });

  await page.evaluate(() => {
    const observed = [...document.querySelectorAll(".custom-collection select")][3];
    observed.value = "true";
    observed.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(500);
  const staleTrue = await overview();
  check("同场景 observed=true 匹配 5 个运行（与源标签一致）", () => {
    assert.equal(staleTrue.count, 5, staleTrue.countText);
  });

  await clickText(".custom-collection .btn", "清除集合条件");
  await sleep(500);
  const restored = await overview();
  check("清除后概览恢复 32 行", () => assert.equal(restored.count, 32));

  // 事件关键词不裁切集合
  await page.click(".topbar input[type='search']");
  await page.type(".topbar input[type='search']", "zzz-f3-no-match");
  await sleep(700);
  const keywordOverview = await overview();
  check("事件关键词不改变集合（仍 32 行）", () => {
    assert.equal(keywordOverview.count, 32);
    assert.ok(keywordOverview.countText.includes("32 / 32"), keywordOverview.countText);
  });
  await openRunById("run-05e66fcb181b49249deb3de731e4cd10");
  const emptyRun = await page.evaluate(() => ({
    scope: document.querySelector('[data-testid="custom-run-scope"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    text: document.querySelector('[data-testid="custom-run"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    events: document.querySelectorAll(".custom-lanes [data-event-id]").length,
  }));
  check("关键词只作用于运行内事件：可见 0 条且不宣称完整", () => {
    assert.equal(emptyRun.events, 0);
    assert.ok(emptyRun.scope.includes("当前可见 0"), emptyRun.scope);
    assert.ok(emptyRun.scope.includes("完整 31"), emptyRun.scope);
    assert.ok(emptyRun.text.includes("清事件条件"), emptyRun.text);
  });
  await clickText(".custom-scope .btn", "查看完整运行");
  await page.waitForNetworkIdle({ idleTime: 500 });
  const afterClear = await page.evaluate(() => ({
    chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
    scope: document.querySelector('[data-testid="custom-run-scope"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    events: document.querySelectorAll(".custom-lanes [data-event-id]").length,
  }));
  check("清事件筛选后仍是同一运行且恢复完整事件", () => {
    assert.ok(afterClear.chip.includes("运行 05e66fcb"), afterClear.chip);
    assert.ok(afterClear.scope.includes("当前可见 31 / 完整 31"), afterClear.scope);
    assert.equal(afterClear.events, 31);
  });
  await clickText(".custom-run .custom-card-actions .btn", "返回运行集合");
  await page.waitForNetworkIdle({ idleTime: 400 });
  await waitOverview();
  const backRows = await overview();
  check("回集合清掉派生运行作用域，集合条件保留口径", () => {
    assert.equal(backRows.count, 32);
    assert.equal(backRows.countText.includes("32 / 32"), true);
  });
  const afterBackRequests = requests.filter((r) => /\/api\/(events|runs)\?/.test(r.url)).slice(-6).map((r) => r.url);
  check("回集合后的请求不再携带该 run_id", () => {
    assert.ok(afterBackRequests.length > 0);
    assert.ok(afterBackRequests.every((url) => !url.includes("run_id=run-05e66fcb")), JSON.stringify(afterBackRequests));
  });
  await page.evaluate(() => {
    const input = document.querySelector(".topbar input[type='search']");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(500);

  // ================= 3. 0 与无记录 =================
  const normalCell = await page.$eval(
    '.custom-overview-row[data-run-id="run-05e66fcb181b49249deb3de731e4cd10"] .custom-stage-cell[data-stage-key="start"]',
    (n) => ({ state: n.dataset.stageState, label: n.getAttribute("aria-label") ?? "", text: n.textContent?.trim() ?? "" }),
  );
  check("正常案例 start 格：recorded，offset=0 与 0 跨度都是有效值", () => {
    assert.equal(normalCell.state, "recorded");
    assert.ok(normalCell.label.includes("起点 +0.00 秒"), normalCell.label);
    assert.ok(normalCell.label.includes("记录跨度 0.00 秒"), normalCell.label);
    assert.equal(normalCell.text, "1");
  });

  const bypassReview = await page.$eval(
    '.custom-overview-row[data-run-id="run-06309bfc120a40e480100352e1eb52ff"] .custom-stage-cell[data-stage-key="review"]',
    (n) => ({ state: n.dataset.stageState, label: n.getAttribute("aria-label") ?? "", text: n.textContent?.trim() ?? "" }),
  );
  check("审批绕过案例 review 格：no_record，不是 0 时长", () => {
    assert.equal(bypassReview.state, "no_record");
    assert.ok(bypassReview.label.includes("完整日志未记录"), bypassReview.label);
    assert.equal(bypassReview.text, "—");
  });
  await page.click('.custom-overview-row[data-run-id="run-06309bfc120a40e480100352e1eb52ff"] .custom-stage-cell[data-stage-key="review"]');
  await sleep(300);
  const noRecordSample = await page.evaluate(() => ({
    text: document.querySelector(".custom-stage-samples")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    events: document.querySelectorAll(".custom-stage-samples [data-event-id]").length,
    readers: document.querySelectorAll('[data-testid="custom-reader"]').length,
  }));
  check("点无记录格只说明原因，不打开不存在的事件", () => {
    assert.ok(noRecordSample.text.includes("完整日志未记录"), noRecordSample.text);
    assert.equal(noRecordSample.events, 0);
    assert.equal(noRecordSample.readers, 0);
  });

  await page.click('.custom-overview-row[data-run-id="run-06309bfc120a40e480100352e1eb52ff"] .custom-stage-cell[data-stage-key="result"]');
  await sleep(300);
  await openEventButton(EV.bypassResult);
  const resultReader = await readerInfo();
  check("阶段样本打开真实事件：reader 与 selection 同一事件", () => {
    assert.equal(resultReader.count, 1);
    assert.equal(resultReader.id, EV.bypassResult, JSON.stringify(resultReader));
    assert.ok(resultReader.owner.includes("当前运行"));
  });
  const resultCase = await saveCase(`F3 阶段样本 ${Date.now()}`);
  check("保存快照的 selection 与正文 ID 一致", () => {
    assert.equal(resultCase.snapshot.selection.kind, "event");
    assert.equal(resultCase.snapshot.selection.id, EV.bypassResult);
    assert.equal(resultCase.snapshot.trace_object.runId, "run-06309bfc120a40e480100352e1eb52ff");
  });
  await closeDrawer();
  await page.evaluate(() => document.querySelector('[data-testid="custom-run"]')?.scrollIntoView({ block: "start" }));
  await shot("run-sample-1600-light");

  // ================= 4. 审批绕过配对 =================
  await resetDataset("MC1");
  await resetDataset("CUSTOM");
  await waitOverview();
  await openCase("custom-bypass-review");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 30000 });
  await page.waitForSelector(".custom-pair-row", { timeout: 30000 });
  await sleep(500);

  const pairApi = await apiGet(
    "/api/run-comparisons?dataset=CUSTOM&run_id=run-06309bfc120a40e480100352e1eb52ff&baseline_run_id=run-93d3d84d65264529b23da42b8fe8cba7",
  );
  const pairDom = await page.evaluate(() => ({
    rows: document.querySelectorAll(".custom-pair-row").length,
    missingRunReview: !!document.querySelector('[data-testid="custom-pair-missing-run-review"]'),
    missingBaselineReview: !!document.querySelector('[data-testid="custom-pair-missing-baseline-review"]'),
    axisMax: document.querySelector(".custom-pair-axis")?.dataset.axisMax ?? "",
    counts: [...document.querySelectorAll(".custom-pair-row")].map((row) => ({
      stage: row.dataset.stageKey,
      run: row.querySelector('.custom-track[data-side="run"]')?.dataset.count ?? null,
      baseline: row.querySelector('.custom-track[data-side="baseline"]')?.dataset.count ?? null,
      missingRun: !!row.querySelector('[data-testid^="custom-pair-missing-run-"]'),
      missingBaseline: !!row.querySelector('[data-testid^="custom-pair-missing-baseline-"]'),
    })),
    header: document.querySelector('[data-testid="custom-pair"] .custom-card-head')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("配对使用固定 baseline，两侧七行阶段与 API 一致", () => {
    assert.equal(pairDom.rows, 7);
    assert.equal(pairApi.stages.length, 7);
    assert.ok(pairDom.header.includes("run-06309bfc120a40e480100352e1eb52ff"), pairDom.header);
    assert.ok(pairDom.header.includes("run-93d3d84d65264529b23da42b8fe8cba7"), pairDom.header);
    for (const stage of pairApi.stages) {
      const dom = pairDom.counts.find((item) => item.stage === stage.stage);
      assert.ok(dom, stage.stage);
      assert.equal(Number(dom.run), stage.run.count, `${stage.stage} run`);
      assert.equal(Number(dom.baseline), stage.baseline.count, `${stage.stage} baseline`);
      assert.equal(dom.missingRun, stage.missing.run, `${stage.stage} missing run`);
      assert.equal(dom.missingBaseline, stage.missing.baseline, `${stage.stage} missing baseline`);
    }
  });
  check("当前侧 review 未记录、对照侧有记录，共用同一相对时间轴", () => {
    assert.equal(pairDom.missingRunReview, true);
    assert.equal(pairDom.missingBaselineReview, false);
    const ends = pairApi.stages
      .flatMap((s) => [s.run, s.baseline])
      .map((side) => (side.start_offset_us != null && side.duration_us != null ? side.start_offset_us + side.duration_us : null))
      .filter((v) => v != null);
    assert.equal(Number(pairDom.axisMax), Math.max(...ends));
  });

  await expandTrack("result", "run");
  await openEventButton(EV.bypassResult);
  const runEventReader = await readerInfo();
  check("配对里打开当前侧事件：正文标明当前运行", () => {
    assert.equal(runEventReader.id, EV.bypassResult);
    assert.ok(runEventReader.owner.includes("当前运行"), runEventReader.owner);
  });
  await expandTrack("result", "baseline");
  const baselineEvent = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.custom-pair-events [data-side="baseline"]')];
    return { id: btns[0]?.getAttribute("data-event-id") ?? "", count: btns.length };
  });
  check("对照侧轨迹可展开真实 event_ids", () => assert.ok(baselineEvent.count >= 1 && baselineEvent.id.length > 10));
  await openEventButton(baselineEvent.id);
  const baselineReader = await readerInfo();
  const chipAfterBaseline = await objectChip();
  check("打开对照事件不改当前调查运行，正文标明正常对照", () => {
    assert.equal(baselineReader.id, baselineEvent.id);
    assert.ok(baselineReader.owner.includes("正常对照"), baselineReader.owner);
    assert.ok(chipAfterBaseline.includes("配对 06309bfc"), chipAfterBaseline);
  });
  await clickText(".custom-msg-actions .btn", "支持");
  const pairCase = await saveCase(`F3 配对恢复 ${Date.now()}`);
  check("保存配对案例：runPair 两侧与对照事件 selection 均正确", () => {
    assert.equal(pairCase.snapshot.comparison.kind, "runPair");
    assert.equal(pairCase.snapshot.comparison.runId, "run-06309bfc120a40e480100352e1eb52ff");
    assert.equal(pairCase.snapshot.comparison.baselineRunId, "run-93d3d84d65264529b23da42b8fe8cba7");
    assert.equal(pairCase.snapshot.selection.id, baselineEvent.id);
    assert.equal(pairCase.snapshot.pinned_evidence.length, 1);
    assert.ok(!("runId" in pairCase.snapshot.base_filters));
  });
  await closeDrawer();
  await page.evaluate(() => document.querySelector('[data-testid="custom-pair"]')?.scrollIntoView({ block: "start" }));
  await shot("pair-1600-light");

  // ================= 5. 重复恢复 =================
  await closeDrawer();
  await resetDataset("MC1");
  await page.waitForSelector('[data-testid="mc1-page"]', { timeout: 30000 });
  await resetDataset("CUSTOM");
  await waitOverview();
  await restoreFromBasket(pairCase.case_id);
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 30000 });
  const restoredReader = await readerInfo();
  check("恢复后配对、区间与阅读正文一起回来", () => {
    assert.equal(restoredReader.count, 1);
    assert.equal(restoredReader.id, baselineEvent.id);
  });
  const pairAgain = await saveCase(`F3 配对复存 ${Date.now()}`);
  check("恢复后再保存：pair/trace/selection/集合/事件筛选/回放/证据一致", () => {
    assert.deepEqual(pairAgain.snapshot.comparison, pairCase.snapshot.comparison);
    assert.deepEqual(pairAgain.snapshot.trace_object, pairCase.snapshot.trace_object);
    assert.deepEqual(pairAgain.snapshot.selection, pairCase.snapshot.selection);
    assert.deepEqual(pairAgain.snapshot.collection_filters, pairCase.snapshot.collection_filters);
    assert.deepEqual(pairAgain.snapshot.base_filters, pairCase.snapshot.base_filters);
    assert.deepEqual(pairAgain.snapshot.replay, pairCase.snapshot.replay);
    assert.deepEqual(pairAgain.snapshot.pinned_evidence, pairCase.snapshot.pinned_evidence);
  });
  const playLabel = await page.$eval(".timebrush-row .btn", (n) => n.textContent?.trim() ?? "");
  check("恢复后回放保持暂停", () => assert.equal(playLabel, "播放"));

  await closeReader();
  await sleep(300);
  const closed = await readerInfo();
  check("普通关闭后阅读区保持关闭", () => assert.equal(closed.count, 0));
  await restoreFromBasket(pairCase.case_id);
  await sleep(600);
  const reopened = await readerInfo();
  check("重复恢复同一案例重新打开正文", () => assert.equal(reopened.count, 1));

  // ================= 6. 游标、完整范围与配对例外 =================
  await resetDataset("MC1");
  await resetDataset("CUSTOM");
  await waitOverview();
  await openCase("custom-bypass-review");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 30000 });
  await clickText(".custom-pair .custom-card-actions .btn", "返回运行");
  await page.waitForSelector('[data-testid="custom-run"]', { timeout: 30000 });
  await page.waitForNetworkIdle({ idleTime: 500 });
  const attemptEvent = await apiGet(`/api/events/${EV.bypassAttempt}?dataset=CUSTOM`);
  const cursorTarget = attemptEvent.time_us - 2_000_000;
  await setSlider(cursorTarget);
  const masked = await page.evaluate(() => ({
    cursor: Number(document.querySelector(".timebrush-slider")?.value ?? 0),
    attempt: document.querySelectorAll('.custom-lanes [data-event-id="08148a87-df33-4706-8b2a-a4e3b0aedaa3"]').length,
    result: document.querySelectorAll('.custom-lanes [data-event-id="8a655819-3b06-4146-9cc3-d5bca0095e4d"]').length,
    auditDisabled: [...document.querySelectorAll('.audit-evidence [data-event-id="08148a87-df33-4706-8b2a-a4e3b0aedaa3"]')].every((n) => n.disabled),
    audit: document.querySelector('[data-testid="custom-audit-summary"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    scope: document.querySelector('[data-testid="custom-run-scope"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    overviewRows: document.querySelectorAll(".custom-overview-body").length,
    overviewResultState: document.querySelector('.custom-overview-row[data-run-id="run-06309bfc120a40e480100352e1eb52ff"] .custom-stage-cell[data-stage-key="result"]')?.dataset.stageState ?? "",
  }));
  check("游标移到 publish_attempt 之前：遮蔽后不显示该尝试与结果，审计不宣称成功", () => {
    assert.ok(masked.cursor < attemptEvent.time_us, JSON.stringify(masked));
    assert.equal(masked.attempt, 0);
    assert.equal(masked.result, 0);
    assert.equal(masked.auditDisabled, true);
    assert.ok(masked.audit.includes("发布当前版本 0"), masked.audit);
    assert.ok(masked.scope.includes("回放截止"), masked.scope);
  });
  check("概览仍是 full_run 摘要，不随游标重算", () => {
    assert.equal(masked.overviewRows, 32);
    assert.equal(masked.overviewResultState, "recorded");
  });
  await clickText(".custom-run .custom-card-actions .btn", "与正常对照比较");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 30000 });
  await page.waitForNetworkIdle({ idleTime: 400 });
  const pairAgainstCursor = await page.evaluate(() => ({
    resultCount: document.querySelector('.custom-pair-row[data-stage-key="result"] .custom-track[data-side="run"]')?.dataset.count ?? "",
    play: document.querySelector(".timebrush-row .btn")?.textContent?.trim() ?? "",
    warn: document.querySelector('[data-testid="custom-pair"]')?.textContent?.includes("配对=两次完整运行"),
  }));
  check("进入配对后仍显示完整结果并保持暂停", () => {
    assert.equal(pairAgainstCursor.resultCount, "1");
    assert.equal(pairAgainstCursor.play, "播放");
    assert.equal(pairAgainstCursor.warn, true);
  });
  await clickText(".custom-pair .custom-card-actions .btn", "返回运行");
  await page.waitForSelector('[data-testid="custom-run"]', { timeout: 30000 });
  await sleep(400);
  const backToRunScope = await runScope();
  check("返回运行后游标限制的语义与显示一致", () => assert.ok(backToRunScope.includes("回放截止"), backToRunScope));
  await page.evaluate(() => {
    const slider = document.querySelector(".timebrush-slider");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(slider, slider?.max ?? "");
    slider?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForNetworkIdle({ idleTime: 500 });

  // ================= 7. 旧版两种结果 =================
  await resetDataset("MC1");
  await resetDataset("CUSTOM");
  await waitOverview();
  await openCase("custom-stale-denied");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 30000 });
  await expandTrack("result", "run");
  await openEventButton(EV.deniedResult);
  const denied = await page.evaluate(() => ({
    reader: document.querySelector('[data-testid="custom-reader"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    audit: document.querySelector('[data-testid="custom-pair"] .callout')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("旧版被拒绝：结果事件为 denied，published_stale=0", () => {
    assert.ok(denied.reader.includes("denied") || denied.reader.includes("拒绝"), denied.reader.slice(0, 160));
    assert.ok(denied.audit.includes("发布旧版 0"), denied.audit);
  });
  await closeReader();

  await resetDataset("MC1");
  await resetDataset("CUSTOM");
  await waitOverview();
  await openCase("custom-stale-published");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 30000 });
  await expandTrack("result", "run");
  await openEventButton(EV.stalePublishedResult);
  const stalePublished = await page.evaluate(() => ({
    reader: document.querySelector('[data-testid="custom-reader"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    audit: document.querySelector('[data-testid="custom-pair"] .callout')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("旧版已发布：review_valid=1 但 published_stale=1，文案不与 denied 互换", () => {
    assert.ok(stalePublished.audit.includes("发布旧版 1"), stalePublished.audit);
    assert.ok(stalePublished.audit.includes("审核无效 0"), stalePublished.audit);
    assert.ok(!stalePublished.reader.includes("denied"), stalePublished.reader.slice(0, 160));
  });

  // ================= 8. 缺失引用恢复（fixture，明确标注） =================
  const fixtureBase = pairCase.snapshot;
  const missingRunSnapshot = JSON.parse(JSON.stringify(fixtureBase));
  missingRunSnapshot.trace_object = { dataset: "CUSTOM", runId: "run-f3-missing-run" };
  missingRunSnapshot.comparison = null;
  missingRunSnapshot.task = "trace";
  missingRunSnapshot.mode = "run";
  missingRunSnapshot.task_modes = { ...missingRunSnapshot.task_modes, trace: "run" };
  missingRunSnapshot.selection = null;
  const missingRunCase = await apiPost("/api/cases", { dataset_id: "CUSTOM", title: `F3 缺失运行 fixture ${Date.now()}`, snapshot: missingRunSnapshot });
  created.push(missingRunCase.case_id);

  const missingBaselineSnapshot = JSON.parse(JSON.stringify(fixtureBase));
  missingBaselineSnapshot.comparison = {
    kind: "runPair",
    runId: "run-06309bfc120a40e480100352e1eb52ff",
    baselineRunId: "run-f3-missing-baseline",
  };
  missingBaselineSnapshot.trace_object = { dataset: "CUSTOM", runId: "run-06309bfc120a40e480100352e1eb52ff" };
  missingBaselineSnapshot.selection = null;
  const missingBaselineCase = await apiPost("/api/cases", { dataset_id: "CUSTOM", title: `F3 缺失对照 fixture ${Date.now()}`, snapshot: missingBaselineSnapshot });
  created.push(missingBaselineCase.case_id);

  const missingEventSnapshot = JSON.parse(JSON.stringify(fixtureBase));
  missingEventSnapshot.selection = { kind: "event", id: "f3-missing-event", timeUs: null };
  const missingEventCase = await apiPost("/api/cases", { dataset_id: "CUSTOM", title: `F3 缺失事件 fixture ${Date.now()}`, snapshot: missingEventSnapshot });
  created.push(missingEventCase.case_id);

  const missingRequests = [];
  const watchMissing = (req) => {
    if (/run-f3-missing|f3-missing-event/.test(req.url())) missingRequests.push(req.url());
  };
  page.on("request", watchMissing);

  await resetDataset("MC1");
  await resetDataset("CUSTOM");
  await waitOverview();
  await restoreFromBasket(missingRunCase.case_id);
  await sleep(800);
  const missingRunView = await page.evaluate(() => ({
    run: !!document.querySelector('[data-testid="custom-run"]'),
    text: document.querySelector('[data-testid="custom-run"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
  }));
  check("缺失运行：保留原 ID、明确说明、不请求也不换运行", () => {
    assert.ok(missingRunView.text.includes("缺失"), missingRunView.text);
    assert.ok(missingRunView.text.includes("run-f3-missing-run"), missingRunView.text);
    assert.ok(missingRunView.chip.includes("f3-miss"), missingRunView.chip);
  });
  const missingRunResave = await saveCase(`F3 缺失运行复存 ${Date.now()}`);
  check("缺失运行再保存不丢引用", () => assert.equal(missingRunResave.snapshot.trace_object.runId, "run-f3-missing-run"));

  await resetDataset("MC1");
  await resetDataset("CUSTOM");
  await waitOverview();
  await restoreFromBasket(missingBaselineCase.case_id);
  await sleep(800);
  const missingBaselineView = await page.evaluate(() => ({
    text: document.querySelector('[data-testid="custom-pair"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  check("缺失 baseline：保留当前有效运行，不换 baseline 伪装修复", () => {
    assert.ok(missingBaselineView.text.includes("run-f3-missing-baseline"), missingBaselineView.text);
    assert.ok(missingBaselineView.text.includes("run-06309bfc120a40e480100352e1eb52ff"), missingBaselineView.text);
  });
  const missingBaselineResave = await saveCase(`F3 缺失对照复存 ${Date.now()}`);
  check("缺失 baseline 再保存不丢引用", () => {
    assert.equal(missingBaselineResave.snapshot.comparison.baselineRunId, "run-f3-missing-baseline");
  });

  await resetDataset("MC1");
  await resetDataset("CUSTOM");
  await waitOverview();
  await restoreFromBasket(missingEventCase.case_id);
  await sleep(800);
  const missingEventView = await readerInfo();
  check("缺失选中事件：不打开旧正文、不请求已知缺失事件", () => {
    assert.equal(missingEventView.count, 0);
  });
  const missingEventResave = await saveCase(`F3 缺失事件复存 ${Date.now()}`);
  check("缺失事件再保存保留原引用", () => assert.equal(missingEventResave.snapshot.selection.id, "f3-missing-event"));
  page.off("request", watchMissing);
  check("恢复缺失引用期间没有请求已知缺失 ID", () => assert.deepEqual(missingRequests, []));

  // ================= 9. 唯一阅读区、几何与焦点 =================
  await resetDataset("MC1");
  await resetDataset("CUSTOM");
  await waitOverview();
  await openRunById("run-05e66fcb181b49249deb3de731e4cd10");
  await page.evaluate(() => {
    const lane = document.querySelector(".custom-lanes [data-event-id]");
    lane?.setAttribute("tabindex", "0");
    lane?.focus();
  });
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="custom-reader"]', { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 300 });
  const svgOpened = await readerInfo();
  check("泳道事件打开同一阅读区", () => assert.ok(svgOpened.id.length > 10, JSON.stringify(svgOpened)));
  await page.keyboard.press("Escape");
  await sleep(300);
  const focusBack = await page.evaluate(() => ({
    readers: document.querySelectorAll('[data-testid="custom-reader"]').length,
    active: document.activeElement?.getAttribute("data-event-id") ?? "",
  }));
  check("Escape 关闭阅读区并回焦到原 SVG 控件", () => {
    assert.equal(focusBack.readers, 0);
    assert.equal(focusBack.active, svgOpened.id);
  });

  // 工具卡不得清掉当前运行；关闭工具后回到角色流程
  await openTool("系统总览");
  await page.waitForSelector('[aria-label="系统总览"]', { timeout: 20000 });
  await sleep(400);
  const toolKeepsRun = await page.evaluate(() => ({
    chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
    run: !!document.querySelector('[data-testid="custom-run"]'),
  }));
  check("打开系统总览工具不清当前运行", () => {
    assert.ok(toolKeepsRun.chip.includes("运行 "), toolKeepsRun.chip);
    assert.equal(toolKeepsRun.run, true);
  });
  await page.evaluate(() => {
    const card = document.querySelector('[aria-label="系统总览"]');
    const btn = [...(card?.querySelectorAll(".custom-card-head .btn") ?? [])].find((b) => b.textContent?.includes("关闭"));
    btn?.click();
  });
  await sleep(600);
  const toolClosed = await page.evaluate(() => ({
    chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
    system: !!document.querySelector('[aria-label="系统总览"]'),
    run: !!document.querySelector('[data-testid="custom-run"]'),
  }));
  check("关闭工具卡回到当前运行而非运行集合", () => {
    assert.ok(toolClosed.chip.includes("运行 "), toolClosed.chip);
    assert.equal(toolClosed.system, false);
    assert.equal(toolClosed.run, true);
  });

  for (const width of [1600, 1366, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : width === 1366 ? 768 : 1000 });
    await sleep(400);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(`layout-${width}-light`);
    await ensureEventsPanel();
    await page.evaluate(() => document.querySelector(".stream-row")?.scrollIntoView({ block: "center" }));
    const rowId = await page.$eval(".stream-row", (n) => n.getAttribute("data-event-id") ?? "");
    await page.click(".stream-row");
    await page.waitForSelector('[data-testid="custom-reader"]', { timeout: 20000 });
    await page.waitForNetworkIdle({ idleTime: 300 });
    const geometry = await page.evaluate(() => {
      const reader = document.querySelector('[data-testid="custom-reader"]');
      const title = reader?.querySelector(".custom-reader-title")?.getBoundingClientRect();
      const close = reader?.querySelector(".custom-detail-actions .btn")?.getBoundingClientRect();
      const body = reader?.querySelector(".custom-reader-body");
      return {
        titleVisible: !!title && title.top >= 0 && title.bottom <= window.innerHeight,
        closeVisible: !!close && close.top >= 0 && close.bottom <= window.innerHeight,
        bodyScrollable: !!body && body.scrollHeight > body.clientHeight,
        bodyOverflow: body ? getComputedStyle(body).overflowY : "",
        readers: document.querySelectorAll('[data-testid="custom-reader"]').length,
        drawers: document.querySelectorAll(".drawer").length,
        bodyWidth: document.body.scrollWidth,
        viewport: window.innerWidth,
        cardWidth: Math.round(document.querySelector('[data-testid="custom-run"]')?.getBoundingClientRect().width ?? 0),
        pageWidth: Math.round(document.querySelector('[data-testid="custom-page"]')?.getBoundingClientRect().width ?? 0),
      };
    });
    check(`宽 ${width}：底部工具打开阅读区后标题/关闭在视口内，正文可内部滚动`, () => {
      assert.equal(geometry.readers, 1);
      assert.equal(geometry.titleVisible, true, JSON.stringify(geometry));
      assert.equal(geometry.closeVisible, true, JSON.stringify(geometry));
      assert.equal(geometry.bodyOverflow, "auto");
    });
    check(`宽 ${width}：无整页横向溢出、无双辅助区互挡`, () => {
      assert.ok(geometry.bodyWidth <= geometry.viewport + 1, `${geometry.bodyWidth} > ${geometry.viewport}`);
      assert.ok(geometry.pageWidth <= geometry.viewport + 1, `page ${geometry.pageWidth} > ${geometry.viewport}`);
      assert.ok(geometry.cardWidth <= geometry.viewport + 1, `card ${geometry.cardWidth} > ${geometry.viewport}`);
      assert.equal(geometry.drawers, 0);
    });
    await shot(`reader-bottom-${width}`);
    await page.evaluate(() => {
      const details = document.querySelector(".custom-reader-body .custom-raw");
      if (details instanceof HTMLDetailsElement) details.open = true;
    });
    await sleep(200);
    const rawScroll = await page.evaluate(() => {
      const pre = document.querySelector(".custom-reader-body .custom-raw pre");
      const body = document.querySelector(".custom-reader-body");
      if (!pre || !body) return null;
      const style = getComputedStyle(pre);
      const bodyStyle = getComputedStyle(body);
      return {
        overflow: style.overflowY,
        maxHeight: parseFloat(style.maxHeight || "0"),
        clientHeight: pre.clientHeight,
        scrollHeight: pre.scrollHeight,
        bodyOverflow: bodyStyle.overflowY,
        bodyMaxHeight: bodyStyle.maxHeight,
        bodyScrollable: body.scrollHeight > body.clientHeight,
      };
    });
    check(`宽 ${width}：raw/details 限高可内部滚动，正文区块自身可滚动`, () => {
      assert.ok(rawScroll, "raw 不存在");
      assert.equal(rawScroll.overflow, "auto");
      assert.ok(rawScroll.maxHeight > 0 && rawScroll.maxHeight <= 300, JSON.stringify(rawScroll));
      assert.ok(rawScroll.clientHeight <= rawScroll.maxHeight + 1, JSON.stringify(rawScroll));
      assert.equal(rawScroll.bodyOverflow, "auto");
      console.log(`  raw 容器 ${width}: client ${rawScroll.clientHeight} / scroll ${rawScroll.scrollHeight}, body scrollable=${rawScroll.bodyScrollable}`);
    });
    await page.evaluate(() => document.querySelector('[data-testid="custom-reader"] .custom-detail-actions .btn')?.click());
    await sleep(300);
    const afterClose = await page.evaluate(() => ({
      readers: document.querySelectorAll('[data-testid="custom-reader"]').length,
      active: document.activeElement?.getAttribute("data-event-id") ?? "",
    }));
    check(`宽 ${width}：关闭后回焦到原事件行`, () => {
      assert.equal(afterClose.readers, 0);
      assert.equal(afterClose.active, rowId);
    });
  }
  await page.setViewport({ width: 1600, height: 1000 });

  // 键盘：方向键在列表内切换正文，输入框不抢
  await ensureEventsPanel();
  await page.evaluate(() => document.querySelector(".stream-row")?.focus());
  const firstRowId = await page.$eval(".stream-row", (n) => n.getAttribute("data-event-id") ?? "");
  await page.keyboard.press("ArrowDown");
  await sleep(500);
  const keyboard = await page.evaluate(() => ({
    readerId: document.querySelector('[data-testid="custom-reader"] .custom-msg-meta .mono')?.textContent?.trim() ?? "",
    active: document.activeElement?.getAttribute("data-event-id") ?? "",
    second: document.querySelectorAll(".stream-row")[1]?.getAttribute("data-event-id") ?? "",
  }));
  check("方向键选中行、焦点与正文 ID 三者一致", () => {
    assert.equal(keyboard.readerId, keyboard.second);
    assert.equal(keyboard.active, keyboard.second);
    assert.notEqual(keyboard.readerId, firstRowId);
  });
  await page.click(".topbar input[type='search']");
  await page.keyboard.press("ArrowDown");
  await sleep(300);
  const afterInput = await readerInfo();
  check("输入框内方向键不改正文", () => assert.equal(afterInput.id, keyboard.readerId));

  // ================= 10. 草稿失败、导出 =================
  await drawerTab("笔记");
  await page.waitForSelector(".notes textarea", { timeout: 20000 });
  await page.type(".notes textarea", "F3 草稿保留检查");
  await page.setRequestInterception(true);
  let notesFailurePending = true;
  let delayRunId = null;
  const intercept = (req) => {
    if (notesFailurePending && req.url().endsWith("/api/notes") && req.method() === "POST") {
      notesFailurePending = false;
      intentional.push("notes-500");
      req.respond({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "F3 受控失败" }) }).catch(() => {});
      return;
    }
    if (delayRunId && req.url().includes(`/api/runs/${delayRunId}?`)) {
      delayRunId = null;
      setTimeout(() => req.continue().catch(() => {}), 2500);
      return;
    }
    req.continue().catch(() => {});
  };
  page.on("request", intercept);
  await clickText(".notes-actions .btn", "保存笔记");
  await page.waitForFunction(() => document.querySelector(".notes-error")?.textContent?.includes("保存失败"), { timeout: 10000 });
  const draftKept = await page.$eval(".notes textarea", (n) => n.value);
  check("受控保存失败后输入保留", () => assert.equal(draftKept, "F3 草稿保留检查"));
  await clickText(".tabs .tab", "关联");
  await sleep(300);
  await clickText(".tabs .tab", "笔记");
  const draftAfterSwitch = await page.$eval(".notes textarea", (n) => n.value);
  check("切换工具页签后草稿仍在", () => assert.equal(draftAfterSwitch, "F3 草稿保留检查"));
  const noteWaiter = page.waitForResponse((r) => r.url().endsWith("/api/notes") && r.request().method() === "POST");
  await clickText(".notes-actions .btn", "保存笔记");
  const noteRes = await noteWaiter;
  const noteItem = await noteRes.json();
  check("重试保存成功并写入真实选择", () => {
    assert.ok(noteRes.status() < 300, String(noteRes.status()));
    assert.equal(noteItem.body, "F3 草稿保留检查");
  });
  if (noteItem?.note_id) {
    await fetch(`${base}/api/notes/${noteItem.note_id}`, { method: "DELETE" }).catch(() => {});
  }
  const md = await (await fetch(`${base}/api/cases/${pairCase.case_id}/export?format=md`)).text();
  const json = await (await fetch(`${base}/api/cases/${pairCase.case_id}/export?format=json`)).json();
  check("MD/JSON 导出含真实事件、运行/配对与数据版本", () => {
    assert.ok(md.includes(baselineEvent.id), "MD 缺事件");
    assert.ok(md.includes("run-06309bfc120a40e480100352e1eb52ff"), "MD 缺运行");
    assert.ok(md.includes("run-93d3d84d65264529b23da42b8fe8cba7"), "MD 缺对照");
    assert.ok(JSON.stringify(json).includes("bf5700539e9ff086920a71ed04510b22d2948248e2a0fb3e733b23ae33482094"), "JSON 缺数据版本");
  });

  // ================= 11. 迟到响应与跨集 =================
  await resetDataset("MC1");
  await resetDataset("CUSTOM");
  await waitOverview();
  delayRunId = "run-05e66fcb181b49249deb3de731e4cd10";
  await openRunById("run-05e66fcb181b49249deb3de731e4cd10");
  await page.evaluate(() => {
    const row = document.querySelector('.custom-overview-row[data-run-id="run-1f3c25268adb42508c52c08b9ff343cd"]');
    row?.querySelector(".custom-run-identity")?.click();
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.includes("1f3c2526"),
    { timeout: 15000 },
  );
  await sleep(3000);
  const afterLate = await page.evaluate(() => ({
    chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
    title: document.querySelector('[data-testid="custom-run"] .custom-card-head h2')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    laneEvents: document.querySelectorAll(".custom-lanes [data-event-id]").length,
  }));
  check("A→B 迟到响应不覆盖 B 的标题与泳道", () => {
    assert.ok(afterLate.chip.includes("1f3c2526"), afterLate.chip);
    assert.ok(afterLate.title.includes("run-1f3c25268adb42508c52c08b9ff343cd"), afterLate.title);
    assert.ok(afterLate.laneEvents > 0);
  });
  page.off("request", intercept);
  await page.setRequestInterception(false);
  await resetDataset("MC2");
  await page.waitForSelector('[data-testid="mc2-page"]', { timeout: 30000 });
  const mc2 = await page.evaluate(() => ({
    page: !!document.querySelector('[data-testid="mc2-page"]'),
    custom: !!document.querySelector('[data-testid="custom-page"]'),
  }));
  check("MC2 页面独立渲染，无 CUSTOM 残留", () => {
    assert.equal(mc2.page, true);
    assert.equal(mc2.custom, false);
  });

  // ================= 12. 跨集回归与深浅色 =================
  await resetDataset("MC1");
  await page.waitForSelector('[data-testid="mc1-page"]', { timeout: 30000 });
  await sleep(800);
  const mc1 = await page.evaluate(() => ({
    page: !!document.querySelector('[data-testid="mc1-page"]'),
    readers: document.querySelectorAll('[data-testid="mc1-reader"]').length,
    errors: !!document.querySelector(".stream-error"),
  }));
  check("MC1 参考单页仍在，未出现 CUSTOM 阅读区", () => {
    assert.equal(mc1.page, true);
    assert.equal(mc1.readers, 0);
    assert.equal(mc1.errors, false);
  });
  await shot("mc1-regression");

  // ================= 13. 复核 R1–R4：连续操作 =================
  const IDS = {
    normal: "run-05e66fcb181b49249deb3de731e4cd10",
    bypass: "run-06309bfc120a40e480100352e1eb52ff",
    bypassBase: "run-93d3d84d65264529b23da42b8fe8cba7",
    stale: "run-91134b6f7c5e455782a739185bd7ce8f",
  };
  const chartState = () =>
    page.evaluate(() => {
      const toggles = [...document.querySelectorAll(".custom-toggle")];
      const pressed = (label) => toggles.find((n) => n.textContent?.includes(label))?.getAttribute("aria-pressed");
      return {
        flow: !!document.querySelector('[data-testid="custom-run"]'),
        pair: !!document.querySelector('[data-testid="custom-pair"]'),
        hiddenPair: !!document.querySelector('[data-testid="custom-hidden-pair"]'),
        flowOn: pressed("运行流程"),
        pairOn: pressed("配对"),
        overviewOn: pressed("概览"),
        overviewRows: document.querySelectorAll(".custom-overview-body").length,
        chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
      };
    });
  const toggleChart = async (label) => {
    await page.evaluate((text) => {
      [...document.querySelectorAll(".custom-toggle")].find((n) => n.textContent?.includes(text))?.click();
    }, label);
    await sleep(300);
  };
  const openLaneEvent = async () => {
    const id = await page.evaluate(
      () => document.querySelector(".custom-lanes [data-event-id]")?.getAttribute("data-event-id") ?? "",
    );
    assert.ok(id, "泳道没有可点事件");
    await page.click(`.custom-lanes [data-event-id="${id}"]`);
    await page.waitForSelector('[data-testid="custom-reader"]', { timeout: 20000 });
    await page.waitForNetworkIdle({ idleTime: 300 });
    return id;
  };
  const canvas = () => page.evaluate(() => Math.round(document.querySelector(".canvas-area")?.scrollTop ?? 0));
  const toTop = async () => {
    await page.evaluate(() => document.querySelector(".canvas-area")?.scrollTo(0, 0));
    await sleep(250);
  };
  const boxOf = (selector) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const bar = document.querySelector(".controlbar")?.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        height: Math.round(box.height),
        barTop: bar ? Math.round(bar.top) : window.innerHeight,
        viewport: window.innerHeight,
      };
    }, selector);
  const visibleAboveBar = (box) =>
    !!box && box.height > 0 && box.top < box.viewport && box.bottom > 0 && box.top < box.barTop;

  // R1-a：已有正文 → 打开另一冻结案例
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();
  await openRunById(IDS.normal);
  const laneEvent = await openLaneEvent();
  const beforeCaseSwitch = await readerInfo();
  await openCase("custom-bypass-review");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 400 });
  const afterCaseSwitch = { reader: await readerInfo(), chart: await chartState() };
  check("R1-a：有正文时打开另一案例，旧正文随 selection 一起关闭", () => {
    assert.equal(beforeCaseSwitch.count, 1);
    assert.equal(beforeCaseSwitch.id, laneEvent);
    assert.equal(afterCaseSwitch.reader.count, 0);
    assert.ok(afterCaseSwitch.chart.chip.includes("配对"), afterCaseSwitch.chart.chip);
    assert.equal(afterCaseSwitch.chart.pair, true);
  });

  // R1-b：有正文 → 换运行 → 打开新事件并保存，快照 selection 与正文一致
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();
  await openRunById(IDS.normal);
  await openLaneEvent();
  await page.evaluate((id) => {
    const row = [...document.querySelectorAll(".custom-overview-row:not(.custom-overview-head)")].find(
      (n) => n.getAttribute("data-run-id") === id,
    );
    row?.querySelector(".custom-run-identity")?.click();
  }, IDS.bypass);
  await page.waitForFunction(() => document.querySelector('[data-testid="custom-run-scope"]')?.textContent?.includes("26"), { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 400 });
  const afterRunSwitch = { reader: await readerInfo(), chart: await chartState() };
  check("R1-b：有正文时切换运行，旧正文关闭、当前对象是新运行", () => {
    assert.equal(afterRunSwitch.reader.count, 0);
    assert.ok(afterRunSwitch.chart.chip.includes("运行 06309bfc"), afterRunSwitch.chart.chip);
    assert.equal(afterRunSwitch.chart.flow, true);
  });
  const switchedEvent = await openLaneEvent();
  const switchedReader = await readerInfo();
  const switchedCase = await saveCase(`F3 R1 切换运行 ${Date.now()}`);
  check("R1-c：切换运行后保存，selection 与正文同一事件、运行仍为新运行", () => {
    assert.equal(switchedReader.id, switchedEvent);
    assert.equal(switchedCase.snapshot.selection.kind, "event");
    assert.equal(switchedCase.snapshot.selection.id, switchedReader.id);
    assert.equal(switchedCase.snapshot.trace_object.runId, IDS.bypass);
  });
  await closeDrawer();

  // R2：逐条点击五个冻结案例，正常案例不得请求配对接口
  const caseApi = await apiGet("/api/cases?dataset=CUSTOM");
  const caseRows = caseApi.items.map((item) => ({
    case_id: item.case_id,
    run_id: item.run_id,
    baseline_run_id: item.baseline_run_id,
  }));
  const caseErrorsBefore = errors.length;
  const caseNotes = [];
  for (const row of caseRows) {
    await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
    await resetDataset("CUSTOM");
    await waitOverview();
    const before = requests.length;
    const pairBefore = requests.filter((r) => r.url.includes("/api/run-comparisons")).length;
    await openCase(row.case_id);
    await sleep(900);
    const state = await chartState();
    const pairAfter = requests.filter((r) => r.url.includes("/api/run-comparisons")).length;
    caseNotes.push({
      case_id: row.case_id,
      run_id: row.run_id,
      baseline_run_id: row.baseline_run_id,
      chip: state.chip,
      flow: state.flow,
      pair: state.pair,
      pairRequests: pairAfter - pairBefore,
      newRequests: requests.length - before,
    });
  }
  check("R2：五个冻结案例逐个点击，正常案例进单运行且不请求配对", () => {
    const normal = caseNotes.find((n) => n.case_id === "custom-normal");
    assert.ok(normal, "缺少 custom-normal");
    assert.equal(normal.pair, false);
    assert.equal(normal.flow, true);
    assert.equal(normal.pairRequests, 0, JSON.stringify(normal));
    assert.ok(normal.chip.includes("运行 05e66fcb"), normal.chip);
  });
  check("R2：四条异常案例进入指定 run/baseline 的配对", () => {
    const pairs = caseNotes.filter((n) => n.case_id !== "custom-normal");
    assert.equal(pairs.length, 4);
    for (const note of pairs) {
      assert.equal(note.pair, true, `${note.case_id} 未进配对`);
      assert.equal(note.flow, false, `${note.case_id} 同时显示单运行`);
      assert.ok(note.chip.includes(note.run_id.replace(/^run-/, "").slice(0, 8)), note.chip);
      assert.ok(
        note.chip.includes((note.baseline_run_id ?? "").replace(/^run-/, "").slice(0, 8)),
        `${note.case_id} chip=${note.chip} baseline=${note.baseline_run_id}`,
      );
    }
  });
  check("R2：点击五个案例没有新增 4xx/控制台错误", () => {
    assert.equal(errors.length, caseErrorsBefore, errors.slice(caseErrorsBefore).join(" | "));
  });
  fs.writeFileSync(path.join(out, "review-cases.json"), JSON.stringify(caseNotes, null, 2));

  // 从异常运行用「与正常对照比较」验证自动解析仍可用
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();
  await openRunById(IDS.bypass);
  await clickText('[data-testid="custom-run"] .custom-card-head .btn', "与正常对照比较");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 20000 });
  await page.waitForFunction(
    (base) => document.querySelector('[data-testid="custom-pair"]')?.textContent?.includes(base.slice(0, 8)),
    { timeout: 20000 },
    IDS.bypassBase,
  );
  const compareResolved = await chartState();
  check("R2：无显式 baseline 时「与正常对照比较」仍自动解析真实正常对照", () => {
    assert.equal(compareResolved.pair, true);
    assert.ok(
      compareResolved.chip.includes(IDS.bypassBase.replace(/^run-/, "").slice(0, 8)),
      compareResolved.chip,
    );
  });

  // R3-a：隐藏流程后开另一运行（以及同一运行）
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();
  await openRunById(IDS.normal);
  await toggleChart("运行流程");
  const flowHidden = await chartState();
  await page.evaluate((id) => {
    const row = document.querySelector(`.custom-overview-row[data-run-id="${id}"]`);
    row?.querySelector(".custom-run-identity")?.click();
  }, IDS.bypass);
  await sleep(1000);
  const flowReopened = await chartState();
  await toggleChart("运行流程");
  const flowHiddenSame = await chartState();
  await page.evaluate((id) => {
    const row = document.querySelector(`.custom-overview-row[data-run-id="${id}"]`);
    row?.querySelector(".custom-run-identity")?.click();
  }, IDS.bypass);
  await sleep(1000);
  const flowReopenedSame = await chartState();
  check("R3-a：隐藏流程后点另一运行或同一运行都会重新展开", () => {
    assert.equal(flowHidden.flow, false);
    assert.equal(flowHidden.flowOn, "false");
    assert.equal(flowReopened.flow, true);
    assert.equal(flowReopened.flowOn, "true");
    assert.equal(flowHiddenSame.flow, false);
    assert.equal(flowReopenedSame.flow, true);
  });

  // R3-b：隐藏配对后开另一案例、同一案例，不得回退成单运行
  await openCase("custom-bypass-review");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 20000 });
  await toggleChart("配对");
  const pairHidden = await chartState();
  await openCase("custom-stale-published");
  await sleep(1000);
  const pairReopenedOther = await chartState();
  check("R3-b：隐藏配对后打开另一案例，配对展开且不出现单运行主体", () => {
    assert.equal(pairHidden.pair, false);
    assert.equal(pairHidden.hiddenPair, true);
    assert.equal(pairHidden.flow, false);
    assert.equal(pairReopenedOther.pair, true);
    assert.equal(pairReopenedOther.flow, false);
    assert.ok(pairReopenedOther.chip.includes("配对"), pairReopenedOther.chip);
  });
  await toggleChart("配对");
  const pairHiddenSame = await chartState();
  await page.click('.custom-case-chip[data-case-id="custom-stale-published"]');
  await sleep(1000);
  const pairReopenedSame = await chartState();
  check("R3-c：同一配对隐藏后再次点击同一案例也会重开", () => {
    assert.equal(pairHiddenSame.pair, false);
    assert.equal(pairReopenedSame.pair, true);
    assert.equal(pairReopenedSame.flow, false);
  });

  // R3-d：隐藏配对 → 返回运行 → 用「与正常对照比较」重开
  await toggleChart("配对");
  await page.waitForSelector('[data-testid="custom-hidden-pair"]', { timeout: 20000 });
  await clickText('[data-testid="custom-hidden-pair"] .btn', "返回运行");
  await page.waitForSelector('[data-testid="custom-run"]', { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 400 });
  await clickText('[data-testid="custom-run"] .custom-card-head .btn', "与正常对照比较");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 20000 });
  await sleep(600);
  const pairFromRun = await chartState();
  check("R3-d：隐藏配对后可从运行重新进入比较，配对图重新展开", () => {
    assert.equal(pairFromRun.pair, true);
    assert.equal(pairFromRun.flow, false);
    assert.equal(pairFromRun.pairOn, "true");
  });
  await shot("review-r3-pair");

  // R3-e：手动隐藏且不做打开动作时保持隐藏（紧跟配对视图，保留原前置状态）
  await toggleChart("配对");
  await sleep(1200);
  const hiddenSteady = await chartState();
  check("R3-e：手动隐藏后没有新打开动作时保持隐藏", () => {
    assert.equal(hiddenSteady.pair, false);
    assert.equal(hiddenSteady.flow, false);
    assert.equal(hiddenSteady.hiddenPair, true);
  });
  await shot("review-r3-hidden-steady");

  // R3-return-a：流程先隐藏 → 冻结配对 → 配对图「返回运行」
  const runCardVisible = async () => {
    const title = await boxOf('[data-testid="custom-run"] h2');
    const back = await boxOf('[data-testid="custom-run"] .custom-card-head .btn');
    return { title, back, visible: visibleAboveBar(title) && visibleAboveBar(back) };
  };
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();
  await openRunById(IDS.bypass);
  await toggleChart("运行流程");
  const flowHiddenBeforePair = await chartState();
  await openCase("custom-bypass-review");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 20000 });
  await sleep(600);
  await clickText('[data-testid="custom-pair"] .custom-card-head .btn', "返回运行");
  await page.waitForSelector('[data-testid="custom-run"]', { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => {});
  await sleep(600);
  const backFromPair = await chartState();
  const backFromPairBox = await runCardVisible();
  check("R3-return-a：流程隐藏后从配对「返回运行」，角色流程出现且开关为开", () => {
    assert.equal(flowHiddenBeforePair.flowOn, "false");
    assert.equal(backFromPair.flow, true);
    assert.equal(backFromPair.pair, false);
    assert.equal(backFromPair.flowOn, "true");
    assert.equal(backFromPair.hiddenPair, false);
    assert.ok(backFromPair.chip.includes("运行 06309bfc"), backFromPair.chip);
    assert.ok(backFromPairBox.visible, JSON.stringify(backFromPairBox));
  });
  await shot("review-r3-return-from-pair");

  // R3-return-b：流程隐藏 → 配对 → 再隐藏配对 → 提示卡「返回运行」
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();
  await openRunById(IDS.bypass);
  await toggleChart("运行流程");
  await openCase("custom-bypass-review");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 20000 });
  await toggleChart("配对");
  await page.waitForSelector('[data-testid="custom-hidden-pair"]', { timeout: 20000 });
  await clickText('[data-testid="custom-hidden-pair"] .btn', "返回运行");
  await page.waitForSelector('[data-testid="custom-run"]', { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => {});
  await sleep(600);
  const backFromHiddenCard = await chartState();
  check("R3-return-b：配对提示卡的「返回运行」同样展开角色流程，提示卡消失", () => {
    assert.equal(backFromHiddenCard.flow, true);
    assert.equal(backFromHiddenCard.pair, false);
    assert.equal(backFromHiddenCard.hiddenPair, false);
    assert.equal(backFromHiddenCard.flowOn, "true");
    assert.ok(backFromHiddenCard.chip.includes("运行 06309bfc"), backFromHiddenCard.chip);
  });
  await shot("review-r3-return-from-hidden-card");

  // R3-return-c：流程与概览都隐藏 → 配对 → 返回运行；流程出现，概览保持隐藏
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();
  await openRunById(IDS.bypass);
  await toggleChart("运行流程");
  await toggleChart("概览");
  await openCase("custom-bypass-review");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 20000 });
  const bothHidden = await chartState();
  await clickText('[data-testid="custom-pair"] .custom-card-head .btn', "返回运行");
  await page.waitForSelector('[data-testid="custom-run"]', { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => {});
  await sleep(600);
  const backWithOverviewHidden = await chartState();
  check("R3-return-c：概览也隐藏时返回运行只展开流程，不重开全部图表", () => {
    assert.equal(bothHidden.flowOn, "false");
    assert.equal(bothHidden.overviewOn, "false");
    assert.equal(backWithOverviewHidden.flow, true);
    assert.equal(backWithOverviewHidden.flowOn, "true");
    assert.equal(backWithOverviewHidden.overviewOn, "false");
    assert.equal(backWithOverviewHidden.overviewRows, 0);
  });

  // R3-return-d：390 下同一路径，落点与按钮可见
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();
  await openRunById(IDS.bypass);
  await toggleChart("运行流程");
  await openCase("custom-bypass-review");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 20000 });
  await clickText('[data-testid="custom-pair"] .custom-card-head .btn', "返回运行");
  await page.waitForSelector('[data-testid="custom-run"]', { timeout: 20000 });
  await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => {});
  await sleep(800);
  const narrowBack = await chartState();
  const narrowBox = await runCardVisible();
  check("R3-return-d：390 下返回运行后标题与返回集合按钮完整可见", () => {
    assert.equal(narrowBack.flow, true);
    assert.equal(narrowBack.flowOn, "true");
    assert.ok(narrowBox.visible, JSON.stringify(narrowBox));
  });
  await shot("review-r3-return-390");
  await page.setViewport({ width: 1600, height: 1000 });

  // R4：三档宽度下从页顶打开三个工具，标题/关闭在可用视口内
  for (const width of [1600, 1366, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : width === 1366 ? 768 : 1000 });
    await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
    await resetDataset("CUSTOM");
    await waitOverview();
    for (const [label, aria] of [
      ["系统总览", "系统总览"],
      ["实体关系", "实体关系"],
      ["时间窗对照", "时间窗对照"],
    ]) {
      await toTop();
      await openTool(label);
      await sleep(900);
      const head = await boxOf(`[aria-label="${aria}"] h2`);
      const closeBtn = await boxOf(`[aria-label="${aria}"] .custom-card-head .btn`);
      check(`R4 宽 ${width}：打开「${label}」后标题与关闭在视口内（不被控制栏遮挡）`, () => {
        assert.ok(head, `缺少 ${aria} 卡片`);
        assert.ok(visibleAboveBar(head), JSON.stringify(head));
        assert.ok(visibleAboveBar(closeBtn), JSON.stringify(closeBtn));
        // 短卡片在页尾时滚动到底即停：按“与视口相交且不被控制栏遮挡”判定
        assert.ok(head.top < head.viewport - 80, `标题太靠下 top=${head.top}`);
      });
      await shot(`review-r4-${label}-${width}`);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll(".custom-card-head .btn")].find((b) => b.textContent?.trim() === "关闭");
        btn?.click();
      });
      await sleep(400);
    }
  }
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();

  // R4：恢复运行/配对/工具快照后定位
  await openRunById(IDS.bypass);
  await toTop();
  const runCase = await saveCase(`F3 R4 运行定位 ${Date.now()}`);
  await closeDrawer();
  await page.evaluate(() => document.querySelector('[data-testid="custom-run"] .custom-card-head .btn')?.click());
  await sleep(600);
  await toTop();
  await restoreFromBasket(runCase.case_id);
  await sleep(1200);
  const restoredRunBox = await boxOf('[data-testid="custom-run"]');
  check("R4：恢复运行调查后角色流程位于视口内", () => {
    assert.ok(visibleAboveBar(restoredRunBox), JSON.stringify(restoredRunBox));
    assert.ok(restoredRunBox.top < restoredRunBox.viewport - 80, `top=${restoredRunBox.top}`);
  });
  await shot("review-r4-restore-run");

  // 重复恢复同一案例仍定位
  await toTop();
  await restoreFromBasket(runCase.case_id);
  await sleep(1200);
  const restoredAgain = await boxOf('[data-testid="custom-run"]');
  check("R4：同一案例再次恢复仍重新定位", () => {
    assert.ok(visibleAboveBar(restoredAgain), JSON.stringify(restoredAgain));
    assert.ok(restoredAgain.top < restoredAgain.viewport - 80, `top=${restoredAgain.top}`);
  });

  // 工具快照（task=overview/mode=time）恢复后定位到系统总览
  await toTop();
  await openTool("系统总览");
  await sleep(900);
  const toolCase = await saveCase(`F3 R4 工具定位 ${Date.now()}`);
  await closeDrawer();
  await page.evaluate(() => document.querySelector('[aria-label="系统总览"] .custom-card-head .btn')?.click());
  await sleep(600);
  await toTop();
  await restoreFromBasket(toolCase.case_id);
  await sleep(1400);
  const restoredToolBox = await boxOf('[aria-label="系统总览"] h2');
  check("R4：恢复工具快照后系统总览卡片在视口内", () => {
    assert.ok(restoredToolBox, "恢复后没有系统总览卡片");
    assert.ok(visibleAboveBar(restoredToolBox), JSON.stringify(restoredToolBox));
  });
  await shot("review-r4-restore-tool");

  // ================= 14. unknown / 截断夹具（明确标注为请求拦截，不是真实数据） =================
  const realRuns = await (await fetch(`${base}/api/runs?dataset=CUSTOM&include_stages=true&limit=200`)).json();
  const fixtureRuns = JSON.parse(JSON.stringify(realRuns));
  fixtureRuns.meta.truncated = true;
  fixtureRuns.meta.matched_runs_total = 140;
  fixtureRuns.items[0].stage_summary = fixtureRuns.items[0].stage_summary.map((stage, index) =>
    index === 0
      ? { key: stage.key, state: "unknown", count: null, start_offset_us: null, duration_us: null, sample_event_ids: [] }
      : stage,
  );
  let serveFixture = true;
  await page.setRequestInterception(true);
  const fixtureHandler = async (req) => {
    if (serveFixture && req.url().includes("/api/runs?") && req.url().includes("include_stages=true")) {
      req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(fixtureRuns) }).catch(() => {});
      return;
    }
    req.continue().catch(() => {});
  };
  page.on("request", fixtureHandler);
  const fixtureRunId = fixtureRuns.items[0].run_id;
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();
  const unknownCell = await page.$eval(`.custom-overview-row[data-run-id="${fixtureRunId}"] .custom-stage-cell[data-stage-key="start"]`, (n) => ({
    state: n.dataset.stageState,
    text: n.textContent?.trim() ?? "",
    label: n.getAttribute("aria-label") ?? "",
  }));
  const truncatedText = await page.$eval('[data-testid="custom-overview"] .custom-card-head p', (n) => n.textContent?.replace(/\s+/g, " ").trim() ?? "");
  check("夹具（请求拦截）：unknown 格用纹理问号，不混同 0 或无记录", () => {
    assert.equal(unknownCell.state, "unknown");
    assert.equal(unknownCell.text, "?");
    assert.ok(unknownCell.label.includes("资料不足"), unknownCell.label);
  });
  check("夹具：接口截断时页面注明上限与总数", () => {
    assert.ok(truncatedText.includes("截断"), truncatedText);
    assert.ok(truncatedText.includes("140"), truncatedText);
  });
  await page.click(`.custom-overview-row[data-run-id="${fixtureRunId}"] .custom-stage-cell[data-stage-key="start"]`);
  await sleep(250);
  const unknownSample = await page.evaluate(() => ({
    text: document.querySelector(".custom-stage-samples")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    events: document.querySelectorAll(".custom-stage-samples [data-event-id]").length,
  }));
  check("夹具：unknown 格不生成虚假事件", () => {
    assert.ok(unknownSample.text.includes("资料不足"), unknownSample.text);
    assert.equal(unknownSample.events, 0);
  });
  serveFixture = false;
  page.off("request", fixtureHandler);
  await page.setRequestInterception(false);
  await shot("fixture-unknown-truncated");

  await page.goto(`${base}/?theme=dark`, { waitUntil: "networkidle0" });
  await resetDataset("CUSTOM");
  await waitOverview();
  await shot("default-1600-dark");
  await openCase("custom-bypass-review");
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 30000 });
  await closeDrawer();
  await page.evaluate(() => document.querySelector('[data-testid="custom-pair"]')?.scrollIntoView({ block: "start" }));
  await shot("pair-1600-dark");
} catch (err) {
  results.push({ label: "未捕获异常", ok: false, detail: String(err?.stack ?? err) });
  console.error(err);
  try { await shot("crash"); } catch { /* ignore */ }
}

// 只清理本轮创建的案例
for (const id of created) {
  try {
    await fetch(`${base}/api/cases/${id}`, { method: "DELETE" });
  } catch { /* ignore */ }
}

const ignored = intentional.length
  ? (text) => (text.includes("/api/notes") && text.includes("500")) || text.includes("status of 500")
  : () => false;
const unexpected = errors.filter((text) => !ignored(text));

fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ results, errors, unexpected, created, intentional }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log("失败项：\n" + failed.map((r) => `- ${r.label}: ${r.detail}`).join("\n"));
console.log(unexpected.length ? "控制台/HTTP 错误：\n" + unexpected.join("\n") : "无意外控制台/HTTP 错误");
await browser.close();
process.exit(failed.length || unexpected.length ? 1 : 0);
