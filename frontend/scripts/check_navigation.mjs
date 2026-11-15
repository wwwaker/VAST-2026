/** URL compatibility and bundle boundaries after retiring the legacy UI. */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";
import { createRequire } from "node:module";

const bundle = await build({
  entryPoints: ["src/app/navigation.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});

const mod = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
);
const { datasetFromUrl, normalizeWorkspaceUrl, selectDatasetUrl } = mod.exports;
const url = (query) => new URL(`http://localhost/${query}`);
assert.equal(datasetFromUrl(url("")), "MC2");
for (const dataset of ["MC1", "MC2", "CUSTOM"]) {
  const key = dataset.toLowerCase();
  assert.equal(datasetFromUrl(url(`?${key}=reference`)), dataset);
  const old = normalizeWorkspaceUrl(url(`?${key}=legacy&bench=1&run=keep&tab=trajectory`));
  assert.equal(datasetFromUrl(old), dataset);
  assert.equal(old.searchParams.get(key), "reference");
  assert.equal(old.searchParams.get("run"), "keep");
  assert.equal(old.searchParams.get("tab"), "trajectory");
  assert.ok(!old.searchParams.has("bench"));
}

const selected = selectDatasetUrl(
  url("?mc1=legacy&custom=reference&run=old&baseline=old&tab=version&keep=yes"),
  "MC2",
);

assert.equal(selected.search, "?keep=yes&mc2=reference");

const app = await build({
  entryPoints: ["src/app/App.tsx"],
  bundle: true,
  platform: "browser",
  write: false,
  metafile: true,
  external: ["react", "react-dom"],
  logLevel: "silent",
  plugins: [
    {
      name: "inline-css",
      setup(builder) {
        builder.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.replace(/\?inline$/, "")),
          namespace: "inline-css",
        }));
        builder.onLoad({ filter: /.*/, namespace: "inline-css" }, (args) => ({
          contents: `export default ${JSON.stringify(fs.readFileSync(args.path, "utf8"))}`,
          loader: "js",
        }));
      },
    },
  ],
});

assert.ok(
  !Object.keys(app.metafile.inputs).some((file) =>
    /compatibility|workspaceReducer|snapshot\.ts|src\/views\//.test(file),
  ),
);
console.log(
  "PASS dataset navigation, old bookmarks, URL state and isolated current application bundle",
);
