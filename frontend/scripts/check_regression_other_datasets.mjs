/**
 * F1 最小回归：MC2 来源链 / 系统背景，CUSTOM 运行入口（不改这两页，只确认仍可用）。
 * 用法：node scripts/check_regression_other_datasets.mjs http://127.0.0.1:8021
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
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));
page.on("response", (r) => {
  if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

await page.goto(URL, { waitUntil: "networkidle0" });
await page.waitForSelector(".topbar");

// --- MC2 来源链 ---
await page.select(".dataset-field select", "MC2");
await wait(1200);
const clickedTrace = await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".view-tab")].find((n) => n.textContent?.includes("来源链"));
  tab?.click();
  return !!tab;
});
check("MC2 来源链入口存在", clickedTrace);
await page.waitForSelector(".trace-view", { timeout: 20000 });
await page.waitForSelector(".trace-roots .seg-item", { timeout: 20000 });
await page.evaluate(() => document.querySelector(".trace-roots .seg-item")?.click());
await page.waitForSelector(".trace-lanes", { timeout: 20000 });
await wait(600);
const trace = await page.evaluate(() => ({
  lanes: !!document.querySelector(".trace-lanes"),
  items: document.querySelectorAll(".trace-item").length,
  roots: document.querySelectorAll(".trace-roots .seg-item").length,
}));
check("MC2 来源链可展开文件操作", trace.lanes && trace.items > 0, JSON.stringify(trace));
await shot("regression-mc2-trace");

// --- MC2 系统背景 ---
await page.goto(URL, { waitUntil: "networkidle0" });
await page.select(".dataset-field select", "MC2");
await wait(1200);
const clickedSystem = await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".canvas-subbar .seg-item")].find((b) =>
    b.textContent?.includes("系统背景"),
  );
  btn?.click();
  return !!btn;
});
if (!clickedSystem) {
  // 概览模式的系统切换在任务/模式导航里
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".mode-tab")].find((n) => n.textContent?.trim() === "系统");
    tab?.click();
  });
}
await page.waitForSelector(".system-canvas", { timeout: 20000 });
await wait(800);
const system = await page.evaluate(() => ({
  nodes: document.querySelectorAll(".system-node").length,
  paths: document.querySelectorAll(".system-canvas path").length,
}));
check("MC2 系统背景聚合图可用", system.nodes >= 8, JSON.stringify(system));
await shot("regression-mc2-system");

// --- CUSTOM 运行入口 ---
await page.goto(URL, { waitUntil: "networkidle0" });
await page.select(".dataset-field select", "CUSTOM");
await page.waitForSelector(".run-row-button", { timeout: 20000 });
await wait(600);
const runCount = await page.evaluate(() => document.querySelectorAll(".run-row-button").length);
await page.evaluate(() => document.querySelector(".run-row-button")?.click());
await page.waitForSelector(".run-detail-head", { timeout: 20000 });
await wait(900);
const custom = await page.evaluate(() => ({
  head: document.querySelector(".run-detail-head")?.textContent?.slice(0, 60) ?? "",
  summary: document.querySelector(".status-summary")?.textContent ?? "",
}));
check("CUSTOM 运行可选中并显示详情", runCount >= 30 && custom.head.length > 0, JSON.stringify({ runCount, ...custom }));
await shot("regression-custom-run");

const uniqueErrors = [...new Set(errors)];
check("回归过程无控制台/网络错误", uniqueErrors.length === 0, uniqueErrors.slice(0, 3).join(" | "));

fs.writeFileSync(
  path.join(OUT, "check-regression-other.json"),
  JSON.stringify({ url: URL, at: new Date().toISOString(), results, errors: uniqueErrors }, null, 2),
);
const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
