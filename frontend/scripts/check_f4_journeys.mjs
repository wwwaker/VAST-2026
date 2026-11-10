/**
 * F4 · 三条端到端调查路径（浏览器）。
 *
 * 只补跨步骤完整路径与本阶段缺口，不复制既有 101/95/58 项用例：
 *  - J-MC1：沟通变化 → 原始记录 → 可恢复调查
 *  - J-MC2：目标帖 → 文件身份 → 历史与干预 → 导出
 *  - J-CUSTOM：审批绕过 → 对照 → 反向核对 → 返回和恢复
 *  - 跨集循环、布局偏好归属、抽屉关闭回焦（原 check_s1 的有效业务断言迁移点）
 *
 * 依赖真实后端与主库；不做 mock、不准备 --fresh 数据。
 * 用法：node frontend/scripts/check_f4_journeys.mjs [baseURL]
 * 输出：UI_CHECK_OUT 或 build/reference-ui/F4/journeys
 * 清理：finally 只删除本轮自建案例/结论/笔记，保留预置案例与用户内容。
 */
import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:8040";
const out = process.env.UI_CHECK_OUT
  ? path.resolve(process.env.UI_CHECK_OUT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../build/reference-ui/F4/journeys");
fs.mkdirSync(out, { recursive: true });

/** 冻结案例与真实事件基线（来自 backend/app/cases/custom.json 与当前主库）。 */
const KNOWN = {
  mc1Confirm: "MC1:event:20460605_21_026",
  mc1Lift: "MC1:event:20460605_22_001",
  mc2Target: "MC2:event:373902",
  customNormalCase: "custom-normal",
  customBypassCase: "custom-bypass-review",
  bypassRun: "run-06309bfc120a40e480100352e1eb52ff",
  bypassBaseline: "run-93d3d84d65264529b23da42b8fe8cba7",
  bypassResult: "8a655819-3b06-4146-9cc3-d5bca0095e4d",
};

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
  defaultViewport: { width: 1600, height: 1000 },
});

const results = [];
const createdCases = [];
const createdFindings = [];
const createdNotes = [];
const unexpected = [];
const intentional = [];
/** 本轮有意注入的失败标识；与「意外 HTTP/控制台错误」分开计数。 */
const intentionalFragments = [];
const requests = [];
let page = null;
let currentJourney = "";

