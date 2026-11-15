/** Real-browser checks for theme initialization, persistence, live charts and retained investigation state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://127.0.0.1:8000";
const out = path.resolve("../build/dark-theme-review/theme");
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
page.on("pageerror", (error) => errors.push(String(error)));
let workspace = "mc2-reference";
const root = () => `[data-testid="${workspace}"] >>> `;

const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS", label);
};

const wait = (selector) =>
  page.waitForFunction(
    (host, selector) =>
      !!document.querySelector(`[data-testid="${host}"]`)?.shadowRoot?.querySelector(selector),
    { timeout: 30000 },
    workspace,
    selector,
  );

const scheme = () => page.$eval("html", (element) => element.dataset.theme);

const select = async (value) => {
  await page.select(root() + '[aria-label="界面主题"]', value);
  await page.waitForFunction(
    (value) => document.documentElement.dataset.themePreference === value,
    {},
    value,
  );
};

const click = async (text) => {
  const handle = await page.evaluateHandle(
    (host, text) =>
      [
        ...document.querySelector(`[data-testid="${host}"]`).shadowRoot.querySelectorAll("button"),
      ].find((button) => button.textContent.trim() === text),
    workspace,
    text,
  );

  assert.ok(handle.asElement(), text);
  await handle.asElement().click();
  await handle.dispose();
};

const media = (value) =>
  page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value },
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);

try {
  await page.evaluateOnNewDocument(() => {
    const observer = new MutationObserver(() => {
      if (document.documentElement?.dataset.theme && !window.themeBeforeApp) {
        window.themeBeforeApp = {
          theme: document.documentElement.dataset.theme,
          mounted: !!document.getElementById("root")?.childElementCount,
        };
        observer.disconnect();
      }
    });

    observer.observe(document, { subtree: true, attributes: true, childList: true });
  });
  await media("dark");
  await page.goto(base + "/?mc2=reference", { waitUntil: "networkidle0" });
  await wait(".mc2-cell");
  check(
    "System dark preference is applied before React mounts",
    await page.evaluate(
      () => window.themeBeforeApp.theme === "dark" && !window.themeBeforeApp.mounted,
    ),
  );
  check(
    "Initial workspace inherits dark surfaces through Shadow DOM",
    await page.$eval(
      root() + ".mc2-card",
      (element) => getComputedStyle(element).backgroundColor === "rgb(24, 35, 49)",
    ),
  );
  await select("light");
  check(
    "Explicit light overrides a dark system and saves the choice",
    (await scheme()) === "light" &&
      (await page.evaluate(() => localStorage.getItem("mas-theme") === "light")),
  );
  await media("light");
  await select("dark");
  await page.reload({ waitUntil: "networkidle0" });
  await wait(".mc2-cell");
  check(
    "Saved dark choice survives reload and overrides a light system before mounting",
    (await scheme()) === "dark" &&
      (await page.evaluate(
        () => window.themeBeforeApp.theme === "dark" && !window.themeBeforeApp.mounted,
      )),
  );
  await select("system");
  check(
    "Returning to system mode resolves the current system preference",
    (await scheme()) === "light",
  );
  await media("dark");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  check("System preference changes update a running workspace", (await scheme()) === "dark");

  const other = await browser.newPage();
  await other.goto(base + "/?mc2=reference", { waitUntil: "networkidle0" });
  await select("light");
  await other.waitForFunction(() => document.documentElement.dataset.theme === "light");
  check(
    "A theme choice synchronizes to another open tab",
    await other.$eval("html", (element) => element.dataset.themePreference === "light"),
  );
  await other.close();

  await select("dark");
  await click("MC1");
  workspace = "mc1-reference";
  await wait(".cell");
  await wait(".net-node");
  check(
    "MC1 keeps the saved theme during dataset navigation",
    (await scheme()) === "dark" &&
      (await page.$eval(root() + '[aria-label="界面主题"]', (element) => element.value === "dark")),
  );
  await page.$eval(root() + ".cell", (element) => element.click());
  await wait(".cell-selected");

  const before = await page.evaluate((host) => {
    const r = document.querySelector(`[data-testid="${host}"]`).shadowRoot;
    const svg = r.querySelector(".net-svg");
    window.retainedThemeState = {
      root: r,
      svg,
      cell: r.querySelector(".cell-selected"),
      nodes: [...r.querySelectorAll(".net-node")].map((element) =>
        element.getAttribute("transform"),
      ),
    };
    r.querySelector(".heatmap-scroll").scrollLeft = 180;

    return {
      left: r.querySelector(".heatmap-scroll").scrollLeft,
      cell: r.querySelector(".cell-selected").title,
    };
  }, workspace);

  await select("light");
  await select("dark");
  check(
    "MC1 switching retains cell selection, horizontal scroll and D3 node identity/positions",
    await page.evaluate(
      (host, before) => {
        const r = document.querySelector(`[data-testid="${host}"]`).shadowRoot;
        const saved = window.retainedThemeState;

        return (
          saved.root === r &&
          saved.svg === r.querySelector(".net-svg") &&
          saved.cell === r.querySelector(".cell-selected") &&
          saved.cell.title === before.cell &&
          r.querySelector(".heatmap-scroll").scrollLeft === before.left &&
          JSON.stringify(saved.nodes) ===
            JSON.stringify(
              [...r.querySelectorAll(".net-node")].map((element) =>
                element.getAttribute("transform"),
              ),
            )
        );
      },
      workspace,
      before,
    ),
  );
  await page.screenshot({ path: path.join(out, "mc1-dark.png") });

  const cellContrast = () =>
    page.evaluate((host) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");

      const luminance = (color) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);

        return [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((channel) => {
            const value = channel / 255;

            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
      };

      const cells = [
        ...document.querySelector(`[data-testid="${host}"]`).shadowRoot.querySelectorAll(".cell"),
      ].filter((cell) => cell.textContent.trim());

      return (
        cells.length > 0 &&
        cells.every((cell) => {
          const style = getComputedStyle(cell);
          const a = luminance(style.color);
          const b = luminance(style.backgroundColor);

          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5;
        })
      );
    }, workspace);

  check(
    "Every populated dark count cell has text contrast of at least 4.5:1",
    await cellContrast(),
  );
  await click("情绪热力图");
  check(
    "Every populated dark sentiment cell has text contrast of at least 4.5:1",
    await cellContrast(),
  );

  await click("MC2");
  workspace = "mc2-reference";
  await wait(".mc2-cell");
  await click("关系图");
  await wait(".w-relation-canvas canvas");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="mc2-reference"]')
        .shadowRoot.querySelector(".w-relation-canvas")
        ._cyreg?.cy?.nodes().length > 0,
  );

  const graphBefore = await page.evaluate(() => {
    const host = document
      .querySelector('[data-testid="mc2-reference"]')
      .shadowRoot.querySelector(".w-relation-canvas");

    const graph = host._cyreg.cy;
    graph.nodes().first().position({ x: 241, y: 173 });
    graph.nodes().first().select();
    graph.zoom(0.9);
    graph.pan({ x: 33, y: 44 });
    window.retainedGraph = graph;

    return {
      positions: graph.nodes().map((node) => node.position()),
      zoom: graph.zoom(),
      pan: graph.pan(),
      color: graph.nodes().first().style("background-color"),
      selected: graph.$(":selected").map((element) => element.id()),
    };
  });

  await select("light");
  check(
    "Cytoscape repaints its node surfaces when switching to light",
    await page.evaluate(
      (before) => window.retainedGraph.nodes().first().style("background-color") !== before.color,
      graphBefore,
    ),
  );
  await select("dark");
  check(
    "Cytoscape switching keeps the graph instance, dragged coordinates, zoom, pan and selection",
    await page.evaluate((before) => {
      const graph = window.retainedGraph;

      const current = document
        .querySelector('[data-testid="mc2-reference"]')
        .shadowRoot.querySelector(".w-relation-canvas")._cyreg.cy;

      return (
        graph === current &&
        JSON.stringify(graph.nodes().map((node) => node.position())) ===
          JSON.stringify(before.positions) &&
        graph.zoom() === before.zoom &&
        JSON.stringify(graph.pan()) === JSON.stringify(before.pan) &&
        JSON.stringify(graph.$(":selected").map((element) => element.id())) ===
          JSON.stringify(before.selected) &&
        graph.nodes().first().style("background-color") === before.color
      );
    }, graphBefore),
  );
  await page.$eval(root() + ".w-relation-canvas", (element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await page.screenshot({ path: path.join(out, "mc2-canvas-dark.png") });
  await page.evaluate(() => window.scrollTo(0, 0));
  await click("文件指纹");
  await wait(".w-pattern-row");
  await page.click(root() + ".w-pattern-row");
  await wait(".w-pattern-member-list article");
  await click("阅读真实操作序列");
  await wait(".mc2-reader .mc2-type-counts");

  const retainedReader = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;
    window.themeReader = root.querySelector(".mc2-reader");
    const body = root.querySelector(".mc2-reader-body");
    body.scrollTop = 80;

    return { text: window.themeReader.textContent, scroll: body.scrollTop };
  });

  const controller = await browser.newPage();
  await controller.goto(base, { waitUntil: "networkidle0" });
  for (const theme of ["light", "dark"]) {
    await controller.evaluate((theme) => localStorage.setItem("mas-theme", theme), theme);
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      {},
      theme,
    );
  }
  check(
    "Live theme changes retain the reader, its content and scroll above the research dialog",
    await page.evaluate((before) => {
      const root = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;

      return (
        window.themeReader === root.querySelector(".mc2-reader") &&
        window.themeReader.textContent === before.text &&
        root.querySelector(".mc2-reader-body").scrollTop === before.scroll &&
        !!root.querySelector(".w-research-dialog")
      );
    }, retainedReader),
  );
  await controller.close();
  await page.screenshot({ path: path.join(out, "mc2-reader-dark.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await click("CUSTOM");
  workspace = "custom-reference";
  await wait(".cu-case-button:not(:disabled)");
  await page.click(root() + '[data-case="custom-stale-published"]');
  await wait('[data-testid="version-graph"]');
  const graphElement = await page.$(root() + '[data-testid="version-graph"]');
  const run = await page.url();
  await select("light");
  await select("dark");
  check(
    "CUSTOM keeps the same run and evidence graph when switching",
    (await graphElement.evaluate((element) => element.isConnected)) && page.url() === run,
  );
  await graphElement.dispose();
  await page.setViewport({ width: 390, height: 844 });
  check(
    "Theme selector remains visible within the 390px viewport",
    await page.$eval(root() + '[aria-label="界面主题"]', (element) => {
      const bounds = element.getBoundingClientRect();

      return bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth;
    }),
  );
  await page.screenshot({ path: path.join(out, "custom-dark-390.png") });

  const isolated = await browser.createBrowserContext();
  const blocked = await isolated.newPage();
  blocked.on("pageerror", (error) => errors.push(String(error)));
  await blocked.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await blocked.evaluateOnNewDocument(() => {
    Storage.prototype.getItem = Storage.prototype.setItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
  });
  await blocked.goto(base + "/?mc2=reference", { waitUntil: "networkidle0" });
  await blocked.waitForSelector('[data-testid="mc2-reference"] >>> [aria-label="界面主题"]');
  check(
    "Unavailable storage falls back to the system theme",
    await blocked.$eval("html", (element) => element.dataset.theme === "dark"),
  );
  await blocked.select('[data-testid="mc2-reference"] >>> [aria-label="界面主题"]', "light");
  check(
    "Theme switching remains usable with storage disabled",
    await blocked.$eval("html", (element) => element.dataset.theme === "light"),
  );
  await isolated.close();
  check("No browser JavaScript errors", errors.length === 0);
} catch (error) {
  await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  fs.writeFileSync(path.join(out, "checks.json"), JSON.stringify({ checks, errors }, null, 2));
  await browser.close();
}
console.log(`Passed ${checks.length} theme browser checks`);
