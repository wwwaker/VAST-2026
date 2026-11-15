/** Browser regression for MC2 floating menus, matrix stacking and inspector actions. */
import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const out = path.resolve("../build/mc2-ui-review");
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
  defaultViewport: { width: 1440, height: 1000 },
});

const page = await browser.newPage();
const errors = [];
const checks = [];
page.on("pageerror", (e) => errors.push(String(e)));
const root = '[data-testid="mc2-reference"] >>> ';

const wait = (s) =>
  page.waitForFunction(
    (s) => !!document.querySelector('[data-testid="mc2-reference"]')?.shadowRoot?.querySelector(s),
    { timeout: 20000, polling: "raf" },
    s,
  );

const check = (label, result) => {
  assert.ok(result, label);
  checks.push(label);
  console.log("PASS", label);
};

const clickText = async (text) => {
  const h = await page.evaluateHandle(
    (text) =>
      [
        ...document
          .querySelector('[data-testid="mc2-reference"]')
          .shadowRoot.querySelectorAll("button"),
      ].find((b) => b.textContent.trim() === text),
    text,
  );

  assert.ok(h.asElement(), text);
  await h.asElement().click();
  await h.dispose();
};

const combo = (label) => root + `button[role=combobox][aria-label="${label}"]`;
try {
  await page.goto((process.argv[2] ?? "http://127.0.0.1:8000") + "/?mc2=reference", {
    waitUntil: "networkidle0",
  });
  await wait(".mc2-cell");
  const initialScroll = await page.evaluate(() => scrollY);
  await page.click(combo("来源发布实例"));
  await wait(".w-select-menu");
  check(
    "Opening a menu does not scroll the workspace",
    initialScroll === (await page.evaluate(() => scrollY)),
  );
  check(
    "Publication menu escapes sidebar clipping and displays wrapped paths",
    await page.$eval(root + ".w-select-menu", (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);

      return (
        !e.closest(".filter-panel") &&
        r.left >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight &&
        s.position === "fixed" &&
        s.borderRadius === "10px" &&
        getComputedStyle(e.querySelector("[role=option] span")).overflowWrap === "anywhere"
      );
    }),
  );
  await page.screenshot({ path: path.join(out, "publication-menu-1440.png") });
  await page.keyboard.press("Escape");
  check(
    "Escape dismisses popup and retains trigger focus",
    await page.evaluate(() => {
      const r = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;

      return (
        !r.querySelector(".w-select-menu") &&
        r.activeElement?.getAttribute("aria-label") === "来源发布实例"
      );
    }),
  );
  await page.click(combo("时间粒度"));
  await wait(".w-select-menu");
  check(
    "Unavailable hourly scale has a disabled explanation in the styled menu",
    await page.$eval(root + ".w-select-menu [aria-disabled=true]", (e) =>
      e.textContent.includes("10天内"),
    ),
  );
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  check(
    "Arrow navigation skips disabled hourly scale",
    await page.$eval(root + 'select[aria-label="时间粒度"]', (e) => e.value === "day"),
  );
  await page.click(combo("关系角色"));
  await wait(".w-select-menu");
  await page.screenshot({ path: path.join(out, "relation-menu-1440.png") });

  const mailIndex = await page.$eval(root + 'select[aria-label="关系角色"]', (e) =>
    [...e.options].findIndex((o) => o.value === "mail_recipient"),
  );

  await page.click(root + `.w-select-menu [data-index="${mailIndex}"]`);
  await wait(".w-relation-matrix");
  check(
    "Pointer selection updates the real relationship scope",
    await page.$eval(root + 'select[aria-label="关系角色"]', (e) => e.value === "mail_recipient"),
  );
  await page.click(combo("矩阵排序"));
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  check(
    "End and Enter apply the final sorting option",
    await page.$eval(root + 'select[aria-label="矩阵排序"]', (e) => e.value === "count"),
  );
  await page.click(combo("矩阵排序"));
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  check(
    "Home and Enter restore the first sorting option",
    await page.$eval(root + 'select[aria-label="矩阵排序"]', (e) => e.value === "name"),
  );
  const before = await page.$eval(root + ".w-matrix-shell", (e) => e.getBoundingClientRect().top);
  await page.click(root + '[aria-label="定位矩阵对象"]');
  await page.type(root + '[aria-label="定位矩阵对象"]', "s");
  await wait(".w-matrix-search-results button");
  check(
    "Search results paint above the sticky top-left header",
    await page.evaluate(() => {
      const s = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;
      const m = s.querySelector(".w-matrix-search-results");
      const c = s.querySelector(".w-relation-matrix thead th");
      const a = m.getBoundingClientRect();
      const b = c.getBoundingClientRect();
      const x = Math.max(a.left, b.left) + 8;
      const y = Math.max(a.top, b.top) + 8;

      return (
        x < Math.min(a.right, b.right) &&
        y < Math.min(a.bottom, b.bottom) &&
        m.contains(s.elementFromPoint(x, y))
      );
    }),
  );
  check(
    "Search popup preserves the matrix vertical position",
    before === (await page.$eval(root + ".w-matrix-shell", (e) => e.getBoundingClientRect().top)),
  );
  await page.screenshot({ path: path.join(out, "matrix-search-stacking-1440.png") });
  await page.click(root + ".w-matrix-search-results button");
  check(
    "Search result remains clickable over matrix headers",
    !(await page.$(root + ".w-matrix-search-results")) &&
      (await page.$(root + ".w-relation-matrix th.is-located")),
  );
  await page.click(root + ".w-relation-matrix tbody th button");
  await wait(".w-node-actions");
  check(
    "Both participant actions have borders, padding and icons",
    await page.$$eval(
      root + ".w-node-actions button",
      (buttons) =>
        buttons.length === 2 &&
        buttons.every((e) => {
          const s = getComputedStyle(e);

          return (
            s.borderTopStyle === "solid" &&
            parseFloat(s.paddingLeft) >= 7 &&
            s.textDecorationLine === "none" &&
            e.querySelector("svg")
          );
        }),
    ),
  );
  await page.screenshot({ path: path.join(out, "matrix-node-actions-1440.png") });
  await clickText("取消对象选择");
  check(
    "Cancel object action removes only the node inspector",
    !(await page.$(root + ".w-node-inspector")) && (await page.$(root + ".w-relation-matrix")),
  );
  await clickText("文件指纹");
  await wait(".w-pattern-row");
  await page.click(combo("文件指纹排序"));
  await wait(".w-select-menu");
  await page.keyboard.press("Escape");
  check(
    "Popup Escape leaves the research dialog open",
    (await page.$(root + ".w-research-dialog")) && !(await page.$(root + ".w-select-menu")),
  );
  await page.click(combo("文件指纹排序"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  check(
    "Popup choice retains research dialog and updates sort",
    (await page.$eval(root + 'select[aria-label="文件指纹排序"]', (e) => e.value === "actions")) &&
      (await page.$(root + ".w-research-dialog")),
  );
  await page.click(combo("文件指纹排序"));
  await page.click(root + ".w-research-head h2");
  check("Clicking outside closes the popup", !(await page.$(root + ".w-select-menu")));
  for (const width of [768, 390]) {
    await page.setViewport({ width, height: 1000 });
    await page.click(combo("文件指纹排序"));
    await wait(".w-select-menu");
    check(
      `${width}px popup remains inside viewport`,
      await page.$eval(root + ".w-select-menu", (e) => {
        const r = e.getBoundingClientRect();

        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }),
    );
    await page.screenshot({ path: path.join(out, `select-menu-${width}.png`) });
    await page.keyboard.press("Escape");
  }
  check("No browser JavaScript errors", errors.length === 0);
  fs.writeFileSync(
    path.join(out, "control-checks.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(`Passed ${checks.length} control browser checks.`);
} catch (e) {
  await page.screenshot({ path: path.join(out, "controls-failure.png") });
  throw e;
} finally {
  await browser.close();
}
