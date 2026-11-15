/** Chromium measurements of the migrated UI, including its actual shadow styles. */
import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  lightThemeSnapshot,
  replayLightTheme,
  restoreLightTheme,
} from "./light_theme_snapshot.mjs";
const out = path.resolve(process.env.MAS_UI_REVIEW_OUT ?? "../build/readability-ui-review");
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const page = await browser.newPage();
if (process.env.MAS_LIGHT_THEME_SNAPSHOT) {
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
}

const screenshot = async (options) => {
  if (process.env.MAS_LIGHT_THEME_SNAPSHOT) {
    // D3's four-second edge pulse uses timers even when reduced motion is enabled.
    await page.waitForFunction(() =>
      [...document.querySelectorAll("[data-testid]")].every(
        (element) => !element.shadowRoot?.querySelector(".edge-new"),
      ),
    );
  }
  const previous = await replayLightTheme(page);
  if (previous) {
    const originalPath = path.join(out, "replayed-before", path.basename(options.path));
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    try {
      await lightThemeSnapshot(page, originalPath);
      await page.screenshot({ ...options, path: originalPath });
    } finally {
      await restoreLightTheme(page, previous);
    }
  }
  await lightThemeSnapshot(page, options.path);

  return page.screenshot(options);
};

const checks = [];
const measurements = [];
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const base = process.argv[2] ?? "http://127.0.0.1:8000";
let workspace = "mc2-reference";
const root = () => `[data-testid="${workspace}"] >>> `;

const wait = async (selector) => {
  await page.waitForFunction(
    (host, selector) =>
      !!document.querySelector(`[data-testid="${host}"]`)?.shadowRoot?.querySelector(selector),
    { timeout: 30000 },
    workspace,
    selector,
  );
  if (process.env.MAS_LIGHT_THEME_SNAPSHOT) {
    // Finish React's two-frame scroll restoration before the caller positions a screenshot.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
  }
};

const click = async (label) => {
  const el = await page.evaluateHandle(
    (host, label) =>
      [
        ...document.querySelector(`[data-testid="${host}"]`).shadowRoot.querySelectorAll("button"),
      ].find((e) => e.textContent.trim() === label && e.getClientRects().length),
    workspace,
    label,
  );

  assert.ok(el.asElement(), label);
  await el.asElement().click();
  await el.dispose();
};

const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS", label);
};

