import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const out = process.env.UI_CHECK_OUT
  ? path.resolve(process.env.UI_CHECK_OUT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../build/ui-refactor/S1");
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
  defaultViewport: { width: 1366, height: 768 },
});
const page = await browser.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("status of 500 (Internal Server Error)")) {
    errors.push(message.text());
  }
});
page.on("pageerror", (error) => errors.push(String(error)));
page.on("response", (response) => {
  if (response.status() >= 400 && !response.url().endsWith("/api/cases")) errors.push(`HTTP ${response.status()} ${response.url()}`);
});
const wait = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
const screenshot = (name) => page.screenshot({ path: path.join(out, name), fullPage: false });
const status = () => page.$eval(".workspace-status", (node) => node.textContent?.trim());
const activeTask = () => page.$eval(".task-tab-active", (node) => node.textContent?.trim());
const clickText = (selector, label) => page.evaluate(({ selector, label }) => {
  const node = [...document.querySelectorAll(selector)].find((item) => item.textContent?.trim() === label);
  if (!node) throw new Error(`missing ${selector}: ${label}`);
  node.click();
}, { selector, label });
const task = (label) => clickText(".task-tab", label);
const mode = (label) => clickText(".mode-tab", label);
const topButton = (label) => clickText(".topbar-docks button", label);
const dataset = async (value) => { await page.select(".dataset-field select", value); await wait(500); };
const has = (selector) => page.$(selector).then(Boolean);
const textInput = (placeholder) => page.$(`input[placeholder="${placeholder}"]`);

try {
  await page.goto(`${base}/?theme=light`, { waitUntil: "networkidle0" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".task-nav");

  assert.equal(await activeTask(), "概览");
  assert.equal(await status(), "MC2 · 概览 · 系统");
  assert.equal(await has(".graph-workspace"), true, "MC2 系统视图应渲染关系图消费者");
  await dataset("CUSTOM");
  assert.equal(await status(), "CUSTOM · 概览 · 运行");
  assert.equal(await has(".custom-workspace"), true, "CUSTOM 概览应渲染运行消费者");
  await task("追踪");
  await mode("局部关系");
  assert.equal(await status(), "CUSTOM · 追踪 · 局部关系");
  assert.equal(await has(".graph-workspace"), true, "CUSTOM 局部关系应渲染关系图");
  assert.equal(await has(".run-row-button"), false, "CUSTOM 局部关系不能显示运行选择页");
  await dataset("MC2");
  await task("追踪");
  assert.equal(await status(), "MC2 · 追踪 · 来源");
  await task("概览");
  await task("追踪");
  assert.equal(await status(), "MC2 · 追踪 · 来源");
  await screenshot("routing.png");

  await topButton("证据");
  await wait();
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1024, height: 768 }]) {
    await page.setViewport(viewport); await wait();
    const geometry = await page.evaluate(() => {
      const rect = (node) => {
        if (!node) return null;
        const value = node.getBoundingClientRect();
        return {
          left: value.left,
          right: value.right,
          top: value.top,
          bottom: value.bottom,
          width: value.width,
          height: value.height,
        };
      };
      const canvas = rect(document.querySelector(".canvas-area"));
      const dock = rect(document.querySelector(".evidence-dock"));
      return { canvas, dock, body: document.body.scrollWidth, viewport: innerWidth };
    });
    assert.ok(geometry.dock && geometry.canvas, `检查器应存在: ${viewport.width}`);
    assert.ok(geometry.canvas.width >= viewport.width * 0.9, `主图被挤压: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.body <= viewport.width + 1, `横向溢出: ${JSON.stringify(geometry)}`);
    await screenshot(`layout-${viewport.width}.png`);
  }

  await page.setViewport({ width: 390, height: 844 }); await wait();
  await topButton("事件流"); await wait();
  assert.equal(await has(".event-dock"), true);
  assert.equal(await has(".evidence-dock"), false);
  await topButton("证据"); await wait();
  assert.equal(await has(".evidence-dock"), true);
  assert.equal(await has(".event-dock"), false);
  const narrow = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
  assert.ok(narrow.body <= narrow.viewport + 1, JSON.stringify(narrow));
  await screenshot("layout-390.png");

  await page.click(".drawer-head .btn-quiet"); await wait();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "证据");

  await page.evaluate(() => {
    localStorage.setItem("mas-workspace.MC2.overview.layout", JSON.stringify({ version: 1, evidenceOpen: true, eventOpen: false, evidenceSize: 420, eventSize: 320 }));
    localStorage.setItem("mas-workspace.MC1.overview.layout", JSON.stringify({ version: 1, evidenceOpen: false, eventOpen: false, evidenceSize: 392, eventSize: 320 }));
    localStorage.setItem("mas-workspace.CUSTOM.overview.layout", "{broken");
  });
  await dataset("MC2"); await task("概览"); await page.reload({ waitUntil: "networkidle0" }); await wait();
  assert.equal(await has(".evidence-dock"), true, "刷新应恢复 MC2 概览偏好");
  await dataset("MC1");
  assert.equal(await has(".evidence-dock"), false, "布局偏好不能串任务/数据集");
  await dataset("CUSTOM");
  assert.equal(await has(".evidence-dock"), false, "损坏偏好应安全回退关闭");

  await task("结论"); await mode("结论"); await wait();
  const title = await textInput("案例标题");
  assert.ok(title, "结论页应有案例草稿输入");
  await title.type("失败保存后仍保留");
  await page.setRequestInterception(true);
  const interceptor = (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/cases") {
      void request.respond({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "simulated failure" }) });
    } else request.continue();
  };
  page.on("request", interceptor);
  await clickText("button", "保存当前案例"); await wait(300);
  page.off("request", interceptor); await page.setRequestInterception(false);
  await task("概览"); await task("结论"); await mode("结论"); await wait();
  assert.equal(await page.$eval("input[placeholder=\"案例标题\"]", (el) => el.value), "失败保存后仍保留");

  await mode("笔记"); await wait();
  const note = await page.$(".notes-editor textarea");
  assert.ok(note, "笔记模式应有编辑器");
  await note.type("切换模式后仍保留的笔记草稿");
  await mode("结论"); await mode("笔记"); await wait();
  assert.equal(await page.$eval(".notes-editor textarea", (el) => el.value), "切换模式后仍保留的笔记草稿");

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, "browser-result.json"), JSON.stringify({ base, errors, checks: [
    "routing", "overlay geometry", "narrow single dock", "focus return", "scoped layout prefs", "failed-save drafts",
  ] }, null, 2));
  console.log("S1 browser checks passed");
} finally {
  await browser.close();
}
