/**
 * 界面自检：驱动本机 Chrome 打开构建产物，测量布局与渲染成本，并截图。
 * 用法（先启动后端，它会托管 frontend/dist）：
 *   node scripts/ui_check.mjs http://127.0.0.1:8000
 */
import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";

const URL = process.argv[2] ?? "http://127.0.0.1:8000";
const OUT = path.resolve("..", "build");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

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
page.on("requestfailed", (r) => errors.push(`请求失败 ${r.url()}`));
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
  mode: document.querySelector(".mode-chip")?.textContent,
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

console.log("== 基线比较 ==");
await page.goto(`${URL}/?theme=light`, { waitUntil: "networkidle0" });
await page.waitForSelector(".anchor-chip", { timeout: 20000 });
await page.evaluate(() => document.querySelector(".anchor-chip")?.click());
await wait(900);
// 走左侧「比较」章节，顺带验证章节与视图的联动
await page.evaluate(() => {
  const ch = [...document.querySelectorAll(".chapter")].find((c) =>
    c.textContent?.includes("比较"),
  );
  ch?.click();
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
await page.type(".notes-editor textarea", "UI 自检写入的笔记：验证前端到后端的完整链路。", { delay: 0 });
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

// 清理
await page.evaluate(() => {
  document.querySelectorAll(".note-del").forEach((b) => b.click());
});
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