async function checkPatternColumns(width) {
  const layout = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;
    const body = r.querySelector(".w-research-body");
    const list = r.querySelector(".w-pattern-list");
    const detail = r.querySelector(".w-pattern-detail");

    return (
      getComputedStyle(body).overflowY === "hidden" &&
      body.scrollHeight <= body.clientHeight + 1 &&
      getComputedStyle(list).overflowY === "auto" &&
      list.scrollHeight > list.clientHeight &&
      getComputedStyle(detail).overflowY === "auto"
    );
  });

  check(`${width}: desktop columns scroll independently inside the fixed research body`, layout);

  const selectBottom = async () => {
    const before = await page.$eval(root() + ".w-pattern-list", (e) => {
      e.scrollTop = e.scrollHeight;

      return e.scrollTop;
    });

    await page.click(root() + ".w-pattern-row:nth-last-child(2)");
    await wait('.w-pattern-members .w-pending-region[data-refresh-state="ready"] article');
    check(
      `${width}: selecting a bottom row keeps the list position and shows the detail heading`,
      await page.evaluate((before) => {
        const r = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;
        const list = r.querySelector(".w-pattern-list");
        const detail = r.querySelector(".w-pattern-detail");
        const heading = detail.querySelector("h3").getBoundingClientRect();
        const bounds = detail.getBoundingClientRect();
        const row = list.querySelector("[aria-pressed=true]").getBoundingClientRect();
        const lb = list.getBoundingClientRect();

        return (
          before > 0 &&
          Math.abs(list.scrollTop - before) < 2 &&
          detail.scrollTop === 0 &&
          heading.top >= bounds.top &&
          heading.bottom <= bounds.bottom &&
          row.top >= lb.top &&
          row.bottom <= lb.bottom
        );
      }, before),
    );
  };

  await selectBottom();
  check(
    `${width}: pattern pagination stays visible at the bottom of the list`,
    await page.$eval(root() + ".w-pattern-browser>.mc2-pagination", (e) => {
      const a = e.getBoundingClientRect();
      const b = e.closest(".w-research-body").getBoundingClientRect();

      return a.top >= b.top && a.bottom <= b.bottom;
    }),
  );
  await screenshot({ path: path.join(out, `patterns-bottom-${width}.png`) });
  await page.$eval(root() + ".w-pattern-list", (e) => (e.scrollTop = 0));
  await page.click(root() + ".w-pattern-row");
  await wait('.w-pattern-members .w-pending-region[data-refresh-state="ready"] article');
  const listTop = await page.$eval(root() + ".w-pattern-list", (e) => e.scrollTop);
  await page.hover(root() + ".w-pattern-detail");
  await page.mouse.wheel({ deltaY: 1800 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="mc2-reference"]')
        .shadowRoot.querySelector(".w-pattern-detail").scrollTop > 0,
  );
  check(
    `${width}: scrolling a long detail leaves the list and research body in place`,
    await page.evaluate((listTop) => {
      const r = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;

      return (
        r.querySelector(".w-pattern-detail").scrollTop > 0 &&
        r.querySelector(".w-pattern-list").scrollTop === listTop &&
        r.querySelector(".w-research-body").scrollTop === 0
      );
    }, listTop),
  );

  const readerButtons = await page.$$(
    root() + ".w-pattern-members article .w-head-actions button:first-child",
  );

  const readerButton = readerButtons.at(-1);
  await readerButton.click();
  await wait(".mc2-reader .mc2-type-counts");
  await screenshot({ path: path.join(out, `mc2-reader-${width}.png`) });

  const positions = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;

    return [".w-pattern-list", ".w-pattern-detail"].map((s) => r.querySelector(s).scrollTop);
  });

  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="mc2-reference"]').shadowRoot.activeElement
        ?.textContent === "阅读真实操作序列",
  );
  check(
    `${width}: closing the reader restores the same member focus and both column positions`,
    await readerButton.evaluate((e, positions) => {
      const r = e.getRootNode();

      return (
        r.activeElement === e &&
        [".w-pattern-list", ".w-pattern-detail"].every(
          (s, i) => Math.abs(r.querySelector(s).scrollTop - positions[i]) < 2,
        )
      );
    }, positions),
  );
  for (const b of readerButtons) {
    await b.dispose();
  }
  await selectBottom();
  await click("下一页模式");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="mc2-reference"]')
        .shadowRoot.querySelector(".w-pattern-rank")?.textContent === "21",
  );
  check(
    `${width}: fixed pattern pagination still loads the next page`,
    await page.$eval(root() + ".w-pattern-placeholder", (e) => !!e.getClientRects().length),
  );
  await click("上一页模式");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="mc2-reference"]')
        .shadowRoot.querySelector(".w-pattern-rank")?.textContent === "1",
  );
  if (width === 1440) {
    await page.setViewport({ width: 1000, height: 900 });
    check(
      "1000px boundary retains two visible independently scrolling columns",
      await page.evaluate(() => {
        const r = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;
        const a = r.querySelector(".w-pattern-browser").getBoundingClientRect();
        const b = r.querySelector(".w-pattern-detail").getBoundingClientRect();
        const body = r.querySelector(".w-research-body");

        return (
          b.left >= a.right &&
          Math.abs(a.top - b.top) < 1 &&
          b.bottom <= body.getBoundingClientRect().bottom &&
          body.scrollWidth <= body.clientWidth + 1
        );
      }),
    );
    await page.setViewport({ width: 999, height: 900 });
    await wait(".w-fingerprints.is-narrow .w-pattern-tabs");
    check(
      "999px boundary switches to the list and detail tabs",
      await page.$eval(root() + ".w-pattern-detail", (e) => e.hidden),
    );
    await page.setViewport({ width, height: 900 });
    await wait(".w-fingerprints:not(.is-narrow)");
  }
}

