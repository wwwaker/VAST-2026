import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:8010";
const out = process.env.UI_CHECK_OUT ? path.resolve(process.env.UI_CHECK_OUT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../build/ui-refactor/S0");
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true,
  args: ["--no-sandbox", "--disable-gpu"], defaultViewport: { width: 1600, height: 1000 } });
const page = await browser.newPage();
const errors = [], created = [], checks = [], requests = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
page.on("response", (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
page.on("request", (r) => requests.push(r.url()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, fn) => { fn(); checks.push(label); console.log(`PASS ${label}`); };
async function task(label) {
  // MC1 已退出四任务导航；其余数据集仍按任务/模式进入
  if (!(await page.$(".task-nav"))) return;
  await clickText(".task-tab", label);
}
async function mode(label) {
  // MC1 参考界面把模式收进页面内的图表显隐，不再有二级 mode-tab；此处按新入口容忍缺失
  if (!(await page.$(".mode-tab"))) return;
  await clickText(".mode-tab", label);
}
async function ensureEventStream() {
  const page_ = await page.evaluate(() => ({
    mc1: !!document.querySelector(".mc1-page"),
    mc2: !!document.querySelector('[data-testid="mc2-page"]'),
  }));
  if (page_.mc1 || page_.mc2) {
    // MC1/MC2 的通用事件查询收在页面「工具」菜单里
    const prefix = page_.mc1 ? ".mc1-tools" : ".mc2-tools";
    const card = page_.mc1 ? ".mc1-card" : '[aria-label="事件查询"]';
    if (await page.$(`${card} .stream-row`)) return;
    await page.evaluate((sel) => {
      const tools = document.querySelector(sel);
      if (tools instanceof HTMLDetailsElement) tools.open = true;
    }, prefix);
    await page.evaluate((sel) => {
      const btn = [...document.querySelectorAll(`${sel}-menu button`)].find(
        (n) => n.textContent?.trim() === "事件查询",
      );
      btn?.click();
    }, prefix);
    await page.waitForSelector(`${card} .stream-row`);
    return;
  }
  if (!(await page.$(".event-dock"))) {
    await clickText(".topbar-docks button", "事件流");
  }
  await page.waitForSelector(".stream-row");
}
async function openTimeline(dataset) {
  if (dataset) {
    await page.select(".dataset-field select", dataset);
    await sleep(500);
  }
  await task("概览");
  if (dataset === "MC2") await mode("时间");
  await ensureEventStream();
}
async function clickText(selector, text) {
  const found = await page.evaluate((selector, text) => {
    const node = [...document.querySelectorAll(selector)].find((n) => n.textContent?.trim().includes(text));
    node?.click(); return !!node;
  }, selector, text);
  assert.ok(found, `missing ${selector}: ${text}`);
}
async function drawerBasket() {
  if (!(await page.$(".drawer"))) await clickText(".topbar-docks button", "证据");
  await clickText(".tabs .tab", "证据篮");
  await page.waitForSelector(".basket");
}
async function save(title) {
  await drawerBasket();
  if (await page.$(".basket > .callout .mono")) await clickText(".basket .btn", "取消关联");
  await page.waitForSelector('.basket input[placeholder="案例标题"]');
  await page.type('.basket input[placeholder="案例标题"]', title);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/cases") && r.request().method() === "POST");
  await clickText(".basket .btn", "保存当前案例");
  const r = await response;
  const item = await r.json();
  assert.equal(r.status(), 201, JSON.stringify(item));
  created.push(item.case_id);
  fs.writeFileSync(path.join(out, "browser-created-ids.json"), JSON.stringify(created, null, 2));
  await page.waitForFunction((id) => document.querySelector(".basket .callout .mono")?.textContent === id, {}, item.case_id);
  return item;
}
async function restoreFromBasket(id) {
  await drawerBasket();
  await page.waitForFunction((id) => [...document.querySelectorAll(".saved-investigations .drawer-actions")].some((n) => n.querySelector("a")?.href.includes(id)), {}, id);
  await page.evaluate((id) => [...document.querySelectorAll(".saved-investigations .drawer-actions")].find((n) => n.querySelector("a")?.href.includes(id))?.querySelector("button")?.click(), id);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((n) => n.textContent?.includes("已恢复调查")));
}
try {
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  // F2：MC2 默认即单页，不再有四任务导航
  await page.waitForSelector('[data-testid="mc2-page"]');
  await openTimeline("MC2");
  const presets = await (await fetch(`${base}/api/cases?dataset=CUSTOM`)).json();
  const target = presets.items.find((c) => c.baseline_run_id);
  assert.ok(target);

  await page.select(".dataset-field select", "CUSTOM");
  await task("概览");
  await page.waitForSelector(".case-chip");
  await page.evaluate((title) => [...document.querySelectorAll(".case-chip")].find((n) => n.textContent.includes(title))?.click(), target.title);
  await page.waitForSelector(".run-compare");
  await page.waitForNetworkIdle({ idleTime: 500 });
  await ensureEventStream();
  await page.click(".stream-row");
  if (!(await page.$(".drawer"))) await clickText(".topbar-docks button", "证据");
  await page.waitForSelector(".basket-add");
  await clickText(".basket-add button", "支持");
  const pair = await save(`S0 CUSTOM pair ${Date.now()}`);
  check("CUSTOM actual save stores shared runPair, run and selected event", () => {
    assert.equal(pair.snapshot.ui_state_version, 1);
    assert.equal(pair.snapshot.task, "compare"); assert.equal(pair.snapshot.mode, "runPair");
    assert.equal(pair.snapshot.trace_object.runId, target.run_id);
    assert.equal(pair.snapshot.comparison.baselineRunId, target.baseline_run_id);
    assert.equal(pair.snapshot.selection.kind, "event"); assert.ok(!("runId" in pair.snapshot.base_filters));
  });
  await task("概览");
  await mode("运行");
  await ensureEventStream();
  await page.waitForSelector(".run-row-button");
  await page.waitForFunction((id) => [...document.querySelectorAll(".case-picker .trace-item")].some((n) => n.textContent.includes(id)), {}, pair.case_id);
  await page.evaluate((id) => [...document.querySelectorAll(".case-picker .trace-item")].find((n) => n.textContent.includes(id))?.querySelector(".restore-investigation")?.click(), pair.case_id);
  await page.waitForSelector(".run-compare");
  check("CasePicker restore changes actual CUSTOM pair consumer", () => {});
  await page.screenshot({ path: path.join(out, "custom-pair.png") });
  const pairAgain = await save(`S0 CUSTOM restored ${Date.now()}`);
  check("CUSTOM restored snapshot retains pair, selection and replay; playing absent", () => {
    assert.deepEqual(pairAgain.snapshot.comparison, pair.snapshot.comparison);
    assert.deepEqual(pairAgain.snapshot.selection, pair.snapshot.selection);
    assert.deepEqual(pairAgain.snapshot.trace_object, pair.snapshot.trace_object);
    assert.deepEqual(pairAgain.snapshot.pinned_evidence, pair.snapshot.pinned_evidence);
    assert.ok(!("playing" in pairAgain.snapshot.replay));
  });
  await clickText(".run-compare .btn", "返回运行");
  await page.waitForSelector(".run-detail");
  await clickText(".custom-workspace .canvas-subbar button", "查看完整运行");
  await page.waitForNetworkIdle({ idleTime: 400 });
  await page.waitForSelector(".run-detail-tools button");
  const scope = await page.$eval(".status-summary", (n) => n.textContent);
  check("clear filters keeps CUSTOM run scope visible", () => assert.ok(scope.includes("运行")));
  await clickText(".run-detail-tools button", "返回运行列表");
  await page.waitForSelector(".run-row-button");
  await page.waitForFunction(() => !document.querySelector(".status-summary")?.textContent.includes("运行 "));
  check("return overview removes derived runId", () => {});

  await openTimeline("MC2");
  await page.waitForSelector(".trace-roots button");
  await page.click(".trace-roots button");
  await page.waitForSelector(".trace-head .mono");
  const rootId = await page.$eval(".trace-head .mono", (n) => n.textContent);
  // F2：干预论证从页面“工具”菜单打开（旧来源链子模式标签已移除）
  await page.evaluate(() => {
    const tools = document.querySelector(".mc2-tools");
    if (tools instanceof HTMLDetailsElement) tools.open = true;
  });
  await clickText(".mc2-tools-menu button", "干预论证");
  await page.waitForSelector(".intervention-view");
  await ensureEventStream();
  await clickText(".intervention-view button", "选为干预位置");
  await page.click(".stream-row");
  if (!(await page.$(".drawer"))) await clickText(".topbar-docks button", "证据");
  const mc2 = await save(`S0 MC2 intervention ${Date.now()}`);
  check("MC2 mode/root/intervention are saved from actual consumers; selection preserves root", () => {
    assert.equal(mc2.snapshot.mode, "intervention"); assert.equal(mc2.snapshot.trace_object.rootEventId, rootId);
    assert.equal(mc2.snapshot.intervention_position, "relay_queue");
  });
  await task("概览");
  await mode("时间");
  await ensureEventStream();
  await restoreFromBasket(mc2.case_id);
  await page.waitForSelector(".intervention-view");
  await page.waitForFunction(() => [...document.querySelectorAll(".intervention-view button")].some((b) => b.textContent.includes("取消选择该干预位置") && b.getAttribute("aria-pressed") === "true"));
  check("MC2 restore updates submode and one intervention selection", () => {});
  await page.screenshot({ path: path.join(out, "mc2-intervention.png") });

  await page.select(".dataset-field select", "MC1");
  await task("概览");
  await page.waitForSelector(".mc1-page");
  await ensureEventStream();
  await page.click(".stream-row");
  if (!(await page.$(".drawer"))) await clickText(".topbar-docks button", "证据");
  const mc1 = await save(`S0 MC1 ${Date.now()}`);
  check("dataset switch clears old root, pair, basket and intervention", () => {
    assert.equal(mc1.snapshot.trace_object.dataset, "MC1"); assert.equal(mc1.snapshot.comparison, null);
    assert.equal(mc1.snapshot.intervention_position, null); assert.equal(mc1.snapshot.pinned_evidence.length, 0);
  });
  await task("追踪");
  await mode("局部关系");
  await restoreFromBasket(mc1.case_id);
  await page.waitForSelector(".mc1-page");
  check("MC1 save/read/restore returns current activity container", () => {});
  await page.screenshot({ path: path.join(out, "mc1-activity.png") });

  // 旧 task/mode 恢复映射：对照 → 页面内对照工具；结论/笔记 → 证据面板笔记
  const postMc1Case = async (snapshot, title) => {
    const res = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_id: "MC1", title, snapshot }),
    });
    assert.equal(res.status, 201);
    const item = await res.json();
    created.push(item.case_id);
    return item;
  };
  const withTaskMode = (task, mode, patch = {}) => {
    const snapshot = structuredClone(mc1.snapshot);
    snapshot.task = task;
    snapshot.mode = mode;
    snapshot.task_modes[task] = mode;
    Object.assign(snapshot, patch);
    return snapshot;
  };
  const compareCase = await postMc1Case(
    withTaskMode("compare", "window", {
      comparison: { kind: "window", dimension: "event_type", currentUs: null, baselineMode: "auto", baselineUs: null },
      return_point: null,
    }),
    `MC1 compare ${Date.now()}`,
  );
  await page.reload({ waitUntil: "networkidle0" });
  await page.select(".dataset-field select", "MC1");
  await page.waitForSelector(".mc1-page");
  await restoreFromBasket(compareCase.case_id);
  await page.waitForSelector('.mc1-card[aria-label="时间窗对照"]', { timeout: 15000 });
  check("MC1 对照快照恢复到页面内对照工具", () => {});
  await page.screenshot({ path: path.join(out, "mc1-restore-compare.png") });
  await clickText('.mc1-card[aria-label="时间窗对照"] .btn-quiet', "返回 MC1");
  await page.waitForSelector(".mc1-heat-cell");
  const compareClosed = await page.evaluate(
    () => !document.querySelector('.mc1-card[aria-label="时间窗对照"]'),
  );
  check("返回 MC1 后退出对照工具", () => assert.equal(compareClosed, true));

  const notesCase = await postMc1Case(
    withTaskMode("findings", "notes", { comparison: null, return_point: null }),
    `MC1 notes ${Date.now()}`,
  );
  await page.reload({ waitUntil: "networkidle0" });
  await page.select(".dataset-field select", "MC1");
  await page.waitForSelector(".mc1-page");
  await restoreFromBasket(notesCase.case_id);
  await page.waitForSelector(".drawer .notes", { timeout: 15000 });
  check("MC1 结论/笔记快照恢复到证据面板笔记页", () => {});
  await page.screenshot({ path: path.join(out, "mc1-restore-notes.png") });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".drawer .drawer-head .btn")].find(
      (n) => n.textContent?.trim() === "关闭",
    );
    btn?.click();
  });
  await sleep(400);

  // C2：同一笔记案例重复恢复也必须重新打开笔记面板（只改 task/mode 不足）
  await restoreFromBasket(notesCase.case_id);
  await page.waitForSelector(".drawer .notes", { timeout: 15000 });
  const repeatedNotes = await page.evaluate(() => ({
    drawer: !!document.querySelector(".drawer"),
    notes: !!document.querySelector(".drawer .notes"),
    activeTab: document.querySelector(".tabs .tab-active")?.textContent?.trim() ?? null,
  }));
  check("同一笔记案例重复恢复仍打开笔记", () => assert.equal(repeatedNotes.notes, true));
  await page.screenshot({ path: path.join(out, "mc1-restore-notes-repeated.png") });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".drawer .drawer-head .btn")].find(
      (n) => n.textContent?.trim() === "关闭",
    );
    btn?.click();
  });
  await sleep(400);

  // C2：有效事件恢复到唯一阅读面板；隐藏的事件轨应自动展开
  const decisionTarget = "MC1:event:20460605_21_026";
  const decisionCase = await postMc1Case(
    withTaskMode("trace", "decision", {
      selection: { kind: "event", id: decisionTarget, timeUs: null },
      comparison: null,
      return_point: null,
    }),
    `MC1 decision ${Date.now()}`,
  );
  await page.reload({ waitUntil: "networkidle0" });
  await page.select(".dataset-field select", "MC1");
  await page.waitForSelector(".mc1-page");
  await page.waitForSelector('.mc1-card[aria-label="事件轨"]', { timeout: 15000 });
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll(".mc1-toggle")].find((n) => n.textContent?.trim() === "事件轨");
    if (toggle?.getAttribute("aria-pressed") === "true") toggle.click();
  });
  await sleep(500);
  const flowHidden = await page.evaluate(() => !document.querySelector('.mc1-card[aria-label="事件轨"]'));
  assert.equal(flowHidden, true, "事件轨应已隐藏");
  await restoreFromBasket(decisionCase.case_id);
  await page.waitForSelector('.mc1-card[aria-label="事件轨"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="mc1-event-detail"]', { timeout: 15000 });
  await sleep(400);
  const decisionRestore = await page.evaluate(() => ({
    readers: document.querySelectorAll(".mc1-reader").length,
    text: document.querySelector('[data-testid="mc1-event-detail"]')?.textContent ?? "",
    flow: !!document.querySelector('.mc1-card[aria-label="事件轨"]'),
    drawer: !!document.querySelector(".drawer"),
  }));
  check("MC1 有效事件恢复到阅读面板", () =>
    assert.ok(decisionRestore.readers === 1 && decisionRestore.text.includes("MC1:event:20460605_21_026"), JSON.stringify(decisionRestore)),
  );
  check("恢复时自动展开已隐藏的事件轨", () => assert.equal(decisionRestore.flow, true));
  await page.screenshot({ path: path.join(out, "mc1-restore-selection.png") });

  const decisionSaved = await save(`MC1 decision resaved ${Date.now()}`);
  check("恢复的选中事件再次保存仍为同一事件", () => {
    assert.equal(decisionSaved.snapshot.selection.kind, "event");
    assert.equal(decisionSaved.snapshot.selection.id, decisionTarget);
    assert.equal(decisionSaved.snapshot.mode, "decision");
    assert.equal(decisionSaved.snapshot.task, "trace");
  });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".drawer .drawer-head .btn")].find(
      (n) => n.textContent?.trim() === "关闭",
    );
    btn?.click();
  });
  await sleep(300);

  // Use API-created missing reference fixture; still restores through the actual UI entry.
  const missingSnapshot = structuredClone(mc1.snapshot);
  missingSnapshot.selection = { kind: "event", id: "MC1:event:missing-s0-ui", timeUs: null };
  const response = await fetch(`${base}/api/cases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataset_id: "MC1", title: "S0 missing ref", snapshot: missingSnapshot }) });
  assert.equal(response.status, 201); const missingCase = await response.json(); created.push(missingCase.case_id);
  // Reload the list, not the investigation, by opening the basket again.
  await drawerBasket();
  await page.reload({ waitUntil: "networkidle0" });
  await page.select(".dataset-field select", "MC1"); await page.waitForSelector(".mc1-page");
  await restoreFromBasket(missingCase.case_id);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((n) => n.textContent?.includes("缺失引用 1 条")));
  check("missing reference remains explicit and is not replaced by first event", () => {});
  await page.screenshot({ path: path.join(out, "missing-reference.png") });
  for (const [dataset, template, savedTask, alias, canonical, selector] of [
    ["MC1", mc1.snapshot, "overview", "timeline", "time", ".mc1-page"],
    ["CUSTOM", pair.snapshot, "overview", "local", "relations", ".graph-workspace"],
    ["MC1", mc1.snapshot, "trace", "messages", "decision", ".mc1-page"],
    // F2：来源链是单页默认区域，不再有独立 .trace-view；用来源链卡片作为落点
    ["MC2", mc2.snapshot, "trace", "file", "source", '[data-testid="mc2-trace-card"]'],
  ]) {
    const snapshot = structuredClone(template);
    snapshot.task = savedTask; snapshot.mode = alias; snapshot.task_modes[savedTask] = alias;
    const { contract_version, ui_state_version, return_point, ...point } = structuredClone(snapshot);
    snapshot.return_point = point;
    const posted = await fetch(`${base}/api/cases`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_id: dataset, title: `compat ${alias} ${Date.now()}`, snapshot }) });
    assert.equal(posted.status, 201); const item = await posted.json(); created.push(item.case_id);
    // Reload ensures the real saved-list fetch sees this API-created fixture.
    await page.reload({ waitUntil: "networkidle0" });
    await page.select(".dataset-field select", dataset);
    await task(savedTask === "overview" ? "概览" : savedTask === "trace" ? "追踪" : "对照");
    if (canonical === "time") await mode("时间");
    if (canonical === "relations" || canonical === "decision") await mode(canonical === "relations" ? "关系" : "决策");
    if (canonical === "source") await mode("来源");
    await restoreFromBasket(item.case_id);
    await page.waitForSelector(selector);
    const saved = await save(`canonical ${canonical} ${Date.now()}`);
    check(`${dataset} persisted ${alias} restores in UI and re-saves as ${canonical}`, () => {
      assert.equal(saved.snapshot.mode, canonical); assert.equal(saved.snapshot.task_modes[savedTask], canonical);
      assert.equal(saved.snapshot.return_point.mode, canonical);
      assert.deepEqual(saved.snapshot.trace_object, snapshot.trace_object);
      assert.deepEqual(saved.snapshot.selection, snapshot.selection);
    });
    const original = await (await fetch(`${base}/api/cases/${item.case_id}/export?format=json`)).json();
    assert.deepEqual(original.snapshot, snapshot);
  }
  const started = performance.now();
  const stages = await (await fetch(`${base}/api/runs?include_stages=true`)).json();
  check("stage endpoint returns all runs and strict pagination", () => { assert.equal(stages.items.length, 32); assert.equal(stages.meta.truncated, false); });
  console.log(`stage request ${Math.round(performance.now() - started)} ms`);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, "browser-result.json"), JSON.stringify({ base, viewport: { width: 1600, height: 1000 }, theme: "light", checks, errors, requests: requests.length, created }, null, 2));
  console.log(`${checks.length} S0 browser behavior checks passed; console/network errors: 0`);
} finally {
  for (const id of created) {
    const r = await fetch(`${base}/api/cases/${id}`, { method: "DELETE" });
    console.log(`cleanup ${id}: ${r.status}`);
  }
  await browser.close();
}
