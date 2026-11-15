/** Compare real-browser computed styles, geometry, state and decoded PNG pixels. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const [beforeArgument, afterArgument] = process.argv.slice(2);
assert.ok(
  beforeArgument && afterArgument,
  "Usage: node scripts/compare_light_theme.mjs BEFORE AFTER",
);
const before = path.resolve(beforeArgument);
const after = path.resolve(afterArgument);

const names = fs
  .readdirSync(before)
  .filter((name) => name.endsWith(".styles.json"))
  .sort();

assert.ok(names.length > 0, "Baseline must contain computed-style snapshots");
assert.deepEqual(
  fs
    .readdirSync(after)
    .filter((name) => name.endsWith(".styles.json"))
    .sort(),
  names,
  "Before and after must cover the same checkpoints",
);

const results = [];

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  for (const name of names) {
    const old = JSON.parse(fs.readFileSync(path.join(before, name), "utf8"));
    const next = JSON.parse(fs.readFileSync(path.join(after, name), "utf8"));
    assert.deepEqual(next.viewport, old.viewport, `${name}: viewport must match`);
    const oldNodes = new Map(old.nodes.map((node) => [node.key, node]));
    const nextNodes = new Map(next.nodes.map((node) => [node.key, node]));
    const differences = [];
    for (const key of new Set([...oldNodes.keys(), ...nextNodes.keys()])) {
      const a = oldNodes.get(key);
      const b = nextNodes.get(key);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        differences.push({ key, before: a, after: b });
      }
    }

    const imageName = name.replace(/\.styles\.json$/, ".png");

    const images = [before, after].map(
      (directory) =>
        `data:image/png;base64,${fs.readFileSync(path.join(directory, imageName)).toString("base64")}`,
    );

    const pixels = await page.evaluate(async (sources) => {
      const images = await Promise.all(
        sources.map(
          (src) =>
            new Promise((resolve, reject) => {
              const image = new Image();
              image.onload = () => resolve(image);
              image.onerror = reject;
              image.src = src;
            }),
        ),
      );

      const [a, b] = images;
      if (a.width !== b.width || a.height !== b.height) {
        return { sizeMismatch: true, before: [a.width, a.height], after: [b.width, b.height] };
      }
      const canvas = document.createElement("canvas");
      canvas.width = a.width;
      canvas.height = a.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(a, 0, 0);
      const first = context.getImageData(0, 0, a.width, a.height);
      context.clearRect(0, 0, a.width, a.height);
      context.drawImage(b, 0, 0);
      const second = context.getImageData(0, 0, a.width, a.height);
      let changed = 0;
      const diff = context.createImageData(a.width, a.height);
      for (let i = 0; i < first.data.length; i += 4) {
        const different = [0, 1, 2, 3].some(
          (channel) => first.data[i + channel] !== second.data[i + channel],
        );

        if (different) {
          changed++;
          diff.data[i] = 240;
          diff.data[i + 3] = 255;
        }
      }
      context.putImageData(diff, 0, 0);

      return {
        changed,
        total: a.width * a.height,
        diff: changed ? canvas.toDataURL("image/png") : null,
      };
    }, images);

    if (pixels.diff) {
      fs.writeFileSync(
        path.join(after, imageName.replace(/\.png$/, ".diff.png")),
        Buffer.from(pixels.diff.split(",")[1], "base64"),
      );
      delete pixels.diff;
    }
    results.push({ name, nodes: next.nodes.length, differences, pixels });
    console.log(
      `${name}: ${differences.length} changed nodes; ${pixels.changed ?? "size mismatch"} changed pixels`,
    );
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(after, "comparison.json"), JSON.stringify(results, null, 2));
assert.ok(
  results.every((result) => !result.differences.length),
  "Computed style/state/size changes need review; see comparison.json",
);
const pixelDifferences = results.filter((result) => result.pixels.changed !== 0);
console.log(`PASS ${results.length} computed style/state/size checkpoints match exactly`);
if (pixelDifferences.length) {
  console.warn(
    `REVIEW ${pixelDifferences.length} screenshots have exact pixel differences; see comparison.json and *.diff.png`,
  );
}
if (process.argv.includes("--strict-pixels")) {
  assert.equal(
    pixelDifferences.length,
    0,
    "Strict pixel comparison requires identical screenshots",
  );
}