async function readable(selector, label) {
  const samples = await page.evaluate(
    (host, selector) => {
      const root = document.querySelector(`[data-testid="${host}"]`).shadowRoot;

      const rgba = (s) => {
        const m = s.match(/[\d.]+/g);

        return m ? [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]] : [0, 0, 0, 0];
      };

      const blend = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));

      const background = (e) => {
        const chain = [];
        for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
          chain.unshift(n);
        }
        let rgb = [255, 255, 255];
        for (const n of chain) {
          rgb = blend(rgba(getComputedStyle(n).backgroundColor), rgb);
        }

        return rgb;
      };

      const luminance = (rgb) =>
        rgb
          .map((c) => {
            const n = c / 255;

            return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
          })
          .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);

      return [...root.querySelectorAll(selector)]
        .filter(
          (e) =>
            e.getClientRects().length &&
            e.textContent.trim() &&
            !e.closest("[hidden]") &&
            (!e.closest("details:not([open])") || e.tagName === "SUMMARY"),
        )
        .map((e) => {
          const style = getComputedStyle(e);
          const svg = e instanceof SVGGraphicsElement ? e.getScreenCTM() : null;
          const scale = svg ? Math.hypot(svg.c, svg.d) : 1;
          const bg = background(e);
          const fg = blend(rgba(svg ? style.fill : style.color), bg);
          const l1 = luminance(fg);
          const l2 = luminance(bg);

          return {
            text: e.textContent.trim().slice(0, 65),
            font: parseFloat(style.fontSize) * scale,
            ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
            color: svg ? style.fill : style.color,
            background: bg,
          };
        });
    },
    workspace,
    selector,
  );

  measurements.push({ label, samples });
  const failures = samples.filter((s) => s.font < 11.95 || s.ratio < 4.49);
  if (failures.length) {
    console.log("READABILITY FAILURES", label, JSON.stringify(failures));
  }
  check(
    `${label}: necessary text is at least 12px and contrast is at least 4.5:1`,
    samples.length > 0 && !failures.length,
  );
}