const persist = () => {
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({
    base, finishedAt: new Date().toISOString(), currentJourney,
    results, createdCases, createdFindings, createdNotes,
    unexpected, intentional,
  }, null, 2));
};
const record = (id, name, ok, detail, evidence) => {
  results.push({ id: id.split(" ")[0], name, journey: currentJourney, ok, detail: detail ?? null, evidence: evidence ?? null });
  persist();
  const line = `${ok ? "PASS" : "FAIL"} ${id}${ok || !detail ? "" : ` :: ${detail}`}`;
  ok ? console.log(line) : console.error(line);
};
/** id 兼作断言名：`J-MC1-05 ...`，避免两处文案漂移。 */
const check = (id, fn, evidence) => {
  try { fn(); record(id, id, true, null, evidence); }
  catch (err) { record(id, id, false, String(err?.message ?? err), evidence); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  try {
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log(`  截图 ${name}.png`);
  } catch (err) { console.error(`  截图失败 ${name}: ${err.message}`); }
};
const apiGet = async (p) => {
  const res = await fetch(`${base}${p}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
};
const knownMutations = /\/api\/(cases|findings)$|\/api\/notes\/\d+$/;

async function newContext(label) {
  const context = await browser.createBrowserContext();
  const p = await context.newPage();
  p.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/status of 5\d\d|Failed to load resource/.test(text)) return; // 由 response 监听按状态码分类
    unexpected.push(`${label} console: ${text}`);
  });
  p.on("pageerror", (e) => unexpected.push(`${label} pageerror: ${String(e)}`));
  p.on("response", (r) => {
    const url = new URL(r.url());
    requests.push({ label, path: url.pathname + url.search, status: r.status(), method: r.request().method(), at: Date.now(), journey: currentJourney });
    if (r.status() < 400) return;
    const entry = `HTTP ${r.status()} ${url.pathname}${url.search} (${r.request().method()})`;
    const expected = intentionalFragments.find((frag) => entry.includes(frag));
    if (expected) intentional.push({ at: Date.now(), entry, matched: expected });
    else unexpected.push(`${label} ${entry}`);
  });
  await p.setViewport({ width: 1600, height: 1000 });
  page = p;
  return p;
}

const waitIdle = async (ms = 300) => {
  await page.waitForNetworkIdle({ idleTime: ms, timeout: 30000 }).catch(() => {});
};
const clickText = async (selector, text, index = 0) => {
  const found = await page.evaluate((sel, label, at) => {
    const nodes = [...document.querySelectorAll(sel)].filter((n) => (n.textContent ?? "").replace(/\s+/g, " ").includes(label));
    nodes[at]?.click();
    return nodes.length;
  }, selector, text, index);
  assert.ok(found, `找不到 ${selector} 中的「${text}」`);
  await sleep(250);
  return found;
};
const selectDataset = async (id) => {
  await page.select(".dataset-field select", id);
  await sleep(800);
  await waitIdle(400);
};
const openDrawer = async () => {
  if (!(await page.$(".drawer"))) await clickText(".topbar-docks button", "证据");
  await page.waitForSelector(".drawer", { timeout: 15000 });
  await sleep(200);
};
const drawerTab = async (label) => {
  await openDrawer();
  await clickText(".tabs .tab", label);
  await sleep(300);
};
const closeDrawer = async () => {
  if (!(await page.$(".drawer"))) return;
  await page.evaluate(() => [...document.querySelectorAll(".drawer-head .btn")].at(-1)?.click());
  await sleep(300);
};
/** 证据篮里保存新案例；返回 POST 响应（含 case_id 与 data_version）。 */
const saveCase = async (title) => {
  await drawerTab("证据篮");
  await page.waitForSelector(".basket");
  if (await page.$(".basket > .callout .mono")) await clickText(".basket .btn", "取消关联");
  await page.waitForSelector('.basket input[placeholder="案例标题"]');
  await page.click('.basket input[placeholder="案例标题"]');
  await page.type('.basket input[placeholder="案例标题"]', title);
  const waiter = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/cases" && r.request().method() === "POST", { timeout: 30000 });
  await clickText(".basket .btn", "保存当前案例");
  const res = await waiter;
  const item = await res.json();
  assert.ok(res.status() < 300, `保存案例失败 ${res.status()} ${JSON.stringify(item)}`);
  createdCases.push(item.case_id);
  persist();
  await page.waitForFunction((id) => document.querySelector(".basket .callout .mono")?.textContent === id, { timeout: 20000 }, item.case_id);
  return { ...item, status: res.status() };
};
const saveFinding = async (claim, explanation, limitations) => {
  await page.waitForSelector(".finding-form input.text-input");
  await page.type(".finding-form input.text-input", claim);
  await page.type(".finding-form textarea", explanation);
  if (limitations) {
    const areas = await page.$$(".finding-form textarea");
    await areas[1].type(limitations);
  }
  const waiter = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/findings" && r.request().method() === "POST", { timeout: 30000 });
  await clickText(".finding-form .btn", "保存结论");
  const res = await waiter;
  const item = await res.json();
  assert.ok(res.status() < 300, `保存结论失败 ${res.status()} ${JSON.stringify(item)}`);
  createdFindings.push({ case_id: item.case_id, finding_id: item.finding_id });
  persist();
  return item;
};
const restoreFromBasket = async (caseId) => {
  await drawerTab("证据篮");
  await page.waitForFunction(
    (id) => [...document.querySelectorAll(".saved-investigations .drawer-actions")].some((n) => n.querySelector("a")?.href.includes(id)),
    { timeout: 25000 },
    caseId,
  );
  await page.evaluate((id) => {
    const row = [...document.querySelectorAll(".saved-investigations .drawer-actions")].find((n) => n.querySelector("a")?.href.includes(id));
    row?.querySelector(".restore-investigation")?.click();
  }, caseId);
  await page.waitForFunction(() => document.querySelector(".callout[role='status']")?.textContent?.includes("已恢复调查"), { timeout: 25000 });
  await waitIdle(400);
};
const exportCase = async (caseId, format) => {
  const res = await fetch(`${base}/api/cases/${encodeURIComponent(caseId)}/export?format=${format}`);
  const text = await res.text();
  assert.equal(res.status, 200, `导出 ${format} 失败 ${res.status}`);
  return { status: res.status, text };
};
const playing = () => page.$eval(".timebrush .btn-icon", (n) => n.getAttribute("aria-label") ?? "");
/** MC2 链根真值：优先读“当前链根”说明，其次读 seg 的 active 按钮（按钮文案是文件名）。 */
const chainRootInfo = () => page.evaluate(() => {
  const active = document.querySelector(".trace-roots .seg-item.seg-active");
  const note = document.querySelector(".trace-roots .muted.small")?.textContent?.trim() ?? "";
  const match = note.match(/MC2:event:[0-9_:A-Za-z-]+/);
  return { active: active?.textContent?.trim() ?? "", note, eventId: match ? match[0] : "" };
});

try {
  // ================================================================ J-MC1
  currentJourney = "J-MC1";
  await newContext("mc1");
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle2" });
  await selectDataset("MC1");
  await page.waitForSelector('[data-testid="mc1-page"]', { timeout: 30000 });
  await page.waitForSelector(".mc1-heat-cell", { timeout: 30000 });
  await waitIdle(400);

  const mc1Shell = await page.evaluate(() => ({
    taskTabs: document.querySelectorAll(".task-tab, .mode-tab, .view-tab").length,
    eventDock: !!document.querySelector(".event-dock, .statusbar, .status-summary"),
    heat: !!document.querySelector('[aria-label="活动热力图"]'),
    track: !!document.querySelector('[aria-label="事件轨"]'),
    net: !!document.querySelector('[aria-label="回复网络"]'),
    readers: document.querySelectorAll(".mc1-reader").length,
    cells: document.querySelectorAll(".mc1-heat-cell").length,
  }));
  await shot("j-mc1-01-default");
  check("J-MC1-01 进入 MC1 后是热力图/事件轨/回复网络单页，无旧导航、事件坞与常驻正文", () => {
    assert.equal(mc1Shell.taskTabs, 0, JSON.stringify(mc1Shell));
    assert.equal(mc1Shell.eventDock, false, JSON.stringify(mc1Shell));
    assert.equal(mc1Shell.heat && mc1Shell.track && mc1Shell.net, true, JSON.stringify(mc1Shell));
    assert.equal(mc1Shell.readers, 0, JSON.stringify(mc1Shell));
  }, { cells: mc1Shell.cells });

  // 锚点身份：外部报道是 context，首条内部确认与解禁是 event。
  const ctx = await apiGet("/api/mc1/context?dataset=MC1");
  const ext = ctx.anchors.external_report;
  const conf = ctx.anchors.first_internal_confirmation;
  const lift = ctx.anchors.formal_lift;
  const anchorEvidence = {
    external: ext ? { context_id: ext.context_id, kind: ext.kind, time_us: ext.time_us, timestamp_raw: ext.time_raw ?? null } : null,
    confirm: conf ? { event_id: conf.event_id, time_us: conf.time_us, timestamp_raw: conf.timestamp_raw } : null,
    lift: lift ? { event_id: lift.event_id, time_us: lift.time_us, timestamp_raw: lift.timestamp_raw } : null,
    schema: ctx.meta?.schema_version ?? null,
    data_version: ctx.meta?.data_version ?? null,
  };
  check("J-MC1-02 三个锚点身份来自 /api/mc1/context：报道=context，确认/解禁=event 且时间不互换", () => {
    assert.ok(ext && conf && lift, JSON.stringify(anchorEvidence));
    assert.ok(ext.context_id && !ext.event_id, `外部报道应是 context：${JSON.stringify(ext)}`);
    assert.ok(conf.event_id?.startsWith("MC1:event:"), JSON.stringify(anchorEvidence.confirm));
    assert.ok(lift.event_id?.startsWith("MC1:event:"), JSON.stringify(anchorEvidence.lift));
    assert.ok(conf.time_us < lift.time_us, `确认应早于解禁：${conf.time_us} vs ${lift.time_us}`);
    assert.equal((conf.timestamp_raw ?? "").slice(11, 16), "17:25", String(conf.timestamp_raw));
    assert.equal((lift.timestamp_raw ?? "").slice(11, 16), "18:00", String(lift.timestamp_raw));
  }, anchorEvidence);

  // 显式定位到首条内部确认 ±30m（不改写选择，只改时间窗）。
  const confirmChip = await page.evaluateHandle(() => {
    const chip = [...document.querySelectorAll(".mc1-anchor-chip")].find((n) => n.textContent?.includes("17:25"));
    chip?.querySelector(".mc1-anchor-action")?.click();
    return !!chip;
  });
  assert.equal(await confirmChip.jsonValue(), true, "找不到首条内部确认锚点按钮");
  await waitIdle(500);
  const windowLabel = await page.$eval(".mc1-window", (n) => n.textContent?.trim() ?? "");
  check("J-MC1-03 锚点 ±30m 只改统一时间窗，窗口文案与锚点一致", () => {
    assert.ok(windowLabel.includes("17:25") || windowLabel.includes("06-05"), windowLabel);
  }, { windowLabel });

  // 取一个真实有数据的角色×时间桶，核对 API 计数与 DOM 计数（查询范围=当前统一时间窗）。
  const winStart = conf.time_us - 30 * 60 * 1_000_000;
  const winEnd = conf.time_us + 30 * 60 * 1_000_000;
  const actUrl = `/api/mc1/activity?dataset=MC1&granularity=day&start_us=${winStart}&end_us=${winEnd}`;
  const act = await apiGet(actUrl);
  const bucket = act.columns
    .filter((c) => c.start_us != null && c.end_us != null)
    .find((c) => conf.time_us >= c.start_us && conf.time_us < c.end_us) ?? act.columns[0];
  const cell = act.cells
    .filter((c) => c.bucket === bucket.key && !c.empty && c.public + c.internal > 0)
    .sort((a, b) => (b.public + b.internal + b.other) - (a.public + a.internal + a.other))[0];
  assert.ok(cell, "当前窗口没有可点击的有数据格");
  const cellKey = `${cell.agent_id}|${cell.bucket}`;
  const cellSelector = `[data-cell-key="${cellKey}"]`;
  await page.waitForSelector(cellSelector, { timeout: 20000 });
  const domCell = await page.$eval(cellSelector, (n) => ({ aria: n.getAttribute("aria-label") ?? "", pressed: n.getAttribute("aria-pressed") }));
  const cellEvidence = {
    agent: cell.agent_id, bucket: cell.bucket, bucketStart: bucket.start_us, bucketEnd: bucket.end_us,
    activityQuery: { start_us: winStart, end_us: winEnd },
    api: { public: cell.public, internal: cell.internal, other: cell.other, bucketMatched: bucket.matched_events },
    dom: domCell,
  };
  check("J-MC1-04 热力格计数与 /api/mc1/activity 一致（同一时间窗）", () => {
    assert.ok(domCell.aria.includes(`公开 ${cell.public}`), domCell.aria);
    assert.ok(domCell.aria.includes(`内部 ${cell.internal}`), domCell.aria);
  }, cellEvidence);

  const windowBefore = await page.$eval(".mc1-window", (n) => n.textContent?.trim() ?? "");
  await page.click(cellSelector);
  await page.waitForSelector('[data-testid="mc1-cell-detail"]', { timeout: 20000 });
  await waitIdle(400);
  const cellReader = await page.evaluate(() => {
    const reader = document.querySelector('[data-testid="mc1-cell-detail"]');
    return {
      title: reader?.querySelector(".mc1-reader-title strong")?.textContent?.trim() ?? "",
      meta: reader?.querySelector(".mc1-reader-title p")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      total: reader?.getAttribute("data-total") ?? "",
      rows: reader?.querySelectorAll(".mc1-msg-list > li").length ?? 0,
      windowNow: document.querySelector(".mc1-window")?.textContent?.trim() ?? "",
    };
  });
  const eventsUrl = `/api/events?dataset=MC1&limit=50&start_us=${winStart}&end_us=${winEnd}&actor=${encodeURIComponent(cell.agent_id)}`;
  const eventsApi = await apiGet(eventsUrl);
  const matched = eventsApi.total ?? eventsApi.meta?.matched_events;
  const cellEvidence2 = { ...cellEvidence, reader: cellReader, apiTotal: matched, sampleIds: eventsApi.items.slice(0, 3).map((i) => i.event_id) };
  check("J-MC1-05 普通点格只打开成员集合：读者计数=该格事件查询总数，全局筛选不变", () => {
    assert.equal(Number(cellReader.total), matched, `读者 ${cellReader.total} vs API ${matched}`);
    assert.equal(cellReader.windowNow, windowBefore, "点击热力格不应改写时间窗");
    assert.ok(cellReader.rows > 0, "读者里没有消息行");
    assert.ok(cellReader.meta.includes("该格时间桶"), cellReader.meta);
  }, cellEvidence2);
  await shot("j-mc1-02-cell-reader");

  // 展开一条真实消息：正文 / 内部审议 / raw 与 /api/events/{id} 对应。
  await page.waitForSelector('[data-testid="mc1-cell-detail"] .mc1-msg-list .mc1-msg-head', { timeout: 20000 });
  await page.click('[data-testid="mc1-cell-detail"] .mc1-msg-list .mc1-msg-head');
  await page.waitForSelector('[data-testid="mc1-cell-detail"] .mc1-msg-body .dual', { timeout: 20000 });
  await waitIdle(400);
  const msgInfo = await page.evaluate(() => {
    const reader = document.querySelector('[data-testid="mc1-cell-detail"]');
    const ids = [...reader.querySelectorAll(".mc1-msg-raw dd.mono")].map((n) => n.textContent?.trim() ?? "");
    const rawDetails = [...reader.querySelectorAll("details.mc1-raw-details")];
    rawDetails.forEach((d) => { d.open = true; });
    return {
      eventId: ids[0] ?? "",
      rawKeys: ids.slice(0, 6),
      dualText: reader.querySelector(".dual")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      emptyDelib: reader.querySelector(".dual-pane:nth-child(2) .dual-empty")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      provHint: reader.querySelector(".prov-hint")?.textContent?.trim() ?? "",
      rawPre: rawDetails[0]?.querySelector("pre")?.textContent?.length ?? 0,
      detailsPre: rawDetails[1]?.querySelector("pre")?.textContent?.length ?? 0,
      actions: [...reader.querySelectorAll(".mc1-msg-actions .btn")].map((n) => n.textContent?.trim()),
    };
  });
  const eventDetail = await apiGet(`/api/events/${encodeURIComponent(msgInfo.eventId)}?dataset=MC1`);
  const eventEvidence = {
    eventId: msgInfo.eventId, eventType: eventDetail.event_type,
    timestampRaw: eventDetail.timestamp_raw, timezone: eventDetail.timezone_status,
    keys: Object.keys(eventDetail).sort(),
    hasDeliberation: Object.keys(eventDetail.deliberation ?? {}).length > 0,
    rawBytes: msgInfo.rawPre, detailsBytes: msgInfo.detailsPre,
  };
  check("J-MC1-06 消息正文=真实 event_id：外发/内部审议并置，raw 与 details 可展开且与 API 键集对应", () => {
    assert.equal(msgInfo.eventId, eventDetail.event_id, `${msgInfo.eventId} vs ${eventDetail.event_id}`);
    assert.ok(msgInfo.dualText.includes("外发文本"), msgInfo.dualText.slice(0, 80));
    assert.equal(msgInfo.provHint, "模型生成", msgInfo.provHint);
    assert.ok(msgInfo.rawPre > 20, `raw 为空：${msgInfo.rawPre}`);
    assert.ok(msgInfo.detailsPre > 2, `details 为空：${msgInfo.detailsPre}`);
    assert.ok(msgInfo.dualText.includes("内部审议"), "双声道缺少内部审议栏");
    if (Object.keys(eventDetail.deliberation ?? {}).length > 0) assert.ok(!msgInfo.emptyDelib, "有审议但界面显示为空");
    else assert.ok(msgInfo.emptyDelib.includes("源数据未收录"), `无审议时应给出源数据未收录说明：${msgInfo.emptyDelib}`);
  }, eventEvidence);
  await shot("j-mc1-03-event-raw");

  // 回复网络：点一条真实边，身份与消息可回查。
  const netApi = await apiGet("/api/mc1/reply-network?dataset=MC1");
  const edgeCount = await page.evaluate(() => document.querySelectorAll(".mc1-edge-hit").length);
  check("J-MC1-07 回复网络来自 /api/mc1/reply-network，边/节点可直接点开", () => {
    assert.ok(edgeCount > 0, `SVG 可见边 ${edgeCount}`);
    assert.ok(netApi.edges.length > 0, "API 没有聚合边");
    assert.ok(netApi.counts.reply_edges >= 0 && netApi.counts.mention_edges >= 0, JSON.stringify(netApi.counts));
  }, { domEdges: edgeCount, apiEdges: netApi.edges.length, counts: netApi.counts });

  await page.evaluate(() => document.querySelector(".mc1-edge-hit")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForSelector('.mc1-reader[aria-label="回复边证据"]', { timeout: 20000 });
  await waitIdle(400);
  const edgeInfo = await page.evaluate(() => {
    const reader = document.querySelector('.mc1-reader[aria-label="回复边证据"]');
    return {
      title: reader?.querySelector(".mc1-reader-title strong")?.textContent?.trim() ?? "",
      meta: reader?.querySelector(".mc1-reader-title p")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      scope: reader?.querySelector(".mc1-msgs-scope")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      ids: [...(reader?.querySelectorAll(".mc1-msg-list .mc1-msg-head") ?? [])].length,
    };
  });
  const edgeEvidence = { edgeInfo, apiKinds: [...new Set(netApi.edges.map((e) => `${e.kind}:${e.reply_class}`))] };
  check("J-MC1-08 点边读该聚合边的真实消息，reply/mention 身份不合并成因果", () => {
    assert.match(edgeInfo.title, /有效回复|未来引用|点名提及/, edgeInfo.title);
    assert.ok(edgeInfo.meta.includes("聚合边证据"), edgeInfo.meta);
    assert.ok(edgeInfo.ids >= 1, `边读者没有消息行：${edgeInfo.ids}`);
    assert.ok(edgeInfo.scope.includes("reply") && edgeInfo.scope.includes("mention"), edgeInfo.scope);
  }, edgeEvidence);
  await shot("j-mc1-04-edge-reader");

  // 回到消息，把真实事件加入证据篮（支持）。
  await page.click(cellSelector);
  await page.waitForSelector('[data-testid="mc1-cell-detail"] .mc1-msg-list .mc1-msg-head', { timeout: 20000 });
  await page.click('[data-testid="mc1-cell-detail"] .mc1-msg-list .mc1-msg-head');
  await page.waitForSelector('[data-testid="mc1-cell-detail"] .mc1-msg-actions', { timeout: 20000 });
  await waitIdle(300);
  await clickText('[data-testid="mc1-cell-detail"] .mc1-msg-actions .btn', "支持");
  const basketState = await page.evaluate(() => {
    const reader = document.querySelector('[data-testid="mc1-cell-detail"]');
    return { readerEvent: [...reader.querySelectorAll(".mc1-msg-raw dd.mono")][0]?.textContent?.trim() ?? "" };
  });
  check("J-MC1-09 证据动作绑定当前真实事件（不是摘要或格子）", () => {
    assert.equal(basketState.readerEvent, eventDetail.event_id);
  }, basketState);

  // 保存案例 → 写结论 → 导出。
  const mc1Title = `F4 J-MC1 沟通链 ${Date.now()}`;
  const mc1Case = await saveCase(mc1Title);
  const mc1Saved = await apiGet(`/api/cases/${encodeURIComponent(mc1Case.case_id)}`);
  const mc1Snap = mc1Saved.snapshot ?? {};
  await saveFinding(
    "17:25 的首条内部确认早于 18:00 解禁，外发正文与内部审议可分别回查",
    `事件 ${eventDetail.event_id} 的外发文本与内部审议来自同一条原始记录，回复引用分类分别统计。`,
    "内部审议是模型生成文本，只能作为线索，不能单独证明动机。",
  );
  const md = await exportCase(mc1Case.case_id, "md");
  const json = await exportCase(mc1Case.case_id, "json");
  const caseEvidence = {
    case_id: mc1Case.case_id, data_version: mc1Saved.data_version,
    dataset_id: mc1Snap.dataset_id, selection: mc1Snap.selection,
    filterWindow: [
      mc1Snap.base_filters?.startUs ?? mc1Snap.base_filters?.start_us ?? null,
      mc1Snap.base_filters?.endUs ?? mc1Snap.base_filters?.end_us ?? null,
    ],
    basket: (mc1Snap.pinned_evidence ?? []).map((i) => `${i.role}:${i.event_id}`),
    exportStatus: [md.status, json.status],
    mdHas: {
      eventId: md.text.includes(eventDetail.event_id),
      dataset: /MC1/.test(md.text),
      dataVersion: md.text.includes(mc1Saved.data_version.slice(0, 12)),
      claim: md.text.includes("17:25 的首条内部确认"),
    },
  };
  check("J-MC1-10 保存快照写下来源事件/窗口/证据身份，导出 MD+JSON 含 event_id、dataset、数据版本与结论", () => {
    assert.equal(mc1Snap.dataset_id, "MC1");
    assert.ok(mc1Snap.selection?.id === eventDetail.event_id, `selection ${JSON.stringify(mc1Snap.selection)}`);
    assert.ok((mc1Snap.pinned_evidence ?? []).some((i) => i.event_id === eventDetail.event_id && i.role === "support"),
      JSON.stringify(mc1Snap.pinned_evidence));
    assert.ok(caseEvidence.mdHas.eventId && caseEvidence.mdHas.dataset && caseEvidence.mdHas.dataVersion, JSON.stringify(caseEvidence.mdHas));
    assert.ok(caseEvidence.mdHas.claim, "导出缺少结论主张");
    assert.ok(json.text.includes(eventDetail.event_id), "JSON 导出缺少 event_id");
  }, caseEvidence);
  await shot("j-mc1-05-saved-case");

  // 切换数据集后恢复：切回 MC1 从证据篮恢复，正文与暂停状态一致。
  await closeDrawer();
  await selectDataset("MC2");
  await selectDataset("MC1");
  await page.waitForSelector('[data-testid="mc1-page"]', { timeout: 30000 });
  const readersAfterSwitch = await page.evaluate(() => document.querySelectorAll(".mc1-reader").length);
  await restoreFromBasket(mc1Case.case_id);
  await page.waitForSelector('[data-testid="mc1-event-detail"]', { timeout: 25000 });
  const restored = await page.evaluate(() => {
    const reader = document.querySelector('[data-testid="mc1-event-detail"]');
    return {
      readers: document.querySelectorAll(".mc1-reader").length,
      eventId: reader?.querySelector(".mc1-msg-raw dd.mono")?.textContent?.trim() ?? "",
      dataset: document.querySelector(".dataset-field select")?.value ?? "",
      window: document.querySelector(".mc1-window")?.textContent?.trim() ?? "",
    };
  });
  const playingAfterRestore = await playing();
  check("J-MC1-11 换集后恢复：MC1 窗口一致、所选事件正文重新出现、回放暂停", () => {
    assert.equal(readersAfterSwitch, 0, "换集后仍残留旧读者");
    assert.equal(restored.dataset, "MC1", restored.dataset);
    assert.equal(restored.eventId, eventDetail.event_id, `${restored.eventId} vs ${eventDetail.event_id}`);
    assert.ok(restored.window.includes("06-05"), restored.window);
    assert.equal(playingAfterRestore, "开始回放", `恢复后应暂停：${playingAfterRestore}`);
  }, { readersAfterSwitch, restored, playingAfterRestore, expectedEvent: eventDetail.event_id });
  await shot("j-mc1-06-restored");

  // 关闭详情后再恢复同一案例：正文重新出现（不是只在内存里留着）。
  await closeDrawer();
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="mc1-event-detail"] .mc1-detail-actions .btn')].at(-1)?.click());
  await sleep(300);
  const afterClose = await page.evaluate(() => ({
    readers: document.querySelectorAll(".mc1-reader").length,
    active: document.activeElement?.tagName ?? "",
    activeLabel: document.activeElement?.getAttribute("data-cell-key") ?? document.activeElement?.getAttribute("aria-label") ?? "",
  }));
  await restoreFromBasket(mc1Case.case_id);
  await page.waitForSelector('[data-testid="mc1-event-detail"]', { timeout: 25000 });
  const reread = await page.evaluate(() => ({
    eventId: document.querySelector('[data-testid="mc1-event-detail"] .mc1-msg-raw dd.mono')?.textContent?.trim() ?? "",
  }));
  check("J-MC1-12 关闭详情后重复恢复同一案例仍重开正文；关闭不落在 BODY", () => {
    assert.equal(afterClose.readers, 0);
    assert.notEqual(afterClose.active, "BODY", JSON.stringify(afterClose));
    assert.equal(reread.eventId, eventDetail.event_id, `重复恢复 ${reread.eventId}`);
  }, { afterClose, reread });
  await shot("j-mc1-07-restored-again");

  // ================================================================ J-MC2
  currentJourney = "J-MC2";
  await newContext("mc2");
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle2" });
  await selectDataset("MC2");
  await page.waitForSelector('[data-testid="mc2-page"]', { timeout: 30000 });
  await waitIdle(400);
  await clickText(".topbar-docks button", "证据").catch(() => {});
  await sleep(200);
  await closeDrawer();

  const mc2Shell = await page.evaluate(() => ({
    taskTabs: document.querySelectorAll(".task-tab, .mode-tab, .view-tab").length,
    eventDock: !!document.querySelector(".event-dock, .statusbar"),
    chain: !!document.querySelector('[data-testid="mc2-trace-card"]'),
    target: document.querySelector('[data-testid="mc2-target-post"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    readers: document.querySelectorAll('[data-testid^="mc2-"][data-testid$="-detail"]').length,
  }));
  check("J-MC2-01 MC2 默认是来源链单页，目标帖入口常显，无旧导航/事件坞", () => {
    assert.equal(mc2Shell.taskTabs, 0, JSON.stringify(mc2Shell));
    assert.equal(mc2Shell.eventDock, false, JSON.stringify(mc2Shell));
    assert.equal(mc2Shell.chain, true, JSON.stringify(mc2Shell));
    assert.ok(mc2Shell.target.includes("11:21"), mc2Shell.target);
    assert.equal(mc2Shell.readers, 0, JSON.stringify(mc2Shell));
  }, mc2Shell);
  await shot("j-mc2-01-default");

  const rootMeta = await apiGet(`/api/events/${encodeURIComponent(KNOWN.mc2Target)}?dataset=MC2`);
  await page.click('[data-testid="mc2-target-post"]');
  await page.waitForSelector(".mc2-root-event", { timeout: 25000 });
  await waitIdle(600);
  const rootShown = await page.$eval(".mc2-root-event", (n) => n.textContent?.trim() ?? "");
  check("J-MC2-02 定位目标帖展开链根 373902，时间来自 manifest 而不是沿用 MC1 选择", () => {
    assert.equal(rootShown, rootMeta.event_id, `${rootShown} vs ${rootMeta.event_id}`);
    assert.equal(rootMeta.timestamp_raw.slice(0, 19), "2046-05-17T11:21:15", rootMeta.timestamp_raw);
  }, { rootShown, timestamp_raw: rootMeta.timestamp_raw, contentSource: rootMeta.details?.content_source ?? null });

  // 目标帖原始记录：只有文件名，没有正文。
  await page.click(".mc2-root-event");
  await page.waitForSelector('[data-testid="mc2-event-detail"]', { timeout: 25000 });
  await waitIdle(400);
  const targetReader = await page.evaluate(() => {
    const reader = document.querySelector('[data-testid="mc2-event-detail"]');
    return {
      id: reader?.querySelector(".mc2-msg-meta .mono")?.textContent?.trim() ?? "",
      text: reader?.textContent?.replace(/\s+/g, " ").trim().slice(0, 400) ?? "",
      hasQuote: !!reader?.querySelector("blockquote.quote"),
    };
  });
  check("J-MC2-03 目标帖阅读区不把文件元数据当正文：明确“日志只记录了来源文件名”", () => {
    assert.equal(targetReader.id, KNOWN.mc2Target, targetReader.id);
    assert.ok(targetReader.text.includes("日志只记录了来源文件名，没有提供正文"), targetReader.text.slice(0, 120));
    assert.equal(targetReader.hasQuote, false, "目标帖不应出现真实正文引用块");
    assert.equal(rootMeta.outgoing_text ?? null, null, "API 不应给出目标帖正文");
  }, { targetReader, apiText: rootMeta.outgoing_text ?? null });
  await shot("j-mc2-02-target-reader");

  // 记录来源文件：经文件操作行打开真实事件；单击行不换根，显式按钮才换根。
  await clickText('[data-testid="mc2-event-detail"] .btn', "查看文件轨迹");
  await page.waitForSelector('[data-testid="mc2-file-detail"]', { timeout: 25000 });
  await page.waitForSelector(".file-track-row", { timeout: 25000 });
  await waitIdle(500);
  const fileInfo = await page.evaluate(() => {
    const reader = document.querySelector('[data-testid="mc2-file-detail"]');
    return {
      title: reader?.querySelector(".mc2-reader-title strong")?.textContent?.trim() ?? "",
      meta: reader?.querySelector(".mc2-reader-title p")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      rows: reader?.querySelectorAll(".file-track-row").length ?? 0,
      rowIds: [...(reader?.querySelectorAll(".file-track-row") ?? [])].slice(0, 3).map((li) => li.querySelector("[data-event-id]")?.getAttribute("data-event-id")
        ?? li.textContent?.replace(/\s+/g, " ").trim().slice(0, 60)),
    };
  });
  const rootBeforeRow = await chainRootInfo();
  const setRootInfo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".file-track-row")];
    const pick = rows.find((row) => [...row.querySelectorAll("button")].some((b) => b.textContent?.trim() === "设为链根"));
    const btn = pick && [...pick.querySelectorAll("button")].find((b) => b.textContent?.trim() === "设为链根");
    const rowEvent = pick?.querySelector(".stream-row")?.getAttribute("data-event-id") ?? "";
    btn?.click();
    return { rows: rows.length, hasButton: !!btn, rowEvent };
  });
  await waitIdle(800);
  const newRoot = await chainRootInfo();
  const trackApi = await apiGet(`/api/file-track?dataset=MC2&file_id=${encodeURIComponent("MC2:file_path:SwiftWren.txt")}&limit=5`);
  const trackIds = trackApi.items.map((item) => item.event_id);
  check("J-MC2-04 记录来源文件可读，操作行带独立“设为链根”按钮且换根生效", () => {
    assert.ok(fileInfo.title.includes("文件轨迹"), fileInfo.title);
    assert.ok(fileInfo.meta.includes("当前链根记录的内容文件"), fileInfo.meta);
    assert.ok(fileInfo.rows >= 1, `文件轨迹行数 ${fileInfo.rows}`);
    assert.equal(setRootInfo.hasButton, true, "文件轨迹缺少显式“设为链根”按钮");
    assert.equal(rootBeforeRow.eventId, KNOWN.mc2Target, `初始链根 ${rootBeforeRow.eventId}`);
    assert.ok(trackIds.includes(newRoot.eventId), `新链根不在该文件真实轨迹里：${newRoot.eventId} vs ${trackIds.join(",")}`);
    assert.notEqual(newRoot.eventId, KNOWN.mc2Target, "换根未生效");
  }, { fileInfo, setRootInfo, rootBeforeRow, newRoot, trackIds });
  await shot("j-mc2-03-file-detail");

  // 单击行只读正文，不换根；唯一阅读区与 selection 一致。
  await page.click(".file-track-row .stream-row");
  await page.waitForSelector('[data-testid="mc2-event-detail"]', { timeout: 25000 });
  await waitIdle(400);
  const fileEventReader = await page.evaluate(() => ({
    id: document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim() ?? "",
  }));
  const rootAfterRow = await chainRootInfo();
  const fileEventApi = await apiGet(`/api/events/${encodeURIComponent(fileEventReader.id)}?dataset=MC2`);
  check("J-MC2-05 单击文件操作行打开真实事件且不改链根", () => {
    assert.ok(fileEventReader.id.startsWith("MC2:event:"), fileEventReader.id);
    assert.equal(fileEventApi.event_id, fileEventReader.id);
    assert.equal(rootAfterRow.eventId, newRoot.eventId, `单击行改写了链根：${JSON.stringify(rootAfterRow)}`);
  }, { fileEventReader, rootAfterRow, rootAfterSetRoot: newRoot, eventType: fileEventApi.event_type });
  await shot("j-mc2-04-row-reader");

  // 候选文件：常显“候选，不等于传播证据”；换根后身份按当前根重算。
  await page.click('[data-testid="mc2-target-post"]');
  await page.waitForSelector(".mc2-root-event", { timeout: 25000 });
  await waitIdle(600);
  const candidateOpened = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-testid="mc2-trace-card"] .trace-item')];
    const cand = items.find((n) => n.textContent?.includes("候选"));
    cand?.click();
    return cand?.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ?? "";
  });
  await page.waitForSelector('[data-testid="mc2-file-detail"]', { timeout: 25000 });
  await waitIdle(500);
  const candidateReader = await page.evaluate(() => {
    const reader = document.querySelector('[data-testid="mc2-file-detail"]');
    return {
      title: reader?.querySelector(".mc2-reader-title strong")?.textContent?.trim() ?? "",
      meta: reader?.querySelector(".mc2-reader-title p")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    };
  });
  check("J-MC2-06 候选文件常显“候选≠传播证据”，身份来自当前链根", () => {
    assert.ok(candidateOpened.includes("候选"), candidateOpened);
    assert.ok(candidateReader.meta.includes("候选文件"), candidateReader.meta);
    assert.ok(candidateReader.meta.includes("不等于传播证据"), candidateReader.meta);
    assert.ok(candidateReader.title.includes("SwiftWren_further_instructions.md"), candidateReader.title);
  }, { candidateOpened, candidateReader });
  await shot("j-mc2-05-candidate-file");

  // 换根后，同一候选文件身份按新根重算为“关系待核实”。
  const reRoot = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".file-track-row")];
    const pick = rows.find((row) => [...row.querySelectorAll("button")].some((b) => b.textContent?.trim() === "设为链根"));
    const btn = pick && [...pick.querySelectorAll("button")].find((b) => b.textContent?.trim() === "设为链根");
    btn?.click();
    return { rows: rows.length, hasButton: !!btn };
  });
  await waitIdle(800);
  const rootAfterCandidate = await chainRootInfo();
  await page.evaluate(() => document.querySelector(".mc2-tools")?.setAttribute("open", ""));
  await clickText(".mc2-tools-menu button", "文件查询");
  await page.waitForSelector('.mc2-file-search input[type="search"]', { timeout: 20000 });
  await page.type('.mc2-file-search input[type="search"]', "SwiftWren_further_instructions");
  await clickText(".mc2-file-search .btn", "查询文件");
  await page.waitForSelector(".mc2-file-search .trace-item", { timeout: 25000 });
  await page.evaluate(() => {
    const hit = [...document.querySelectorAll(".mc2-file-search .trace-item")].find((n) => n.textContent?.includes("SwiftWren_further_instructions"));
    hit?.click();
  });
  await page.waitForSelector('[data-testid="mc2-file-detail"]', { timeout: 25000 });
  await waitIdle(500);
  const identityAfterRoot = await page.$eval('[data-testid="mc2-file-detail"] .mc2-reader-title p', (n) => n.textContent?.replace(/\s+/g, " ").trim() ?? "");
  // 同一入口再查一个与当前链无关的文件：身份按当前根算成“关系待核实”，不沿用旧面板标签。
  await page.evaluate(() => {
    const input = document.querySelector('.mc2-file-search input[type="search"]');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "MellowOtter");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await clickText(".mc2-file-search .btn", "查询文件");
  await page.waitForSelector(".mc2-file-search .trace-item", { timeout: 25000 });
  await page.evaluate(() => {
    const hit = [...document.querySelectorAll(".mc2-file-search .trace-item")].find((n) => n.textContent?.includes("MellowOtter"));
    hit?.click();
  });
  await page.waitForSelector('[data-testid="mc2-file-detail"]', { timeout: 25000 });
  await waitIdle(400);
  const unrelatedIdentity = await page.$eval('[data-testid="mc2-file-detail"] .mc2-reader-title p', (n) => n.textContent?.replace(/\s+/g, " ").trim() ?? "");
  check("J-MC2-07 换根后文件身份按当前根重算：记录来源随根改变，无关文件标为关系待核实", () => {
    assert.equal(reRoot.hasButton, true, "候选文件轨迹缺少显式换根按钮");
    assert.notEqual(rootAfterCandidate.eventId, KNOWN.mc2Target, `链根未改变：${JSON.stringify(rootAfterCandidate)}`);
    assert.ok(identityAfterRoot.includes("当前链根记录的内容文件"), `换根后同一文件应成为当前链的记录来源：${identityAfterRoot}`);
    assert.ok(unrelatedIdentity.includes("关系待核实"), `无关文件应标为关系待核实：${unrelatedIdentity}`);
  }, { reRoot, rootAfterCandidate, identityAfterRoot, unrelatedIdentity });
  await shot("j-mc2-06-candidate-identity");

  // 历史实例：3 条链 × 阶段，missing 不补零。
  await page.click('[data-testid="mc2-target-post"]');
  await page.waitForSelector(".mc2-root-event", { timeout: 25000 });
  await waitIdle(500);
  const historyApi = await apiGet("/api/patterns/file-posts?dataset=MC2");
  await page.evaluate(() => document.querySelector(".mc2-tools")?.setAttribute("open", ""));
  await clickText('.mc2-tools-menu button', "历史实例");
  await page.waitForSelector('[aria-label="历史实例阶段对齐"] .pattern-table', { timeout: 30000 });
  await waitIdle(400);
  const historyDom = await page.evaluate(() => {
    const table = document.querySelector('[aria-label="历史实例阶段对齐"] .pattern-table');
    return {
      cols: table?.querySelectorAll("thead th").length ?? 0,
      rows: table?.querySelectorAll("tbody tr").length ?? 0,
      missing: table?.querySelectorAll("td.pattern-missing").length ?? 0,
      missingTexts: [...(table?.querySelectorAll("td.pattern-missing") ?? [])].slice(0, 3).map((n) => n.textContent?.replace(/\s+/g, " ").trim()),
      firstEvent: table?.querySelector(".pattern-event")?.textContent?.trim() ?? "",
      chainTitles: [...(table?.querySelectorAll("thead th") ?? [])].slice(1).map((n) => n.textContent?.replace(/\s+/g, " ").trim()),
    };
  });
  check("J-MC2-08 历史实例为 3 条链×阶段对齐，缺失阶段写“缺失”而不是 0", () => {
    assert.equal(historyApi.items.length, 3, `API 链数 ${historyApi.items.length}`);
    assert.equal(historyDom.cols, 1 + historyApi.items.length, JSON.stringify(historyDom));
    assert.ok(historyDom.rows >= historyApi.stage_dictionary.length - 1, JSON.stringify(historyDom));
    assert.ok(historyDom.missing > 0, "样本里应有缺失阶段");
    assert.ok(historyDom.missingTexts.every((t) => t.startsWith("缺失")), JSON.stringify(historyDom.missingTexts));
  }, { historyDom, apiChains: historyApi.items.length });
  await shot("j-mc2-07-history");

  // 点一个真实阶段事件，正文 ID 与时间匹配。
  const stageBtn = await page.$('[aria-label="历史实例阶段对齐"] .pattern-event');
  await stageBtn.click();
  await page.waitForSelector('[data-testid="mc2-event-detail"]', { timeout: 25000 });
  await waitIdle(400);
  const stageReader = await page.evaluate(() => ({
    id: document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim() ?? "",
    time: document.querySelectorAll('[data-testid="mc2-event-detail"] .mc2-msg-meta span')[2]?.textContent?.trim() ?? "",
  }));
  const stageApi = await apiGet(`/api/events/${encodeURIComponent(stageReader.id)}?dataset=MC2`);
  const stageChain = historyApi.items.flatMap((c) => c.stages.flatMap((s) => (s.event_ids ?? []).map((id) => ({ id, stage: s.stage, post: c.post_event_id }))))
    .find((x) => x.id === stageReader.id);
  check("J-MC2-09 历史阶段事件可打开：正文 ID 来自该链该阶段，时间与 API 一致", () => {
    assert.ok(stageReader.id.startsWith("MC2:event:"), stageReader.id);
    assert.ok(stageChain, `${stageReader.id} 不在任何链阶段里`);
    assert.ok(stageReader.time.includes(stageApi.timestamp_raw.slice(0, 10)), `${stageReader.time} vs ${stageApi.timestamp_raw}`);
  }, { stageReader, stage: stageChain, timestamp_raw: stageApi.timestamp_raw });
  await shot("j-mc2-08-history-event");

  // 干预论证：只允许一个候选位置，覆盖/局限可读。
  await page.evaluate(() => document.querySelector(".mc2-tools")?.setAttribute("open", ""));
  await clickText('.mc2-tools-menu button', "干预论证");
  await page.waitForSelector('[aria-label="候选干预"] .intervention-view', { timeout: 30000 });
  await waitIdle(400);
  const interventionApi = await apiGet("/api/interventions?dataset=MC2&position=relay_queue").catch(() => null);
  const interventionDom = await page.evaluate(() => {
    const card = document.querySelector('[aria-label="候选干预"]');
    const buttons = [...card.querySelectorAll(".intervention-actions .btn")];
    return {
      tags: [...card.querySelectorAll(".tag")].map((n) => n.textContent?.trim()).filter(Boolean).slice(0, 4),
      actionText: buttons.map((b) => b.textContent?.trim()),
      pressed: buttons.map((b) => b.getAttribute("aria-pressed")),
      limitations: [...card.querySelectorAll("ul.muted.small li")].length,
      coverage: card.querySelector("h3")?.textContent?.trim() ?? "",
    };
  });
  await page.evaluate(() => document.querySelector(".intervention-actions .btn")?.click());
  await sleep(300);
  const interventionAfter = await page.evaluate(() => {
    const card = document.querySelector('[aria-label="候选干预"]');
    const btn = card.querySelector(".intervention-actions .btn");
    return { text: btn?.textContent?.trim() ?? "", pressed: btn?.getAttribute("aria-pressed") };
  });
  check("J-MC2-10 干预论证只有一个候选位置，可显式选中并保留覆盖/局限说明（不宣称阻断历史传播）", () => {
    assert.ok(interventionDom.tags.some((t) => t.includes("候选")), JSON.stringify(interventionDom.tags));
    assert.equal(interventionDom.actionText.length, 1, JSON.stringify(interventionDom.actionText));
    assert.ok(interventionDom.limitations >= 2, `局限条目 ${interventionDom.limitations}`);
    assert.ok(interventionDom.coverage.includes("覆盖"), interventionDom.coverage);
    assert.equal(interventionAfter.pressed, "true", JSON.stringify(interventionAfter));
  }, { interventionDom, interventionAfter, apiCoverage: interventionApi?.coverage_summary ?? null });
  await shot("j-mc2-09-intervention");

  // 加入证据并保存/导出/恢复：先记下真实链根与当前 reader，再断言快照与导出逐字段一致。
  const mc2RootBeforeSave = await chainRootInfo();
  const mc2Reader = await page.evaluate(() => {
    const reader = document.querySelector('[data-testid="mc2-event-detail"]');
    return {
      id: reader?.querySelector(".mc2-msg-meta .mono")?.textContent?.trim() ?? "",
      title: reader?.querySelector(".mc2-reader-title strong")?.textContent?.trim() ?? "",
    };
  });
  const mc2Add = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid="mc2-event-detail"] .mc2-msg-actions .btn, [data-testid="mc2-event-detail"] .btn')]
      .find((b) => b.textContent?.trim() === "支持");
    btn?.click();
    return !!btn;
  });
  await drawerTab("证据篮");
  const mc2Basket = await page.evaluate(() => [...document.querySelectorAll(".basket .trace-list li")].map((li) => ({
    role: li.querySelector(".role-chip")?.textContent?.trim() ?? "",
    id: li.querySelector(".mono")?.textContent?.trim() ?? "",
  })));
  check("J-MC2-11 记录证据按自身身份加入（支持），候选/缺口不被标成传播事实", () => {
    assert.equal(mc2Add, true, "阅读区缺少加入证据篮按钮");
    assert.ok(mc2Reader.id.startsWith("MC2:event:"), JSON.stringify(mc2Reader));
    assert.equal(mc2Basket.length, 1, JSON.stringify(mc2Basket));
    assert.equal(mc2Basket[0].role, "支持", JSON.stringify(mc2Basket));
    assert.equal(mc2Basket[0].id, mc2Reader.id, `${mc2Basket[0].id} vs ${mc2Reader.id}`);
  }, { mc2Reader, mc2Basket, rootBeforeSave: mc2RootBeforeSave });
  const mc2Title = `F4 J-MC2 来源链 ${Date.now()}`;
  const mc2Case = await saveCase(mc2Title);
  const mc2Saved = await apiGet(`/api/cases/${encodeURIComponent(mc2Case.case_id)}`);
  const mc2Snap = mc2Saved.snapshot ?? {};
  await saveFinding(
    "目标帖内容来自 SwiftWren.txt，候选指令文件只是同名前缀线索",
    `链根 ${mc2Snap.trace_object?.rootEventId ?? ""} 经记录边到内容文件；候选文件在日志里没有转交给发布者的记录。`,
    "候选层缺少确定性字段，不能据此认定传播路径。",
  );
  const mc2Md = await exportCase(mc2Case.case_id, "md");
  const mc2Json = await exportCase(mc2Case.case_id, "json");
  const mc2Export = JSON.parse(mc2Json.text);
  const mc2ExportEv = mc2Export.findings?.[0]?.evidence ?? [];
  const mc2ReaderApi = await apiGet(`/api/events/${encodeURIComponent(mc2Reader.id)}?dataset=MC2`);
  const ROLE_KEY = { 支持: "support", 反证: "counter", 待核实: "uncertain" };
  const pinnedKey = (item) => {
    const role = item.role ?? item.reference_role ?? "";
    const id = item.event_id ?? item.reference_id ?? item.id;
    return `${ROLE_KEY[role] ?? role}:${id}`;
  };
  const mc2Evidence = {
    case_id: mc2Case.case_id,
    traceObject: mc2Snap.trace_object,
    selection: mc2Snap.selection,
    reader: mc2Reader,
    pinned: (mc2Snap.pinned_evidence ?? []).map(pinnedKey),
    basket: mc2Basket.map(pinnedKey),
    exportSelection: mc2Export.snapshot?.selection ?? null,
    exportPinned: (mc2Export.snapshot?.pinned_evidence ?? []).map(pinnedKey),
    exportEvidence: mc2ExportEv.map((e) => ({ id: e.reference_id, role: e.role, resolved: e.resolved?.event_id ?? null })),
    mdHas: { root: mc2Md.text.includes("373902"), dataset: mc2Md.text.includes("MC2"), version: mc2Md.text.includes(mc2Saved.data_version.slice(0, 12)) },
  };
  check("J-MC2-12 快照与导出逐字段一致：链根/文件/selection=实际 reader/pinned_evidence=篮内证据/resolved 事件", () => {
    assert.equal(mc2Snap.dataset_id, "MC2");
    assert.equal(mc2Snap.trace_object?.rootEventId, mc2RootBeforeSave.eventId, `${mc2Snap.trace_object?.rootEventId} vs ${mc2RootBeforeSave.eventId}`);
    assert.equal(mc2Snap.trace_object?.fileId, "MC2:file_path:SwiftWren.txt");
    assert.equal(mc2Snap.selection?.id, mc2Reader.id, `${mc2Snap.selection?.id} vs ${mc2Reader.id}`);
    // 原合同允许该选择的时间为 null；这里核对“事件本身在 API 有真实时间”，不新增必填字段。
    assert.ok(mc2Snap.selection?.timeUs == null || mc2Snap.selection.timeUs === mc2ReaderApi.time_us, JSON.stringify(mc2Snap.selection));
    assert.ok(mc2ReaderApi.time_us > 0, `事件缺少真实时间：${JSON.stringify(mc2ReaderApi.time_us)}`);
    assert.deepEqual(mc2Evidence.pinned.slice().sort(), mc2Evidence.basket.slice().sort(), JSON.stringify(mc2Evidence));
    assert.equal(mc2Export.case_id, mc2Case.case_id);
    assert.equal(mc2Export.snapshot?.selection?.id, mc2Reader.id);
    assert.equal(mc2Export.snapshot?.trace_object?.rootEventId, mc2RootBeforeSave.eventId);
    assert.deepEqual(mc2Evidence.exportPinned.slice().sort(), mc2Evidence.pinned.slice().sort());
    assert.equal(mc2Export.data_version, mc2Saved.data_version);
    assert.equal(mc2ExportEv.length, 1, JSON.stringify(mc2ExportEv));
    assert.equal(mc2ExportEv[0].reference_id, mc2Reader.id);
    assert.equal(mc2ExportEv[0].role, "support");
    assert.equal(mc2ExportEv[0].resolved?.event_id, mc2Reader.id);
    assert.equal(mc2Export.summary?.support, 1, JSON.stringify(mc2Export.summary));
    assert.ok(mc2Evidence.mdHas.root && mc2Evidence.mdHas.dataset && mc2Evidence.mdHas.version, JSON.stringify(mc2Evidence.mdHas));
  }, mc2Evidence);
  await shot("j-mc2-10-saved-case");

  // 隐藏来源链后恢复：链应展开。
  await closeDrawer();
  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll(".mc2-toggle")].find((b) => b.textContent?.trim() === "来源链");
    if (toggle?.getAttribute("aria-pressed") === "true") toggle.click();
  });
  await sleep(400);
  const chainHidden = await page.evaluate(() => !document.querySelector('[data-testid="mc2-trace-card"]'));
  await restoreFromBasket(mc2Case.case_id);
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 25000 });
  const chainRestoredRoot = await chainRootInfo();
  const chainRestored = await page.evaluate(() => ({
    chain: !!document.querySelector('[data-testid="mc2-trace-card"]'),
    pressed: [...document.querySelectorAll(".mc2-toggle")].find((b) => b.textContent?.trim() === "来源链")?.getAttribute("aria-pressed"),
  }));
  const mc2ReaderId = () => page.evaluate(() => document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim() ?? "");
  const waitMc2Reader = async (id) => {
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim() === want,
      { timeout: 25000 },
      id,
    );
    return page.evaluate(() => ({
      id: document.querySelector('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono')?.textContent?.trim() ?? "",
      title: document.querySelector('[data-testid="mc2-event-detail"] .mc2-reader-title strong')?.textContent?.trim() ?? "",
    }));
  };
  const restoredMc2Reader = await waitMc2Reader(mc2Snap.selection?.id);
  // 关闭详情后重复恢复同一案例：正文按快照 selection 重新出现，链根仍是快照值。
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="mc2-event-detail"] button')]
    .find((b) => b.textContent?.trim() === "关闭")?.click());
  await sleep(400);
  const readerClosedBeforeRepeat = await mc2ReaderId();
  await restoreFromBasket(mc2Case.case_id);
  await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 25000 });
  const repeatedMc2Reader = await waitMc2Reader(mc2Snap.selection?.id);
  const repeatedRoot = await chainRootInfo();
  check("J-MC2-13 隐藏来源链后恢复：链与开关回到可见，正文=快照 selection，重复恢复仍重开同一正文", () => {
    assert.equal(chainHidden, true, "未能隐藏来源链");
    assert.equal(chainRestored.chain, true);
    assert.equal(chainRestored.pressed, "true", JSON.stringify(chainRestored));
    assert.equal(chainRestoredRoot.eventId, mc2Snap.trace_object.rootEventId, JSON.stringify(chainRestoredRoot));
    assert.equal(restoredMc2Reader.id, mc2Snap.selection.id, `${restoredMc2Reader.id} vs ${mc2Snap.selection.id}`);
    assert.equal(readerClosedBeforeRepeat, "", `关闭后仍残留正文：${readerClosedBeforeRepeat}`);
    assert.equal(repeatedMc2Reader.id, mc2Snap.selection.id, `${repeatedMc2Reader.id} vs ${mc2Snap.selection.id}`);
    assert.equal(repeatedRoot.eventId, mc2Snap.trace_object.rootEventId, JSON.stringify(repeatedRoot));
  }, { chainHidden, chainRestored, chainRestoredRoot, restoredMc2Reader, readerClosedBeforeRepeat, repeatedMc2Reader, repeatedRoot });
  await shot("j-mc2-11-restored");

  // ================================================================ J-CUSTOM
  currentJourney = "J-CUSTOM";
  await newContext("custom");
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle2" });
  await selectDataset("CUSTOM");
  await page.waitForSelector('[data-testid="custom-overview"]', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll(".custom-overview-body").length > 0, { timeout: 30000 });
  await waitIdle(500);

  const runsApi = await apiGet("/api/runs?dataset=CUSTOM&include_stages=true&limit=200");
  const overviewReq = requests.filter((r) => r.journey === "J-CUSTOM" && r.path.startsWith("/api/runs?") && r.path.includes("include_stages=true"));
  const detailReq = requests.filter((r) => r.journey === "J-CUSTOM" && /^\/api\/runs\/run-/.test(r.path));
  const overviewDom = await page.evaluate(() => ({
    rows: document.querySelectorAll(".custom-overview-body").length,
    cells: document.querySelectorAll(".custom-stage-cell").length,
    count: document.querySelector('[data-testid="custom-overview-count"]')?.textContent?.trim() ?? "",
    chips: document.querySelectorAll(".custom-case-chip").length,
    status: document.querySelector('[data-testid="custom-cases-status"]')?.textContent?.trim() ?? "",
  }));
  check("J-CUSTOM-01 32 run 由当前 API 核实，概览一次批量取阶段摘要，无逐行运行详情", () => {
    assert.equal(runsApi.items.length, 32, `API run 数 ${runsApi.items.length}`);
    assert.equal(overviewDom.rows, 32, JSON.stringify(overviewDom));
    assert.ok(overviewDom.count.includes("32"), overviewDom.count);
    assert.ok(overviewReq.length >= 1, "没有 include_stages 批量请求");
    assert.equal(detailReq.length, 0, `出现逐行详情请求 ${detailReq.length} 次：${JSON.stringify(detailReq.slice(0, 3))}`);
    assert.equal(overviewDom.chips, 5, JSON.stringify(overviewDom));
    assert.ok(overviewDom.status.startsWith("5/5"), overviewDom.status);
  }, { rows: overviewDom.rows, batch: overviewReq.length, detail: detailReq.length, apiRuns: runsApi.items.length });
  await shot("j-custom-01-overview");

  // 冻结案例：正常进单运行（配对请求 0），审批绕过按指定 baseline 进对照。
  await page.click(`.custom-case-chip[data-case-id="${KNOWN.customNormalCase}"]`);
  await page.waitForSelector('[data-testid="custom-run"]', { timeout: 25000 });
  await waitIdle(500);
  const normalState = await page.evaluate(() => ({
    pair: !!document.querySelector('[data-testid="custom-pair"]'),
    run: !!document.querySelector('[data-testid="custom-run"]'),
    chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
    scope: document.querySelector('[data-testid="custom-run-scope"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  const pairReqAfterNormal = requests.filter((r) => r.journey === "J-CUSTOM" && r.path.startsWith("/api/run-comparisons")).length;
  check("J-CUSTOM-02 正常案例只进单运行，不触发配对请求", () => {
    assert.equal(normalState.run, true, JSON.stringify(normalState));
    assert.equal(normalState.pair, false, JSON.stringify(normalState));
    assert.equal(pairReqAfterNormal, 0, `配对请求 ${pairReqAfterNormal}`);
    assert.ok(normalState.chip.includes("run-") || normalState.chip.includes("运行"), normalState.chip);
  }, { normalState, pairRequests: pairReqAfterNormal });

  await page.click(`.custom-case-chip[data-case-id="${KNOWN.customBypassCase}"]`);
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 30000 });
  await page.waitForSelector(".custom-pair-row", { timeout: 30000 });
  await waitIdle(600);
  const pairApi = await apiGet(`/api/run-comparisons?run_id=${KNOWN.bypassRun}&baseline_run_id=${KNOWN.bypassBaseline}`);
  const pairDom = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="custom-pair"]');
    return {
      rows: card?.querySelectorAll(".custom-pair-row").length ?? 0,
      header: card?.querySelector(".custom-card-head")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      axis: card?.querySelector(".custom-pair-axis")?.getAttribute("data-axis-max") ?? "",
      missing: card?.querySelectorAll('[data-testid^="custom-pair-missing-"]').length ?? 0,
      stages: [...(card?.querySelectorAll(".custom-pair-row") ?? [])].map((r) => r.getAttribute("data-stage-key")),
    };
  });
  // 当前侧结果事件：审核未记录但已发布。
  const currentResult = await page.evaluate((ev) => {
    const btn = [...document.querySelectorAll('.custom-pair-events [data-side="run"]')].find((n) => n.getAttribute("data-event-id") === ev)
      ?? [...document.querySelectorAll(`[data-event-id="${ev}"]`)].find((n) => n.tagName === "BUTTON");
    btn?.click();
    return !!btn;
  }, KNOWN.bypassResult);
  await page.waitForSelector('[data-testid="custom-reader"]', { timeout: 25000 });
  await waitIdle(400);
  const currentReader = await page.evaluate(() => {
    const reader = document.querySelector('[data-testid="custom-reader"]');
    return {
      id: reader?.querySelector(".custom-msg-meta .mono")?.textContent?.trim() ?? "",
      owner: reader?.querySelector('[data-testid="custom-event-owner"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      text: reader?.textContent?.replace(/\s+/g, " ").slice(0, 200) ?? "",
    };
  });
  check("J-CUSTOM-03 审批绕过按显式 baseline 进对照：7 行双轨同轴，当前侧结果事件可读", () => {
    assert.equal(pairDom.rows, 7, JSON.stringify(pairDom));
    assert.equal(pairDom.stages.length, 7, JSON.stringify(pairDom.stages));
    assert.ok(pairDom.axis, "配对缺共享轴预算");
    assert.equal(pairApi.run.run_id, KNOWN.bypassRun, pairApi.run.run_id);
    assert.equal(pairApi.baseline.run_id, KNOWN.bypassBaseline, pairApi.baseline.run_id);
    assert.equal(currentReader.id, KNOWN.bypassResult, currentReader.id);
    assert.ok(currentReader.owner.includes("当前") || currentReader.owner.includes("审批"), currentReader.owner);
    assert.equal(currentResult, true, "未能从配对当前侧打开结果事件");
  }, { pairDom, currentReader, currentReview: pairApi.run.stages?.review ?? null, baselineReview: pairApi.baseline.stages?.review ?? null });
  await shot("j-custom-02-pair-current");

  // 对照侧真实审核/结果事件；当前调查运行不被改成 baseline。
  await page.click('.custom-pair-row[data-stage-key="result"] .custom-track[data-side="baseline"]');
  await page.waitForSelector('.custom-pair-events [data-side="baseline"][data-event-id]', { timeout: 25000 });
  const baselineEvent = await page.$eval('.custom-pair-events [data-side="baseline"][data-event-id]', (n) => n.getAttribute("data-event-id") ?? "");
  await page.click('.custom-pair-events [data-side="baseline"][data-event-id]');
  await page.waitForSelector('[data-testid="custom-reader"]', { timeout: 25000 });
  await waitIdle(400);
  const baselineReader = await page.evaluate(() => ({
    id: document.querySelector('[data-testid="custom-reader"] .custom-msg-meta .mono')?.textContent?.trim() ?? "",
    owner: document.querySelector('[data-testid="custom-event-owner"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
  }));
  const baselineEventApi = await apiGet(`/api/events/${encodeURIComponent(baselineEvent)}?dataset=CUSTOM`);
  check("J-CUSTOM-04 对照侧事件 owner 标明正常对照，正文 ID=所点事件且属于 baseline，当前运行不被改写", () => {
    assert.ok(baselineEvent, "对照侧没有可点的真实事件");
    assert.equal(baselineReader.id, baselineEvent, `${baselineReader.id} vs ${baselineEvent}`);
    assert.equal(baselineEventApi.run_id, KNOWN.bypassBaseline, JSON.stringify(baselineEventApi.run_id));
    assert.ok(baselineReader.owner.includes("正常对照"), baselineReader.owner);
    assert.ok(!baselineReader.chip.includes(KNOWN.bypassBaseline), `对象 chip 被改成 baseline：${baselineReader.chip}`);
  }, { baselineEvent, baselineReader, baselineEventRun: baselineEventApi.run_id });

  // 保存配对案例 → 导出 → 恢复：两侧各固定一条由 UI 打开的真实证据。
  const customSupport = () => page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid="custom-reader"] .custom-msg-actions .btn')].find((b) => b.textContent?.trim() === "支持");
    btn?.click();
    return !!btn;
  });
  const baselineSupport = await customSupport();
  // 回到当前侧结果事件（真实 UI 点击展开 run 侧事件并打开），再固定一条。
  await page.evaluate(() => {
    const track = document.querySelector('.custom-pair-row[data-stage-key="result"] .custom-track[data-side="run"]');
    track?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector('.custom-pair-events [data-side="run"][data-event-id]', { timeout: 25000 });
  await page.click(`.custom-pair-events [data-side="run"][data-event-id="${KNOWN.bypassResult}"]`);
  await page.waitForFunction(
    (id) => document.querySelector('[data-testid="custom-reader"] .custom-msg-meta .mono')?.textContent?.trim() === id,
    { timeout: 25000 },
    KNOWN.bypassResult,
  );
  const currentReaderAgain = await page.evaluate(() => ({
    id: document.querySelector('[data-testid="custom-reader"] .custom-msg-meta .mono')?.textContent?.trim() ?? "",
    owner: document.querySelector('[data-testid="custom-event-owner"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  const currentSupport = await customSupport();
  await drawerTab("证据篮");
  const customBasket = await page.evaluate(() => [...document.querySelectorAll(".basket .trace-list li")].map((li) => ({
    role: li.querySelector(".role-chip")?.textContent?.trim() ?? "",
    id: li.querySelector(".mono")?.textContent?.trim() ?? "",
  })));
  check("J-CUSTOM-04b 配对两侧各固定一条证据（当前侧结果 + 正常对照结果），均由阅读区“支持”动作产生", () => {
    assert.equal(baselineSupport, true, "对照侧阅读区缺少“支持”");
    assert.equal(currentSupport, true, "当前侧阅读区缺少“支持”");
    assert.equal(currentReaderAgain.id, KNOWN.bypassResult, JSON.stringify(currentReaderAgain));
    assert.ok(currentReaderAgain.owner.includes("当前运行"), currentReaderAgain.owner);
    assert.equal(customBasket.length, 2, JSON.stringify(customBasket));
    const ids = customBasket.map((b) => `${b.role}:${b.id}`).sort();
    assert.deepEqual(ids, [`支持:${KNOWN.bypassResult}`, `支持:${baselineEvent}`].sort(), JSON.stringify(customBasket));
  }, { baselineSupport, currentSupport, currentReaderAgain, customBasket });
  const customTitle = `F4 J-CUSTOM 配对 ${Date.now()}`;
  const customCase = await saveCase(customTitle);
  const customSaved = await apiGet(`/api/cases/${encodeURIComponent(customCase.case_id)}`);
  const customSnap = customSaved.snapshot ?? {};
  await saveFinding(
    "审批绕过运行在审核阶段无记录但发布成功，正常对照有有效审核",
    `配对 ${KNOWN.bypassRun} ↔ ${KNOWN.bypassBaseline} 的审核/发布阶段证据可分别回查。`,
    "阶段无记录只表示日志未收录，不等于绝对没有发生。",
  );
  const customMd = await exportCase(customCase.case_id, "md");
  const customJson = await exportCase(customCase.case_id, "json");
  const customExport = JSON.parse(customJson.text);
  const customExportEv = customExport.findings?.[0]?.evidence ?? [];
  const customSelectionApi = await apiGet(`/api/events/${encodeURIComponent(KNOWN.bypassResult)}?dataset=CUSTOM`);
  const customEvidence = {
    case_id: customCase.case_id,
    trace: customSnap.trace_object,
    comparison: customSnap.comparison,
    selection: customSnap.selection,
    reader: currentReaderAgain,
    pinned: (customSnap.pinned_evidence ?? []).map(pinnedKey),
    basket: customBasket.map(pinnedKey),
    exportSelection: customExport.snapshot?.selection ?? null,
    exportPinned: (customExport.snapshot?.pinned_evidence ?? []).map(pinnedKey),
    exportEvidence: customExportEv.map((e) => ({ id: e.reference_id, role: e.role, resolved: e.resolved?.event_id ?? null })),
    mdHas: { run: customMd.text.includes(KNOWN.bypassRun), baseline: customMd.text.includes(KNOWN.bypassBaseline), version: customMd.text.includes(customSaved.data_version.slice(0, 12)) },
  };
  check("J-CUSTOM-05 快照与导出一致：selection=当前 reader(含真实 time_us)、双方证据集合、run/baseline、数据版本", () => {
    assert.equal(customSnap.trace_object?.runId, KNOWN.bypassRun, JSON.stringify(customSnap.trace_object));
    assert.equal(customSnap.comparison?.kind, "runPair", JSON.stringify(customSnap.comparison));
    assert.equal(customSnap.comparison?.runId, KNOWN.bypassRun);
    assert.equal(customSnap.comparison?.baselineRunId, KNOWN.bypassBaseline);
    assert.equal(customSnap.selection?.id, KNOWN.bypassResult, `${customSnap.selection?.id} vs ${KNOWN.bypassResult}`);
    assert.equal(customSnap.selection?.timeUs, customSelectionApi.time_us, `${customSnap.selection?.timeUs} vs ${customSelectionApi.time_us}`);
    assert.deepEqual(customEvidence.pinned.slice().sort(), customEvidence.basket.slice().sort(), JSON.stringify(customEvidence));
    assert.equal(customExport.case_id, customCase.case_id);
    assert.deepEqual(customEvidence.exportPinned.slice().sort(), customEvidence.pinned.slice().sort());
    assert.equal(customExport.snapshot?.selection?.id, KNOWN.bypassResult);
    assert.equal(customExport.snapshot?.comparison?.baselineRunId, KNOWN.bypassBaseline);
    assert.equal(customExport.data_version, customSaved.data_version);
    assert.equal(customExportEv.length, 2, JSON.stringify(customExportEv));
    const exportIds = customExportEv.map((e) => `${e.role}:${e.reference_id}`).sort();
    assert.deepEqual(exportIds, [`support:${KNOWN.bypassResult}`, `support:${baselineEvent}`].sort(), JSON.stringify(exportIds));
    assert.ok(customExportEv.every((e) => e.resolved?.event_id === e.reference_id), JSON.stringify(customExportEv));
    assert.equal(customExport.summary?.support, 2, JSON.stringify(customExport.summary));
    assert.ok(customEvidence.mdHas.run && customEvidence.mdHas.baseline && customEvidence.mdHas.version, JSON.stringify(customEvidence.mdHas));
  }, customEvidence);
  await shot("j-custom-03-pair-saved");

  // 恢复与重复恢复：配对回到两次完整运行，回放不生效。
  await closeDrawer();
  await restoreFromBasket(customCase.case_id);
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 25000 });
  await waitIdle(500);
  const restoredPair = await page.evaluate(() => ({
    rows: document.querySelectorAll(".custom-pair-row").length,
    context: document.querySelector('[data-testid="custom-context"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
  }));
  const playingPair = await playing();
  const waitCustomReader = async (id) => {
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid="custom-reader"] .custom-msg-meta .mono')?.textContent?.trim() === want,
      { timeout: 25000 },
      id,
    );
    return page.evaluate(() => ({
      id: document.querySelector('[data-testid="custom-reader"] .custom-msg-meta .mono')?.textContent?.trim() ?? "",
      owner: document.querySelector('[data-testid="custom-event-owner"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
    }));
  };
  const restoredReader = await waitCustomReader(KNOWN.bypassResult);
  await closeDrawer();
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="custom-reader"] .custom-detail-actions .btn')].at(-1)?.click());
  await sleep(400);
  const customReaderClosed = await page.evaluate(() => document.querySelectorAll('[data-testid="custom-reader"]').length);
  await restoreFromBasket(customCase.case_id);
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 25000 });
  const repeatedReader = await waitCustomReader(KNOWN.bypassResult);
  const restoredAgain = await page.evaluate(() => document.querySelectorAll(".custom-pair-row").length);
  check("J-CUSTOM-06 配对恢复/重复恢复回到两次完整运行：正文=快照 selection、owner=当前运行、标注回放不生效且暂停", () => {
    assert.equal(restoredPair.rows, 7, JSON.stringify(restoredPair));
    assert.ok(restoredPair.context.includes("配对=完整运行"), restoredPair.context);
    assert.equal(playingPair, "开始回放", playingPair);
    assert.equal(restoredReader.id, KNOWN.bypassResult, JSON.stringify(restoredReader));
    assert.ok(restoredReader.owner.includes("当前运行"), restoredReader.owner);
    assert.ok(!restoredReader.chip.includes(KNOWN.bypassBaseline), restoredReader.chip);
    assert.equal(customReaderClosed, 0, `关闭后仍残留正文 ${customReaderClosed}`);
    assert.equal(repeatedReader.id, KNOWN.bypassResult, JSON.stringify(repeatedReader));
    assert.equal(restoredAgain, 7, `重复恢复行数 ${restoredAgain}`);
  }, { restoredPair, playingPair, restoredReader, customReaderClosed, repeatedReader, restoredAgain });
  await shot("j-custom-04-restored-pair");

  // 隐藏运行流程 → 配对 → 两个“返回运行”入口；概览隐藏不重开。
  const toggleChart = async (label, on = false) => {
    await page.evaluate((text, want) => {
      const toggle = [...document.querySelectorAll(".custom-toggle")].find((b) => b.textContent?.trim() === text);
      if (!toggle) return;
      const pressed = toggle.getAttribute("aria-pressed") === "true";
      if (pressed !== want) toggle.click();
    }, label, on);
    await sleep(350);
  };
  // 入口 A：配对图的“返回运行”
  await toggleChart("运行流程", false);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid="custom-pair"] .custom-card-actions .btn')].find((b) => b.textContent?.trim() === "返回运行");
    btn?.click();
  });
  await waitIdle(600);
  const backA = await page.evaluate(() => ({
    run: !!document.querySelector('[data-testid="custom-run"]'),
    flowPressed: [...document.querySelectorAll(".custom-toggle")].find((b) => b.textContent?.trim() === "运行流程")?.getAttribute("aria-pressed"),
    chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
  }));
  // 入口 B：配对已隐藏时的提示卡“返回运行”（隐藏流程后从冻结案例重新进配对）
  await toggleChart("运行流程", false);
  await page.click(`.custom-case-chip[data-case-id="${KNOWN.customBypassCase}"]`);
  await page.waitForSelector('[data-testid="custom-pair"]', { timeout: 25000 });
  await page.waitForSelector(".custom-pair-row", { timeout: 25000 });
  await toggleChart("配对", false);
  await page.waitForSelector('[data-testid="custom-hidden-pair"]', { timeout: 20000 });
  await clickText('[data-testid="custom-hidden-pair"] .btn', "返回运行");
  await waitIdle(600);
  const backB = await page.evaluate(() => ({
    run: !!document.querySelector('[data-testid="custom-run"]'),
    hiddenPair: !!document.querySelector('[data-testid="custom-hidden-pair"]'),
    flowPressed: [...document.querySelectorAll(".custom-toggle")].find((b) => b.textContent?.trim() === "运行流程")?.getAttribute("aria-pressed"),
    chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
  }));
  check("J-CUSTOM-07 隐藏运行流程后两个“返回运行”入口都能展开流程，chip 不变", () => {
    assert.equal(backA.run, true, JSON.stringify(backA));
    assert.equal(backA.flowPressed, "true", JSON.stringify(backA));
    assert.equal(backB.run, true, JSON.stringify(backB));
    assert.equal(backB.hiddenPair, false, JSON.stringify(backB));
    assert.equal(backA.chip, backB.chip, `${backA.chip} vs ${backB.chip}`);
  }, { backA, backB });
  await shot("j-custom-05-back-to-run");

  // 旧版两种结果 + 重复交接：语义分开。
  const staleChecks = [];
  for (const caseId of ["custom-stale-denied", "custom-stale-published", "custom-repeated-handoff"]) {
    await page.evaluate((id) => document.querySelector(`.custom-case-chip[data-case-id="${id}"]`)?.click(), caseId);
    await waitIdle(800);
    const state = await page.evaluate(() => ({
      chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
      detail: document.querySelector('[data-testid="custom-case-detail"]')?.textContent?.replace(/\s+/g, " ").trim().slice(0, 260) ?? "",
    }));
    const caseApi = await apiGet(`/api/cases/${caseId}?dataset=CUSTOM`);
    staleChecks.push({ caseId, state, status: caseApi.status ?? null, diffs: caseApi.diffs ?? [] });
  }
  const probeStale = await apiGet(`/api/runs?dataset=CUSTOM&include_stages=true&limit=200`);
  const staleRuns = probeStale.items.filter((r) => r.scenario === "stale_version");
  const denied = staleRuns.filter((r) => (r.audit?.published_stale ?? 0) === 0);
  const published = staleRuns.filter((r) => (r.audit?.published_stale ?? 0) > 0);
  check("J-CUSTOM-08 旧版被拒绝/被发布、重复交接三条案例保持真实且语义分开", () => {
    assert.ok(denied.length >= 1, `没有 published_stale=0 的旧版运行：${staleRuns.length}`);
    assert.ok(published.length >= 1, `没有 published_stale=1 的旧版运行：${staleRuns.length}`);
    assert.ok(staleChecks.every((c) => c.state.detail.length > 10), JSON.stringify(staleChecks.map((c) => c.caseId)));
    assert.ok(staleChecks[2].state.detail.includes("转交") || staleChecks[2].state.chip.length > 0, staleChecks[2].state.detail);
  }, { staleChecks: staleChecks.map((c) => ({ caseId: c.caseId, chip: c.state.chip, detail: c.state.detail.slice(0, 80) })),
    deniedRuns: denied.length, publishedRuns: published.length, staleRuns: staleRuns.length });
  await shot("j-custom-06-stale-cases");

  // ================================================================ 跨集与共用状态
  currentJourney = "CROSS";
  const cross = await newContext("cross");
  await cross.goto(`${base}/?theme=light`, { waitUntil: "networkidle2" });
  await sleep(1200);

  const crossTrace = [];
  for (const id of ["MC1", "MC2", "CUSTOM", "MC1"]) {
    await selectDataset(id);
    const snapshot = await cross.evaluate(() => ({
      dataset: document.querySelector(".dataset-field select")?.value ?? "",
      readers: document.querySelectorAll(".mc1-reader, [data-testid$='-reader'], [data-testid='mc2-event-detail'], [data-testid='mc2-file-detail']").length,
      page: ["mc1-page", "mc2-page", "custom-page"].filter((t) => document.querySelector(`[data-testid="${t}"]`)).join(","),
      playing: document.querySelector(".timebrush .btn-icon")?.getAttribute("aria-label"),
      chip: document.querySelector('[data-testid="custom-object-chip"]')?.textContent?.trim() ?? "",
    }));
    crossTrace.push({ id, ...snapshot });
  }
  check("CROSS-01 MC1→MC2→CUSTOM→MC1 不串 reader/链根/运行配对，切集后暂停", () => {
    for (const step of crossTrace) {
      assert.equal(step.dataset, step.id, JSON.stringify(step));
      assert.equal(step.readers, 0, `换集后残留阅读区：${JSON.stringify(step)}`);
      assert.equal(step.playing, "开始回放", `换集后未暂停：${JSON.stringify(step)}`);
      const expected = step.id === "MC1" ? "mc1-page" : step.id === "MC2" ? "mc2-page" : "custom-page";
      assert.equal(step.page, expected, JSON.stringify(step));
    }
  }, { crossTrace });
  await shot("cross-01-loop");

  // 布局偏好按数据集记忆，损坏偏好安全回退（原 check_s1 的业务断言迁移）。
  await cross.evaluate(() => {
    localStorage.setItem("mas-workspace.MC1.layout", JSON.stringify({ version: 1, evidenceOpen: true, evidenceSize: 420 }));
    localStorage.setItem("mas-workspace.MC2.layout", JSON.stringify({ version: 1, evidenceOpen: false, evidenceSize: 392 }));
    localStorage.setItem("mas-workspace.CUSTOM.layout", "{broken");
  });
  await selectDataset("MC1");
  await cross.reload({ waitUntil: "networkidle2" });
  await sleep(1200);
  await selectDataset("MC1");
  const mc1Dock = await cross.evaluate(() => ({ dock: !!document.querySelector(".evidence-dock"), dataset: document.querySelector(".dataset-field select")?.value }));
  await selectDataset("MC2");
  const mc2Dock = await cross.evaluate(() => !!document.querySelector(".evidence-dock"));
  await selectDataset("CUSTOM");
  const customDock = await cross.evaluate(() => !!document.querySelector(".evidence-dock"));
  check("CROSS-02 布局偏好按数据集记忆且损坏偏好安全回退关闭（不串到其它数据集）", () => {
    assert.equal(mc1Dock.dock, true, JSON.stringify(mc1Dock));
    assert.equal(mc2Dock, false, "MC2 不应继承 MC1 的证据抽屉偏好");
    assert.equal(customDock, false, "损坏偏好应安全回退关闭");
  }, { mc1Dock, mc2Dock, customDock });

  // 抽屉关闭回焦到“证据”触发控件（原 check_s1 的焦点断言迁移）。
  await selectDataset("MC2");
  await cross.evaluate(() => localStorage.clear());
  await cross.reload({ waitUntil: "networkidle2" });
  await sleep(1000);
  await cross.click(".topbar-docks button");
  await cross.waitForSelector(".drawer");
  await cross.evaluate(() => [...document.querySelectorAll(".drawer-head .btn")].at(-1)?.click());
  await sleep(300);
  const focusBack = await cross.evaluate(() => ({
    tag: document.activeElement?.tagName ?? "",
    text: document.activeElement?.textContent?.trim() ?? "",
    drawer: !!document.querySelector(".drawer"),
  }));
  check("CROSS-03 关闭证据抽屉后焦点回到“证据”触发控件", () => {
    assert.equal(focusBack.drawer, false, JSON.stringify(focusBack));
    assert.equal(focusBack.text, "证据", JSON.stringify(focusBack));
  }, { focusBack });
  await cross.screenshot({ path: path.join(out, "cross-02-drawer-focus.png") });

  // 受控失败 A（旧 check_s1 的“案例保存失败→离开→返回”路径）：标题草稿必须留在原位。
  await cross.setRequestInterception(true);
  const caseFailure = { used: false };
  intentionalFragments.push("HTTP 503 /api/cases (POST)");
  const caseInterceptor = (req) => {
    const url = new URL(req.url());
    if (!caseFailure.used && req.method() === "POST" && url.pathname === "/api/cases") {
      caseFailure.used = true;
      void req.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "F4 受控失败：案例保存" }) });
      return;
    }
    void req.continue();
  };
  cross.on("request", caseInterceptor);
  await drawerTab("证据篮");
  await cross.waitForSelector(".basket");
  if (await cross.$(".basket > .callout .mono")) await clickText(".basket .btn", "取消关联");
  await cross.waitForSelector('.basket input[placeholder="案例标题"]');
  const caseTitleDraft = `F4 CROSS 案例草稿 ${Date.now()}`;
  await cross.click('.basket input[placeholder="案例标题"]');
  await cross.type('.basket input[placeholder="案例标题"]', caseTitleDraft);
  const caseFailWaiter = cross.waitForResponse((r) => new URL(r.url()).pathname === "/api/cases" && r.request().method() === "POST", { timeout: 30000 });
  await clickText(".basket .btn", "保存当前案例");
  const caseFailRes = await caseFailWaiter;
  const caseFailBody = await caseFailRes.json().catch(() => ({}));
  // 失败提示夹在静态说明之间：先排除两条固定文案，再取剩余的非空提示。
  // 只取 .basket 的直接子段落：静态说明在 .callout 内，失败提示与页脚提示是直接子段落。
  const caseFailMessages = await cross.evaluate(() => [...document.querySelectorAll(".basket > p.muted.small")]
    .map((n) => n.textContent?.trim() ?? "")
    .filter((text) => text && !text.startsWith("在「消息」页") && !text.startsWith("保存案例时会一并记下")));
  const caseFailMessage = caseFailMessages[0] ?? "";
  // 离开：切页签 → 关/开抽屉 → 切集再回来（全部真实 UI 操作）。
  await clickText(".tabs .tab", "关联");
  await sleep(350);
  await drawerTab("证据篮");
  await closeDrawer();
  await drawerTab("证据篮");
  await selectDataset("CUSTOM");
  await selectDataset("MC2");
  await drawerTab("证据篮");
  await cross.waitForSelector('.basket input[placeholder="案例标题"]');
  const caseTitleAfterLeave = await cross.$eval('.basket input[placeholder="案例标题"]', (n) => n.value);
  cross.off("request", caseInterceptor);
  await cross.setRequestInterception(false);
  const caseRetryWaiter = cross.waitForResponse((r) => new URL(r.url()).pathname === "/api/cases" && r.request().method() === "POST", { timeout: 30000 });
  await clickText(".basket .btn", "保存当前案例");
  const caseRetryRes = await caseRetryWaiter;
  const caseRetryBody = await caseRetryRes.json();
  if (caseRetryRes.status() < 300) {
    createdCases.push(caseRetryBody.case_id);
    persist();
  }
  check("CROSS-04a 案例保存受控 503：标题草稿经页签/抽屉/换集离开仍保留，撤销拦截后重试成功", () => {
    assert.equal(caseFailure.used, true, "503 没有注入到该次案例保存");
    assert.equal(caseFailRes.status(), 503, `注入响应 ${caseFailRes.status()} ${JSON.stringify(caseFailBody)}`);
    assert.ok(caseFailMessage, "保存失败后没有可见错误提示");
    assert.ok(!caseFailMessage.includes("加入证据篮"), `取到的不是失败提示：${caseFailMessage}`);
    assert.equal(caseTitleAfterLeave, caseTitleDraft, `离开返回后标题变成 ${JSON.stringify(caseTitleAfterLeave)}`);
    assert.ok(caseRetryRes.status() < 300, `重试 ${caseRetryRes.status()} ${JSON.stringify(caseRetryBody)}`);
    assert.equal(caseRetryBody.title, caseTitleDraft, JSON.stringify(caseRetryBody.title));
    assert.equal(caseRetryBody.dataset_id, "MC2", JSON.stringify(caseRetryBody.dataset_id));
  }, { caseTitleDraft, caseFailStatus: caseFailRes.status(), caseFailMessage, caseTitleAfterLeave, caseRetryStatus: caseRetryRes.status(), caseId: caseRetryBody.case_id });
  await cross.screenshot({ path: path.join(out, "cross-03-case-draft.png") });

  // 受控失败 B：结论草稿按案例隔离；A 的失败草稿离开/恢复仍在，B 不串 A 的内容。
  const caseA = caseRetryBody;
  await cross.waitForSelector(".basket .finding-form input.text-input");
  await cross.click(".basket .finding-form input.text-input");
  await cross.type(".basket .finding-form input.text-input", "受控失败后草稿应保留");
  await cross.type(".basket .finding-form textarea", "解释文本用于验证 503 后输入不丢");
  const findingAreas = await cross.$$(".basket .finding-form textarea");
  await findingAreas[1].type("局限文本也应保留");
  const findingFailure = { used: false };
  intentionalFragments.push("HTTP 503 /api/findings (POST)");
  const findingInterceptor = (req) => {
    const url = new URL(req.url());
    if (!findingFailure.used && req.method() === "POST" && url.pathname === "/api/findings") {
      findingFailure.used = true;
      void req.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "F4 受控失败：结论保存" }) });
      return;
    }
    void req.continue();
  };
  await cross.setRequestInterception(true);
  cross.on("request", findingInterceptor);
  const findingFailWaiter = cross.waitForResponse((r) => new URL(r.url()).pathname === "/api/findings" && r.request().method() === "POST", { timeout: 30000 });
  await clickText(".basket .finding-form .btn", "保存结论");
  const findingFailRes = await findingFailWaiter;
  const readDraft = () => cross.evaluate(() => ({
    claim: document.querySelector(".basket .finding-form input.text-input")?.value ?? "",
    explanation: document.querySelector(".basket .finding-form textarea")?.value ?? "",
    limitations: document.querySelectorAll(".basket .finding-form textarea")[1]?.value ?? "",
    messages: [...document.querySelectorAll(".basket > p.muted.small")]
      .map((n) => n.textContent?.trim() ?? "")
      .filter((text) => text && !text.startsWith("在「消息」页") && !text.startsWith("保存案例时会一并记下")),
  }));
  const draftAfterFail = await readDraft();
  await clickText(".tabs .tab", "关联");
  await sleep(300);
  await drawerTab("证据篮");
  await closeDrawer();
  await drawerTab("证据篮");
  await cross.waitForSelector(".basket .finding-form input.text-input");
  const draftAfterLeave = await readDraft();
  // 切到另一个案例 B：草稿按案例隔离，B 不应显示 A 的内容。
  await clickText(".basket .btn", "取消关联");
  await cross.waitForSelector('.basket input[placeholder="案例标题"]');
  const caseBTitle = `F4 CROSS 对照案例 ${Date.now()}`;
  await cross.click('.basket input[placeholder="案例标题"]');
  await cross.type('.basket input[placeholder="案例标题"]', caseBTitle);
  const caseBWwaiter = cross.waitForResponse((r) => new URL(r.url()).pathname === "/api/cases" && r.request().method() === "POST", { timeout: 30000 });
  await clickText(".basket .btn", "保存当前案例");
  const caseBRes = await caseBWwaiter;
  const caseBBody = await caseBRes.json();
  assert.ok(caseBRes.status() < 300, `保存案例 B 失败 ${caseBRes.status()}`);
  createdCases.push(caseBBody.case_id);
  persist();
  await cross.waitForFunction((id) => document.querySelector(".basket .callout .mono")?.textContent === id, { timeout: 20000 }, caseBBody.case_id);
  const draftInB = await readDraft();
  // 恢复 A：A 的失败草稿必须原样回来。
  await restoreFromBasket(caseA.case_id);
  await drawerTab("证据篮"); // 恢复会关闭抽屉（产品既有行为），重新打开同一页签再读草稿
  const draftInA = await readDraft();
  cross.off("request", findingInterceptor);
  await cross.setRequestInterception(false);
  const findingRetryWaiter = cross.waitForResponse((r) => new URL(r.url()).pathname === "/api/findings" && r.request().method() === "POST", { timeout: 30000 });
  await clickText(".basket .finding-form .btn", "保存结论");
  const findingRetryRes = await findingRetryWaiter;
  const findingRetryItem = await findingRetryRes.json();
  if (findingRetryRes.status() < 300) {
    createdFindings.push({ case_id: findingRetryItem.case_id, finding_id: findingRetryItem.finding_id });
    persist();
  }
  check("CROSS-04b 结论草稿按案例隔离：A 失败后离开/恢复仍在，B 不串 A 内容，重试落回 A", () => {
    assert.equal(findingFailure.used, true, "503 没有注入到该次结论保存");
    assert.equal(findingFailRes.status(), 503, `注入响应 ${findingFailRes.status()}`);
    assert.ok(draftAfterFail.messages.length > 0, `结论保存失败后没有可见错误提示：${JSON.stringify(draftAfterFail)}`);
    assert.equal(draftAfterFail.claim, "受控失败后草稿应保留");
    assert.equal(draftAfterLeave.claim, "受控失败后草稿应保留", JSON.stringify(draftAfterLeave));
    assert.equal(draftAfterLeave.explanation, draftAfterFail.explanation);
    assert.equal(draftAfterLeave.limitations, "局限文本也应保留");
    assert.equal(draftInB.claim, "", `B 串入了 A 的草稿：${JSON.stringify(draftInB)}`);
    assert.equal(draftInB.explanation, "");
    assert.equal(draftInA.claim, "受控失败后草稿应保留", JSON.stringify(draftInA));
    assert.equal(draftInA.explanation, draftAfterFail.explanation);
    assert.equal(draftInA.limitations, "局限文本也应保留");
    assert.ok(findingRetryRes.status() < 300, `重试 ${findingRetryRes.status()}`);
    assert.equal(findingRetryItem.case_id, caseA.case_id, `${findingRetryItem.case_id} vs ${caseA.case_id}`);
    assert.equal(findingRetryItem.claim, "受控失败后草稿应保留");
  }, { caseA: caseA.case_id, caseB: caseBBody.case_id, draftAfterFail, draftAfterLeave, draftInB, draftInA, retryStatus: findingRetryRes.status(), intentionalCount: intentional.length });
  await cross.screenshot({ path: path.join(out, "cross-03-controlled-failure.png") });

  // 键盘：Tab 到图形、Enter 打开、Escape 关闭并回焦；输入关键词不被全局快捷键抢走。
  await selectDataset("MC1");
  await page.waitForSelector(".mc1-heat-cell:not(.is-empty)", { timeout: 30000 });
  const keyboardRun = await page.evaluate(() => {
    const cell = document.querySelector(".mc1-heat-cell:not(.is-empty)");
    cell?.focus();
    return cell?.getAttribute("data-cell-key") ?? "";
  });
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="mc1-cell-detail"]', { timeout: 25000 });
  const keyboardOpen = await page.evaluate(() => ({
    readers: document.querySelectorAll(".mc1-reader").length,
    focusedKey: document.activeElement?.getAttribute("data-cell-key") ?? "",
  }));
  await page.keyboard.press("Escape");
  await sleep(400);
  const keyboardClose = await page.evaluate(() => ({
    readers: document.querySelectorAll(".mc1-reader").length,
    focusedKey: document.activeElement?.getAttribute("data-cell-key") ?? "",
    tag: document.activeElement?.tagName ?? "",
  }));
  const keywordInput = '.topbar input[type="search"]';
  await page.click(keywordInput);
  await page.type(keywordInput, "abc");
  await page.keyboard.press("ArrowDown");
  await sleep(200);
  const keywordState = await page.evaluate((sel) => ({
    value: document.querySelector(sel)?.value ?? "",
    active: document.activeElement === document.querySelector(sel),
  }), keywordInput);
  await page.evaluate((sel) => {
    const input = document.querySelector(sel);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, keywordInput);
  check("CROSS-06 键盘：Enter 打开图形对象、Escape 关闭并回焦原格，输入关键词不被全局键抢走", () => {
    assert.ok(keyboardRun, "没有可聚焦的热力格");
    assert.equal(keyboardOpen.readers, 1, JSON.stringify(keyboardOpen));
    assert.equal(keyboardOpen.focusedKey, keyboardRun, JSON.stringify(keyboardOpen));
    assert.equal(keyboardClose.readers, 0, JSON.stringify(keyboardClose));
    assert.equal(keyboardClose.focusedKey, keyboardRun, JSON.stringify(keyboardClose));
    assert.equal(keywordState.value, "abc", JSON.stringify(keywordState));
    assert.equal(keywordState.active, true, JSON.stringify(keywordState));
  }, { keyboardRun, keyboardOpen, keyboardClose, keywordState });
  await page.screenshot({ path: path.join(out, "cross-04-keyboard.png") });

  // ================================================================ 固定视口与截图矩阵
  currentJourney = "SHOTS";
  const shotsDir = path.join(out, "screenshots");
  fs.mkdirSync(shotsDir, { recursive: true });
  const shotIndex = [];
  const combos = [
    { w: 1600, h: 1000, theme: "light", parts: ["default", "reader", "compare"] },
    { w: 1600, h: 1000, theme: "dark", parts: ["default", "reader"] },
    { w: 1366, h: 768, theme: "light", parts: ["default", "reader"] },
    { w: 1024, h: 768, theme: "light", parts: ["default", "reader"] },
    { w: 390, h: 844, theme: "light", parts: ["default", "reader"] },
    { w: 390, h: 844, theme: "dark", parts: ["reader"] },
  ];
  const waitDefault = {
    MC1: async () => {
      await page.waitForSelector('[data-testid="mc1-page"]', { timeout: 30000 });
      await page.waitForSelector(".mc1-heat-cell", { timeout: 30000 });
      await waitIdle(400);
    },
    MC2: async () => {
      await page.waitForSelector('[data-testid="mc2-trace-card"]', { timeout: 30000 });
      await waitIdle(400);
    },
    CUSTOM: async () => {
      await page.waitForSelector('[data-testid="custom-overview"]', { timeout: 30000 });
      await page.waitForFunction(() => document.querySelectorAll(".custom-overview-body").length > 0, { timeout: 30000 });
      await waitIdle(400);
    },
  };
  const openReaderView = {
    MC1: async () => {
      const key = await page.evaluate(() => {
        const cells = [...document.querySelectorAll(".mc1-heat-cell:not(.is-empty)")];
        const target = cells[Math.floor(cells.length / 2)] ?? cells[0];
        target?.click();
        return target?.getAttribute("data-cell-key") ?? "";
      });
      await page.waitForSelector('[data-testid="mc1-cell-detail"] .mc1-msg-list', { timeout: 25000 });
      await waitIdle(300);
      return key;
    },
    MC2: async () => {
      await page.click('[data-testid="mc2-target-post"]');
      await page.waitForSelector(".mc2-root-event", { timeout: 25000 });
      await waitIdle(500);
      await page.click(".mc2-root-event");
      await page.waitForSelector('[data-testid="mc2-event-detail"] .mc2-msg-meta', { timeout: 25000 });
      await waitIdle(300);
      return await page.$eval('[data-testid="mc2-event-detail"] .mc2-msg-meta .mono', (n) => n.textContent?.trim() ?? "");
    },
    CUSTOM: async () => {
      await page.click(`.custom-case-chip[data-case-id="${KNOWN.customBypassCase}"]`);
      await page.waitForSelector('[data-testid="custom-case-detail"] [data-event-id]', { timeout: 25000 });
      const id = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="custom-case-detail"] [data-event-id]');
        const value = btn?.getAttribute("data-event-id") ?? "";
        (btn instanceof HTMLElement ? btn : null)?.click();
        return value;
      });
      await page.waitForSelector('[data-testid="custom-reader"] .custom-msg-meta', { timeout: 25000 });
      await waitIdle(300);
      return id;
    },
  };
  const openCompareView = {
    MC1: async () => {
      await page.evaluate(() => document.querySelector(".mc1-edge-hit")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await page.waitForSelector('.mc1-reader[aria-label="回复边证据"]', { timeout: 25000 });
      await waitIdle(300);
      return await page.$eval('.mc1-reader[aria-label="回复边证据"] .mc1-reader-title strong', (n) => n.textContent?.trim() ?? "");
    },
    MC2: async () => {
      await page.evaluate(() => document.querySelector(".mc2-tools")?.setAttribute("open", ""));
      await clickText(".mc2-tools-menu button", "历史实例");
      await page.waitForSelector('[aria-label="历史实例阶段对齐"] .pattern-table', { timeout: 30000 });
      await waitIdle(300);
      return await page.evaluate(() => `${document.querySelectorAll('[aria-label="历史实例阶段对齐"] .pattern-table thead th').length - 1} 条链`);
    },
    CUSTOM: async () => {
      await page.click(`.custom-case-chip[data-case-id="${KNOWN.customBypassCase}"]`);
      await page.waitForSelector('[data-testid="custom-pair"] .custom-pair-row', { timeout: 30000 });
      await waitIdle(400);
      return await page.$eval('[data-testid="custom-pair"] .custom-card-head p', (n) => n.textContent?.replace(/\s+/g, " ").trim() ?? "");
    },
  };
  const geometry = () => page.evaluate(() => {
    const doc = document.documentElement;
    const canvas = document.querySelector(".canvas-area")?.getBoundingClientRect() ?? null;
    const reader = document.querySelector(
      '[data-testid="mc1-cell-detail"], [data-testid="mc1-event-detail"], .mc1-reader, [data-testid="mc2-event-detail"], [data-testid="mc2-file-detail"], [data-testid="custom-reader"]',
    );
    let close = null;
    let bodyVisiblePx = null;
    if (reader) {
      const head = reader.querySelector(".mc1-detail-head, .mc2-detail-head, .custom-detail-actions, .mc1-reader-title")?.getBoundingClientRect();
      const box = reader.getBoundingClientRect();
      const top = head ? Math.max(box.top, head.bottom) : box.top;
      bodyVisiblePx = Math.round(Math.max(0, Math.min(box.bottom, innerHeight) - top));
      const btn = [...reader.querySelectorAll("button")].find((b) => b.textContent?.trim() === "关闭");
      if (btn) {
        const rect = btn.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        close = {
          rect: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) },
          insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
          insideCanvas: canvas ? rect.left >= canvas.left - 1 && rect.right <= canvas.right + 1 && rect.top >= canvas.top - 1 && rect.bottom <= canvas.bottom + 1 : null,
          hitSelf: !!hit && (hit === btn || btn.contains(hit)),
        };
      }
    }
    const scrollables = [...document.querySelectorAll(".mc1-heat-scroll, .mc1-track-scroll, .pattern-scroll, .custom-overview, .custom-pair-grid, .trace-body, .stream-list")]
      .map((node) => ({ cls: (node.className || "").toString().split(" ")[0], scrollW: node.scrollWidth, clientW: node.clientWidth }))
      .filter((item) => item.scrollW > item.clientW + 1)
      .slice(0, 4);
    return { scrollWidth: doc.scrollWidth, innerWidth, bodyScroll: document.body.scrollWidth, close, bodyVisiblePx, scrollables };
  });

  const shotPage = await newContext("shots");
  await shotPage.setViewport({ width: 1600, height: 1000 });
  page = shotPage;
  const perDataset = { MC1: [], MC2: [], CUSTOM: [] };
  for (const dataset of ["MC1", "MC2", "CUSTOM"]) {
    for (const combo of combos) {
      await page.setViewport({ width: combo.w, height: combo.h });
      await page.goto(`${base}/?theme=${combo.theme}`, { waitUntil: "networkidle2" });
      await sleep(800);
      await selectDataset(dataset);
      await waitDefault[dataset]();
      for (const part of combo.parts) {
        let object = "";
        if (part === "reader") object = await openReaderView[dataset]();
        if (part === "compare") object = await openCompareView[dataset]();
        const file = `${dataset.toLowerCase()}-${combo.w}x${combo.h}-${combo.theme}-${part}.png`;
        // 真实操作：像用户一样在 .canvas-area 内滚动到阅读区/对照区，再截图与量几何。
        // 页面自身的定位动画（约 420ms settle）可能把滚动改回去，因此滚动到稳定为止再截图。
        await sleep(1500);
        // 目标按“阅读区优先、其次对照区”显式挑选：不能用逗号选择器整体 querySelector，
        // 否则文档顺序靠前的对照卡片会抢走滚动目标（1024 下会把阅读区留在折叠下方）。
        const pickScrollTarget = () => page.evaluate(() => {
          const candidates = [
            document.querySelector('[data-testid="mc1-cell-detail"]'),
            document.querySelector('[data-testid="mc1-event-detail"]'),
            document.querySelector('[data-testid="mc2-event-detail"]'),
            document.querySelector('[data-testid="custom-reader"]'),
            document.querySelector(".mc1-reader"),
            document.querySelector('[data-testid="custom-pair"] .custom-pair-grid'),
            document.querySelector('[aria-label="历史实例阶段对齐"] .pattern-table'),
          ];
          const target = candidates.find(Boolean) ?? null;
          if (!target) return true;
          const box = document.querySelector(".canvas-area")?.getBoundingClientRect();
          if (!box) return true;
          const rect = target.getBoundingClientRect();
          return rect.top >= box.top - 4 && rect.top <= box.bottom - 160;
        });
        const scrollTargetToTop = () => page.evaluate(() => {
          const candidates = [
            document.querySelector('[data-testid="mc1-cell-detail"]'),
            document.querySelector('[data-testid="mc1-event-detail"]'),
            document.querySelector('[data-testid="mc2-event-detail"]'),
            document.querySelector('[data-testid="custom-reader"]'),
            document.querySelector(".mc1-reader"),
            document.querySelector('[data-testid="custom-pair"] .custom-pair-grid'),
            document.querySelector('[aria-label="历史实例阶段对齐"] .pattern-table'),
          ];
          const target = candidates.find(Boolean) ?? null;
          const area = document.querySelector(".canvas-area");
          if (!target || !area) return;
          area.scrollTop += target.getBoundingClientRect().top - area.getBoundingClientRect().top - 8;
        });
        for (let attempt = 0; attempt < 6; attempt += 1) {
          if (await pickScrollTarget()) break;
          await scrollTargetToTop();
          await sleep(300);
        }
        // 页面自身的定位动画可能再次改回滚动；用真实滚轮兜底（用户实际能做的动作），不写死状态。
        if (!(await pickScrollTarget())) {
          const point = await page.evaluate(() => {
            const box = document.querySelector(".canvas-area")?.getBoundingClientRect();
            return box ? { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } : null;
          });
          if (point) {
            await page.mouse.move(point.x, point.y);
            for (let step = 0; step < 12 && !(await pickScrollTarget()); step += 1) {
              await page.mouse.wheel({ deltaY: 400 });
              await sleep(320);
            }
          }
        }
        await page.screenshot({ path: path.join(shotsDir, file) });
        const geo = await geometry();
        const scrollDiag = await page.evaluate(() => {
          const area = document.querySelector(".canvas-area");
          const reader = document.querySelector('[data-testid="custom-reader"], .mc1-reader, [data-testid="mc2-event-detail"]');
          const aside = document.querySelector(".custom-aside");
          const asides = aside ? { position: getComputedStyle(aside).position, maxHeight: getComputedStyle(aside).maxHeight } : null;
          return {
            scrollTop: area ? Math.round(area.scrollTop) : null,
            scrollHeight: area?.scrollHeight ?? null,
            clientHeight: area?.clientHeight ?? null,
            readerTop: reader ? Math.round(reader.getBoundingClientRect().top) : null,
            readerHeight: reader ? Math.round(reader.getBoundingClientRect().height) : null,
            readerOverflow: reader ? getComputedStyle(reader).overflowY : null,
            aside: asides,
            layout: (document.querySelector(".custom-layout")?.className ?? "").toString(),
          };
        });
        perDataset[dataset].push({ viewport: `${combo.w}x${combo.h}`, theme: combo.theme, part, file, object, geo, scrollDiag });
      }
    }
    const entries = perDataset[dataset];
    const overflow = entries.filter((entry) => entry.geo.scrollWidth > entry.geo.innerWidth + 1);
    const badClose = entries.filter((entry) => entry.geo.close && (!entry.geo.close.insideViewport || entry.geo.close.insideCanvas === false || !entry.geo.close.hitSelf));
    const thinBody = entries.filter((entry) => entry.geo.close && (entry.geo.bodyVisiblePx ?? 0) < 120);
    check(`SHOTS-${dataset} ${entries.length} 张固定视口截图：无页面横溢出，阅读区关闭按钮完整可见且命中，正文可读区≥120px`, () => {
      assert.ok(entries.length >= 11, `截图数 ${entries.length}`);
      assert.equal(overflow.length, 0, JSON.stringify(overflow.map((e) => [e.file, e.geo.scrollWidth, e.geo.innerWidth])));
      assert.equal(badClose.length, 0, JSON.stringify(badClose.map((e) => [e.file, e.geo.close])));
      assert.equal(thinBody.length, 0, JSON.stringify(thinBody.map((e) => [e.file, e.geo.bodyVisiblePx])));
      assert.ok(entries.filter((e) => e.geo.close).length >= 5, "阅读区截图不足");
      console.log(`  ${dataset} 截图 ${entries.length} 张；内部横滚容器 ${entries.reduce((n, e) => n + e.geo.scrollables.length, 0)} 处`);
    }, { entries: entries.map((e) => ({ file: e.file, object: e.object, scrollWidth: e.geo.scrollWidth, innerWidth: e.geo.innerWidth, close: e.geo.close, scrollables: e.geo.scrollables })) });
    shotIndex.push(...entries.map((entry) => ({ dataset, ...entry })));
  }
  fs.writeFileSync(path.join(shotsDir, "index.json"), JSON.stringify(shotIndex, null, 2));

  // ================================================================ 单用户前端时延（暖缓存）
  currentJourney = "PERF";
  page = await newContext("perf");
  await page.setViewport({ width: 1600, height: 1000 });
  const env = await page.evaluate(() => ({
    ua: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory ?? null,
  }));
  const perfRuns = [];
  /** 主图终点：真实数据节点出现（不是容器/骨架），用页面内 performance.now() 记时。 */
  const waitFigure = async (target) => {
    const handle = await page.waitForFunction((dataset) => {
      const t0 = window.__f4t0;
      if (typeof t0 !== "number") return false;
      const elapsed = () => Math.round(performance.now() - t0);
      if (dataset === "MC1") {
        const cells = document.querySelectorAll(".mc1-heat-cell");
        if (cells.length < 80) return false;
        const labelled = [...cells].filter((n) => (n.getAttribute("aria-label") ?? "").includes("公开")).length;
        if (labelled < 20) return false;
        if (!document.querySelector('[aria-label="事件轨"] [data-event-id], [aria-label="事件轨"] .mc1-track-dot')) return false;
        return elapsed();
      }
      if (dataset === "MC2") {
        const card = document.querySelector('[data-testid="mc2-trace-card"]');
        if (!card || card.querySelectorAll(".trace-item").length < 3) return false;
        return elapsed();
      }
      if (document.querySelectorAll(".custom-overview-body").length < 32) return false;
      if (document.querySelectorAll(".custom-stage-cell").length < 100) return false;
      return elapsed();
    }, { polling: "raf", timeout: 60000 }, target);
    return handle.jsonValue();
  };
  for (const dataset of ["MC1", "MC2", "CUSTOM"]) {
    // 准备（区间外）：先导航并切到另一个数据集，让计时只覆盖“切到目标数据集 → 主图数据出现”。
    const warmupTarget = dataset === "MC1" ? "MC2" : "MC1";
    await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle2" });
    await selectDataset(warmupTarget);
    await waitIdle(900);
    await page.evaluate(() => { window.__f4t0 = performance.now(); });
    await page.select(".dataset-field select", dataset);
    const mainFigureFromSwitchMs = await waitFigure(dataset);

    let clickToBodyMs = null;
    let object = "";
    let bodyApiId = "";
    if (dataset === "MC1") {
      // 准备（区间外）：点开一个真实热力格，等消息列表与详情容器就绪。
      await page.click(".mc1-heat-cell:not(.is-empty)");
      await page.waitForSelector('[data-testid="mc1-cell-detail"] .mc1-msg-head', { timeout: 30000 });
      await page.waitForSelector('[data-testid="mc1-cell-detail"] .mc1-msg-list > li', { timeout: 30000 });
      await waitIdle(700);
      await page.evaluate(() => { window.__f4t0 = performance.now(); });
      await page.click('[data-testid="mc1-cell-detail"] .mc1-msg-head');
      const handle = await page.waitForFunction(() => {
        const open = document.querySelector(".mc1-msg.is-open");
        if (!open) return false;
        if (!open.querySelector(".dual")) return false;             // 双声道正文
        if (!open.querySelector(".mc1-msg-raw")) return false;      // 原始 ID 与字段已载入
        const id = open.querySelector(".mc1-msg-raw dd.mono")?.textContent?.trim() ?? "";
        if (!id.startsWith("MC1:event:")) return false;
        return Math.round(performance.now() - window.__f4t0);
      }, { polling: "raf", timeout: 60000 });
      clickToBodyMs = await handle.jsonValue();
      const body = await page.evaluate(() => {
        const open = document.querySelector(".mc1-msg.is-open");
        return {
          id: open?.querySelector(".mc1-msg-raw dd.mono")?.textContent?.trim() ?? "",
          dualPanes: open?.querySelectorAll(".dual-body").length ?? 0,
          textLength: (open?.textContent ?? "").length,
        };
      });
      object = body.id;
      bodyApiId = (await apiGet(`/api/events/${encodeURIComponent(body.id)}?dataset=MC1`)).event_id;
      assert.ok(body.dualPanes >= 1, `MC1 正文没有双声道面板：${JSON.stringify(body)}`);
      perfRuns.push({ dataset, object, mainFigureFromSwitchMs, clickToBodyMs, body, bodyApiId });
      continue;
    }
    if (dataset === "MC2") {
      // 准备（区间外）：链根与根事件按钮已由 waitFigure 保证；先等链根选中状态稳定。
      await page.waitForSelector('[data-testid="mc2-trace-card"] .mc2-root-event', { timeout: 30000 });
      await waitIdle(500);
      await page.evaluate(() => { window.__f4t0 = performance.now(); });
      await page.click('[data-testid="mc2-trace-card"] .mc2-root-event');
      const handle = await page.waitForFunction(() => {
        const reader = document.querySelector('[data-testid="mc2-event-detail"]');
        if (!reader) return false;
        if (!reader.querySelector(".mc2-facts")) return false;      // 原始记录事实表已渲染
        const id = reader.querySelector(".mc2-msg-meta .mono")?.textContent?.trim() ?? "";
        if (!id.startsWith("MC2:event:")) return false;
        return Math.round(performance.now() - window.__f4t0);
      }, { polling: "raf", timeout: 60000 });
      clickToBodyMs = await handle.jsonValue();
      const body = await page.evaluate(() => {
        const reader = document.querySelector('[data-testid="mc2-event-detail"]');
        return {
          id: reader?.querySelector(".mc2-msg-meta .mono")?.textContent?.trim() ?? "",
          facts: reader?.querySelectorAll(".mc2-facts dt").length ?? 0,
          textLength: (reader?.textContent ?? "").length,
        };
      });
      object = body.id;
      bodyApiId = (await apiGet(`/api/events/${encodeURIComponent(body.id)}?dataset=MC2`)).event_id;
      assert.ok(body.facts >= 3, `MC2 正文事实表未渲染：${JSON.stringify(body)}`);
      perfRuns.push({ dataset, object, mainFigureFromSwitchMs, clickToBodyMs, body, bodyApiId });
      continue;
    }
    // CUSTOM：准备（区间外）：点冻结案例 chip，等固定证据按钮出现。
    await page.click(`.custom-case-chip[data-case-id="${KNOWN.customBypassCase}"]`);
    await page.waitForSelector('[data-testid="custom-case-detail"] [data-event-id]', { timeout: 30000 });
    await waitIdle(900);
    await page.evaluate(() => { window.__f4t0 = performance.now(); });
    await page.click('[data-testid="custom-case-detail"] [data-event-id]');
    const handle = await page.waitForFunction(() => {
      const reader = document.querySelector('[data-testid="custom-reader"]');
      if (!reader) return false;
      const id = reader.querySelector(".custom-msg-meta .mono")?.textContent?.trim() ?? "";
      if (!id) return false;
      if (!reader.querySelector(".custom-facts, dl")) return false;
      if ((reader.textContent ?? "").length < 150) return false;
      return Math.round(performance.now() - window.__f4t0);
    }, { polling: "raf", timeout: 60000 });
    clickToBodyMs = await handle.jsonValue();
    const body = await page.evaluate(() => {
      const reader = document.querySelector('[data-testid="custom-reader"]');
      return {
        id: reader?.querySelector(".custom-msg-meta .mono")?.textContent?.trim() ?? "",
        facts: reader?.querySelectorAll("dl dt").length ?? 0,
        textLength: (reader?.textContent ?? "").length,
      };
    });
    object = body.id;
    bodyApiId = (await apiGet(`/api/events/${encodeURIComponent(body.id)}?dataset=CUSTOM`)).event_id;
    assert.ok(body.facts >= 3, `CUSTOM 正文事实表未渲染：${JSON.stringify(body)}`);
    perfRuns.push({ dataset, object, mainFigureFromSwitchMs, clickToBodyMs, body, bodyApiId });
  }
  check("PERF 主图=切集到真实数据出现（不含固定等待），正文=一次打开动作到该事件正文/原始记录（含 API 往返）", () => {
    assert.equal(perfRuns.length, 3, JSON.stringify(perfRuns));
    for (const run of perfRuns) {
      assert.ok(run.object && run.object === run.bodyApiId, `${run.dataset} 对象与 API 不一致：${JSON.stringify(run)}`);
      assert.ok(run.mainFigureFromSwitchMs > 0 && run.mainFigureFromSwitchMs < 15000, `${run.dataset} 主图 ${run.mainFigureFromSwitchMs}ms`);
      assert.ok(run.clickToBodyMs > 0 && run.clickToBodyMs < 15000, `${run.dataset} 正文 ${run.clickToBodyMs}ms`);
    }
  }, {
    env,
    perfRuns,
    definition: "mainFigureFromSwitchMs：页面已初始化并停在另一数据集后，数据集选择器变更前记 performance.now()，到主图真实数据节点（MC1 84 格含公开标注意义格+事件轨点；MC2 链 ≥3 条；CUSTOM 32 行 ≥100 阶段格）出现为止；clickToBodyMs：一次打开动作（MC1 消息行/MC2 根事件/CUSTOM 固定证据）前记时，到该 event_id 的正文与原始记录节点渲染为止；固定 sleep/idle/截图 settle 均在区间外；暖缓存单样本，不是 p95",
  });

  // 意外错误与页面错误必须为空。
  check("CROSS-05 全流程无意外 HTTP/控制台/页面错误", () => {
    assert.deepEqual(unexpected, [], JSON.stringify(unexpected.slice(0, 6)));
  }, { unexpected: unexpected.length, intentional: intentional.length });
} catch (error) {
  record("RUN", `${currentJourney} 顶层异常`, false, String(error?.stack ?? error));
  await shot(`fail-${currentJourney}-${Date.now()}`).catch(() => {});
} finally {
  // 只删除本轮自建内容；预置案例与用户笔记保持只读。
  for (const entry of createdFindings) {
    await fetch(`${base}/api/findings/${encodeURIComponent(entry.finding_id)}`, { method: "DELETE" }).catch(() => {});
  }
  for (const noteId of createdNotes) {
    await fetch(`${base}/api/notes/${noteId}`, { method: "DELETE" }).catch(() => {});
  }
  for (const caseId of createdCases) {
    await fetch(`${base}/api/cases/${encodeURIComponent(caseId)}`, { method: "DELETE" }).catch(() => {});
  }
  fs.writeFileSync(path.join(out, "created-ids.json"), JSON.stringify({ cases: createdCases, findings: createdFindings, notes: createdNotes }, null, 2));
  persist();
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(out, "requests.json"), JSON.stringify(requests.filter((r) => r.journey !== "CROSS" || r.label === "cross"), null, 2));
  console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项；产物 ${out}`);
  if (failed.length) console.error(failed.map((f) => `${f.id} ${f.name}: ${f.detail}`).join("\n"));
  await browser.close();
  if (failed.length) process.exitCode = 1;
}