try {
  if (!process.argv.includes("--custom-only")) {
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
      [768, 1024],
    ]) {
      await page.setViewport({ width, height });
      workspace = "mc2-reference";
      await page.goto(base + "/?mc2=reference", { waitUntil: "networkidle0" });
      await wait(".mc2-cell");
      await screenshot({ path: path.join(out, `mc2-overview-${width}.png`) });
      if (width === 1440 && process.env.MAS_LIGHT_THEME_SNAPSHOT) {
        await page.hover(root() + ".workspace-nav button");
        await screenshot({ path: path.join(out, "mc2-nav-hover-1440.png") });
        await page.focus(root() + ".workspace-nav button");
        await page.keyboard.press("Tab");
        await screenshot({ path: path.join(out, "mc2-nav-focus-1440.png") });
        await page.mouse.move(0, 0);
      }
      await click("文件指纹");
      await wait(".w-pattern-row");
      await readable(
        ".w-pattern-frequency small,.w-pattern-sequence>small,.w-step-body>span:last-child,.w-pattern-rank",
        "fingerprint list " + width,
      );
      if (width >= 1000) {
        await checkPatternColumns(width);
      } else {
        check(
          `${width}: narrow pattern list uses the research body scroller`,
          await page.$eval(
            root() + ".w-pattern-list",
            (e) =>
              getComputedStyle(e).maxHeight === "none" &&
              getComputedStyle(e).overflowY === "visible",
          ),
        );
      }
      await screenshot({ path: path.join(out, `patterns-list-${width}.png`) });
      if (width === 768) {
        await page.$eval(root() + ".w-research-body", (e) => (e.scrollTop = 180));
      }
      const before = await page.$eval(root() + ".w-research-body", (e) => e.scrollTop);
      await page.click(root() + (width === 768 ? ".w-pattern-row:nth-child(4)" : ".w-pattern-row"));
      await wait(".w-pattern-members article");
      await readable(
        ".w-pattern-detail-head>span,.w-pattern-members article>p,.w-content-tag,.w-pattern-members .w-head-actions button",
        "fingerprint detail " + width,
      );
      check(
        `${width}: members have no nested vertical scroller`,
        await page.$eval(
          root() + ".w-pattern-member-list",
          (e) =>
            getComputedStyle(e).maxHeight === "none" && getComputedStyle(e).overflowY === "visible",
        ),
      );
      check(
        `${width}: research body has no horizontal page overflow`,
        await page.$eval(root() + ".w-research-body", (e) => e.scrollWidth <= e.clientWidth + 1),
      );
      if (width === 768) {
        check(
          "Narrow pattern selection shows detail without unmounting list",
          (await page.$eval(root() + ".w-pattern-browser", (e) => e.hidden)) &&
            (await page.$eval(root() + ".w-pattern-detail", (e) => !e.hidden)),
        );
        await screenshot({ path: path.join(out, `patterns-detail-${width}.png`) });
        await click("返回模式列表");
        await page.waitForFunction(() => {
          const r = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;

          return (
            !r.querySelector(".w-pattern-browser").hidden &&
            r.activeElement?.classList.contains("w-pattern-row")
          );
        });
        check(
          "Returning to the list restores the selected row and scroll",
          await page.evaluate((before) => {
            const r = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;

            return (
              r.activeElement?.classList.contains("w-pattern-row") &&
              Math.abs(r.querySelector(".w-research-body").scrollTop - before) < 2
            );
          }, before),
        );
        await click("模式详情");
      }
      await page.keyboard.press("Escape");
      await click("发布实例比较");
      await wait(".w-compare-row");
      check(
        `${width}: comparison keeps its own research body scrolling`,
        await page.$eval(
          root() + ".w-research-body",
          (e) => getComputedStyle(e).overflowY === "auto",
        ),
      );
      check(
        `${width}: checked candidates and visible comparison rows agree`,
        await page.evaluate(() => {
          const r = document.querySelector('[data-testid="mc2-reference"]').shadowRoot;

          return (
            r.querySelectorAll(".w-compare-picks input:checked").length ===
            r.querySelectorAll(".w-compare-row").length
          );
        }),
      );
      await readable(
        ".w-compare-axis text,.w-compare-row-tools span,.w-compare-row-tools button",
        "comparison " + width,
      );
      await screenshot({ path: path.join(out, `comparison-${width}.png`) });
      await click("清空选择");
      check(
        `${width}: cleared comparison remains empty`,
        !(await page.$(root() + ".w-compare-row")) &&
          !(await page.$(root() + '[data-testid="comparison-conclusion"]')),
      );
      await page.keyboard.press("Escape");
      await click("异常发布与附近参与者");
      await wait(".w-process-mark");
      await page.$eval(root() + ".w-process-plot", (e) => e.scrollIntoView({ block: "center" }));
      await readable(".w-process-plot text,.w-process-range-labels>span", "process " + width);
      check(
        `${width}: process SVG is never shrunk below its viewBox width`,
        await page.$eval(
          root() + ".w-process-plot svg",
          (e) => e.getBoundingClientRect().width >= e.viewBox.baseVal.width,
        ),
      );
      await screenshot({ path: path.join(out, `process-${width}.png`) });

      workspace = "mc1-reference";
      await page.goto(base + "/?mc1=reference", { waitUntil: "networkidle0" });
      await wait('.market-chart [data-testid="raw-stock-path"]');
      await screenshot({ path: path.join(out, `mc1-overview-${width}.png`) });
      check(
        `${width}: forecast layer defaults off`,
        !(await page.$(root() + "[data-evidence-kind]")),
      );
      await page.$eval(root() + ".market-chart", (e) => e.scrollIntoView({ block: "center" }));
      check(
        `${width}: focus mode explicitly retains disputed raw prices at the range boundary`,
        await page.$$eval(
          root() + "[data-outside-price]",
          (es) =>
            es.length === 3 &&
            es.some((e) => e.getAttribute("data-outside-price") === "180") &&
            es.filter((e) => e.getAttribute("data-outside-price") === "18").length === 2,
        ),
      );
      check(
        `${width}: focused raw price trend uses enough vertical space to reveal its decline`,
        await page.$$eval(root() + "[data-raw-price]", (es) => {
          const ys = es.map((e) => Number(e.getAttribute("cy")));

          return Math.max(...ys) - Math.min(...ys) > 80;
        }),
      );
      check(
        `${width}: sentiment is a visible categorical step line`,
        await page.$eval(
          root() + '[data-testid="market-sentiment-path"]',
          (e) => e.getAttribute("d").includes("H") && e.getBoundingClientRect().height >= 80,
        ),
      );

      const axisPosition = await page.$eval(
        root() + ".market-fixed-axis",
        (e) => e.getBoundingClientRect().x,
      );

      await page.$eval(root() + ".market-chart .lc-scroll", (e) => (e.scrollLeft = e.scrollWidth));
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      check(
        `${width}: price and sentiment axes stay visible after horizontal scrolling`,
        await page.$eval(
          root() + ".market-fixed-axis",
          (e, left) =>
            Math.abs(e.getBoundingClientRect().x - left) < 1 &&
            [...e.querySelectorAll("[data-price-tick]")].every((t) => {
              const a = t.getBoundingClientRect();
              const b = e.getBoundingClientRect();

              return a.left >= b.left && a.right <= b.left + 150;
            }),
          axisPosition,
        ),
      );
      check(
        `${width}: scrolling never leaves a partial time label under the fixed axis`,
        await page.$$eval(root() + "[data-market-time-label]", (es) =>
          es.every(
            (e) =>
              e.getBoundingClientRect().left >=
              e.closest(".market-plot-frame").getBoundingClientRect().left + 150,
          ),
        ),
      );
      await readable(".market-chart svg text,.market-hover,.scope-badge", "market " + width);
      await screenshot({ path: path.join(out, `market-${width}.png`) });
      await click("全部原值");
      check(
        `${width}: full raw scale restores 180 and both 18 values at actual coordinates`,
        (await page.$$eval(
          root() + "[data-raw-price]",
          (es) =>
            es.some((e) => e.getAttribute("data-raw-price") === "180") &&
            es.filter((e) => e.getAttribute("data-raw-price") === "18").length === 2,
        )) && !(await page.$(root() + "[data-outside-price]")),
      );
      await screenshot({ path: path.join(out, `market-all-values-${width}.png`) });
      await click("走势放大");
      await page.click(root() + ".market-controls input");
      await wait('[data-evidence-kind="forecast"]');
      await screenshot({ path: path.join(out, `market-evidence-${width}.png`) });
      if (width === 1920) {
        await (
          await page.$(root() + ".market-chart")
        ).screenshot({ path: path.join(out, "market-trend-preview.png") });
      }
      await page.$eval(root() + '[data-evidence-kind="forecast"]', (e) =>
        e.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      await wait(".market-details");
      check(
        `${width}: forecast detail retains explicit premise and original missing price`,
        await page.$eval(
          root() + ".market-details",
          (e) =>
            e.textContent.includes("条件预测") &&
            e.textContent.includes("原始价格快照：未记录") &&
            e.textContent.includes("前提与替代情景"),
        ),
      );
      await readable(
        ".market-details p,.market-details code,.market-details button",
        "market detail " + width,
      );
      await page.$eval(root() + ".market-details", (e) => e.scrollIntoView({ block: "center" }));
      await screenshot({ path: path.join(out, `market-detail-${width}.png`) });
      if (width === 1920) {
        await click("关闭详情");
        await page.click(root() + ".lc-series-controls input");
        check(
          "Sentiment alone retains its full categorical staircase",
          !(await page.$(root() + '[data-testid="raw-stock-path"]')) &&
            (await page.$eval(
              root() + '[data-testid="market-sentiment-path"]',
              (e) => !!e.getAttribute("d"),
            )),
        );
        await page.click(root() + ".lc-series-controls label:nth-of-type(2) input");
        check(
          "Hiding both market tracks shows the explicit empty state",
          await page.$eval(root() + ".market-svg", (e) =>
            e.textContent.includes("请选择股价或情绪轨道"),
          ),
        );
        await page.click(root() + ".lc-series-controls input");
        check(
          "Price alone retains the focused trend and source markers",
          !!(await page.$(root() + '[data-testid="raw-stock-path"]')) &&
            !(await page.$(root() + '[data-testid="market-sentiment-path"]')) &&
            !!(await page.$(root() + '[data-outside-price="180"]')),
        );
        await page.click(root() + ".lc-series-controls label:nth-of-type(2) input");
        await page.select(root() + ".tl-scale select", "daily");
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="mc1-reference"]')
              .shadowRoot.querySelector(".market-chart [data-market-bucket]")
              ?.getAttribute("data-market-bucket").length === 10,
        );
        check(
          "Daily market view groups same-day event markers without overlapping labels",
          await page.$$eval(
            root() + '[data-testid="market-event-marker"]',
            (es) => es.length === 1 && es[0].textContent.includes("泄露 / 解禁"),
          ),
        );
        await page.click(root() + '[data-outside-price="18"]');
        await wait(".market-details");
        check(
          "A real click on the boundary marker opens the original daily price and provenance",
          await page.$eval(
            root() + ".market-details",
            (e) => e.textContent.includes("日桶") && e.textContent.includes("原始价格快照：$18"),
          ),
        );
        await page.keyboard.press("Escape");
        check(
          "Escape from market provenance returns keyboard focus to the original marker",
          await page.evaluate(() => {
            const r = document.querySelector('[data-testid="mc1-reference"]').shadowRoot;

            return (
              !r.querySelector(".market-details") &&
              r.activeElement?.getAttribute("data-market-bucket") === "2046-06-05"
            );
          }),
        );
        await page.$eval(root() + ".market-chart", (e) => e.scrollIntoView({ block: "center" }));
        await screenshot({ path: path.join(out, "market-daily-1920.png") });
      }
    }
  }
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
    [768, 1024],
  ]) {
    await page.setViewport({ width, height });
    workspace = "custom-reference";
    await page.goto(base + "/?custom=reference", { waitUntil: "networkidle0" });
    await wait(".cu-case-button:not(:disabled)");
    await screenshot({ path: path.join(out, `custom-collection-${width}.png`) });
    await page.click(root() + '[data-case="custom-stale-published"]');
    await wait('[data-testid="version-graph"]');
    await page.$eval(root() + '[data-testid="version-graph"]', (e) =>
      e.scrollIntoView({ block: "center" }),
    );
    await readable(
      ".cu-svg-scroll svg text,.cu-route small,.cu-checks dd,.cu-status-strip .cu-chip,.cu-status-strip summary,.cu-note,.cu-summary-metrics>span",
      "custom graph " + width,
    );
    check(
      `${width}: CUSTOM graph retains minimum SVG width`,
      await page.$$eval(root() + ".cu-svg-scroll>svg", (els) =>
        els
          .filter((e) => e.getBoundingClientRect().width > 0)
          .every((e) => e.getBoundingClientRect().width >= e.viewBox.baseVal.width - 0.5),
      ),
    );
    await screenshot({ path: path.join(out, `custom-graph-${width}.png`) });
    await click("运行轨迹");
    await wait('[aria-label="六角色真实时间轨迹"]');
    await readable(".cu-svg-scroll svg text,.cu-time-scale>span", "custom trajectory " + width);
    await page.$eval(root() + '[aria-label="六角色真实时间轨迹"]', (e) =>
      e.scrollIntoView({ block: "center" }),
    );
    await screenshot({ path: path.join(out, `custom-trajectory-${width}.png`) });
  }
  check("No browser JavaScript errors", errors.length === 0);
} catch (error) {
  console.error("Browser check failed:", error);
  await screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  fs.writeFileSync(
    path.join(out, process.argv.includes("--custom-only") ? "checks-custom.json" : "checks.json"),
    JSON.stringify({ checks, measurements, errors }, null, 2),
  );
  await browser.close();
}
console.log(`Passed ${checks.length} Chromium readability checks; ${out}`);
