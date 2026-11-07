/** Behavior checks against the same TS modules imported by WorkspaceProvider. No test framework. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundled = await build({ stdin: { contents: 'export * from "./frontend/src/state/workspaceReducer.ts"; export * from "./frontend/src/state/snapshot.ts";', resolveDir: root }, bundle: true, write: false, platform: "node", format: "esm" });
const m = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`PASS ${name}`); };
const reduce = m.workspaceReducer;
let state = m.initialWorkspace("MC2");
test("MC2 defaults to system overview", () => {
  assert.equal(state.task, "overview");
  assert.equal(state.mode, "system");
  assert.equal(state.taskModes.overview, "system");
});
state = reduce(state, { type: "openTrace", rootEventId: "MC2:event:373902", fileId: "MC2:missing-file" });
state = reduce(state, { type: "inspect", selection: { kind: "event", id: "MC2:event:21202", timeUs: 0 } });
test("selection preserves MC2 root/file", () => assert.equal(state.traceObject.rootEventId, "MC2:event:373902"));
state = reduce(state, { type: "task", task: "overview" });
state = reduce(state, { type: "task", task: "trace" });
test("MC2 trace context survives overview round trip", () => {
  assert.equal(state.traceObject.rootEventId, "MC2:event:373902");
  assert.equal(state.traceObject.fileId, "MC2:missing-file");
  assert.equal(state.mode, "source");
});
state = reduce(state, { type: "focus", id: "MC2:missing-entity" });
test("graph focus does not add participant filter", () => assert.equal(state.baseEventFilters.participantId, null));
state = reduce(state, { type: "task", task: "compare", mode: "window" });
state = reduce(state, { type: "filters", patch: { startUs: 100, endUs: 200, keyword: "x" } });
state = reduce(state, { type: "comparePatch", patch: { mode: "manual", baselineStartUs: 0, baselineEndUs: 99, dimension: "actor" } });
state = reduce(state, { type: "display", patch: { viewports: { time: { startUs: 110, endUs: 160, expanded: ["a"] } }, graphContext: { focusedEntityId: "MC2:missing-entity", depth: 3, transform: { x: 4, y: 8, k: 2 } } } });
const before = m.returnPoint(state);
test("current comparison window atomically matches base filters; baseline independent", () => {
  assert.deepEqual(state.comparison.currentUs, [100, 200]); assert.deepEqual(state.comparison.baselineUs, [0, 99]);
});
state = reduce(state, { type: "drillFilters", patch: { eventTypes: ["file_read"], startUs: 120, endUs: 140 } });
state = reduce(state, { type: "return" });
test("explicit drill return restores filters, dimension, baseline, viewport and graph context", () => assert.deepEqual(m.returnPoint(state), before));
state = reduce(state, { type: "clearFilters" });
test("clear time clears comparison.currentUs only", () => { assert.equal(state.comparison.currentUs, null); assert.deepEqual(state.comparison.baselineUs, [0, 99]); });
test("invalid half-open window is rejected without changing range", () => assert.equal(reduce(state, { type: "filters", patch: { startUs: 3, endUs: 3 } }).baseEventFilters.startUs, null));
state = reduce(m.initialWorkspace("CUSTOM"), { type: "openRun", runId: "missing-run", baselineRunId: "missing-baseline", complete: true });
state = reduce(state, { type: "filters", patch: { keyword: "publish" } });
state = reduce(state, { type: "inspect", selection: { kind: "event", id: "CUSTOM:missing-event", timeUs: 0 } });
state = reduce(state, { type: "replay", cursorUs: 42, playing: true, masking: false });
state = reduce(state, { type: "display", patch: { collectionFilters: { model: "model", fixture: "fixture", scenario: "normal", observed: false }, viewports: { run: { startUs: 0, endUs: 20 } } } });
test("CUSTOM selection does not replace run/pair", () => { assert.equal(state.traceObject.runId, "missing-run"); assert.equal(state.comparison.baselineRunId, "missing-baseline"); });
state = reduce(state, { type: "clearFilters" });
test("clear filters preserves object scope; base has no runId", () => { assert.equal(m.composeEventFilters(state.baseEventFilters, state.traceObject).runId, "missing-run"); assert.ok(!("runId" in state.baseEventFilters)); });
const snap = m.serializeSnapshot(state);
test("snapshot excludes playing, hover, timer and API payload", () => { assert.ok(!("playing" in snap.replay)); assert.ok(!("hover" in snap)); assert.ok(!("timer" in snap)); });
let plan = m.planRestore(snap, { dataset: "CUSTOM", savedDataVersion: "old", currentDataVersion: "new" });
let restored = reduce(m.initialWorkspace("CUSTOM"), m.restoreAction(plan));
test("new snapshot round trip retains run, pair, selection, collection, display and return point", () => assert.deepEqual(m.serializeSnapshot(restored), snap));
test("restore pauses and marks stale without rewriting snapshot", () => { assert.equal(restored.playing, false); assert.equal(plan.stale, true); assert.equal(snap.trace_object.runId, "missing-run"); });
test("overview exits run scope and preserves collection filters", () => {
  const next = reduce(state, { type: "task", task: "overview", mode: "runs" });
  assert.equal(m.composeEventFilters(next.baseEventFilters, next.traceObject).runId, null); assert.deepEqual(next.collectionFilters, state.collectionFilters);
});
test("dataset switch atomically clears all cross-dataset investigation refs and playback", () => {
  const next = reduce(state, { type: "dataset", dataset: "MC1" });
  assert.equal(next.playing, false); assert.equal(next.selection, null); assert.equal(next.comparison, null); assert.equal(next.returnStack.length, 0); assert.equal(next.graphContext.focusedEntityId, null);
});
test("unsupported task/mode falls back with explanation", () => {
  const next = reduce(m.initialWorkspace("MC1"), { type: "task", task: "compare", mode: "history" });
  assert.equal(next.mode, "window"); assert.ok(next.notice); assert.equal(next.comparison.kind, "window");
});
test("return history capped at 20; replay ticks do not enter history", () => {
  let next = m.initialWorkspace("MC2");
  for (let i = 0; i < 30; i++) next = reduce(next, { type: "openTrace", rootEventId: `MC2:event:${i}` });
  assert.equal(next.returnStack.length, 20);
  const stack = next.returnStack;
  next = reduce(next, { type: "step", deltaUs: 1 }); assert.equal(next.returnStack, stack);
});
for (const [dataset, canvas, task, mode] of [
  ["MC1", "timeline", "overview", "activity"], ["MC2", "timeline", "overview", "time"], ["CUSTOM", "timeline", "overview", "runs"],
  ["MC2", "graph", "overview", "relations"], ["MC1", "compare", "compare", "window"], ["MC2", "trace", "trace", "source"],
]) test(`legacy ${dataset}/${canvas} migrates`, () => {
  const p = m.planRestore({ contract_version: 2, canvas_view: canvas, filters: {} }, { dataset });
  assert.equal(p.status, "ready"); assert.equal(p.investigation.task, task); assert.equal(p.investigation.mode, mode);
});
test("legacy CUSTOM runId takes priority over canvas", () => {
  const p = m.planRestore({ canvas_view: "compare", filters: { runId: "missing-run" } }, { dataset: "CUSTOM" });
  assert.equal(p.status, "ready"); assert.equal(p.investigation.task, "trace"); assert.equal(p.investigation.traceObject.runId, "missing-run"); assert.equal(p.investigation.comparison, null);
});
test("future snapshots expose metadata/export only and are not downgraded", () => assert.equal(m.planRestore({ ...snap, ui_state_version: 2, future: { x: 1 } }, { dataset: "CUSTOM" }).status, "unsupported"));
for (const bad of [null, [], { ...snap, mode: "source" }, { ...snap, replay: { cursorUs: 1.5, masking: true } }, { ...snap, base_filters: { ...snap.base_filters, runId: "hidden" } }, { ...snap, viewports: { hover: {} } }, { ...snap, viewports: { huge: "中".repeat(100000) } }]) {
  test("corrupt/illegal/oversize snapshot safely rejected", () => assert.equal(m.planRestore(bad, { dataset: "CUSTOM" }).status, "invalid"));
}
test("cross-dataset snapshot rejected", () => assert.equal(m.planRestore(snap, { dataset: "MC2" }).status, "invalid"));
test("cross-dataset event ref rejected even with same outer dataset", () => {
  const s = structuredClone(snap); s.selection.id = "MC1:event:wrong";
  assert.equal(m.planRestore(s, { dataset: "CUSTOM" }).status, "invalid");
});
test("viewport clamps without rewriting original snapshot; missing references remain visible", () => {
  const p = m.planRestore(snap, { dataset: "CUSTOM", bounds: { startUs: 5, endUs: 10 }, missingReferences: ["missing-run"] });
  assert.equal(p.status, "ready"); assert.deepEqual(p.investigation.viewports.run, { startUs: 5, endUs: 10 });
  assert.deepEqual(snap.viewports.run, { startUs: 0, endUs: 20 }); assert.ok(p.summary.some((s) => s.includes("missing-run")));
});
test("complete-run action synchronizes existing window comparison", () => {
  let s = reduce(m.initialWorkspace("CUSTOM"), { type: "canvas", view: "compare" });
  s = reduce(s, { type: "filters", patch: { startUs: 1, endUs: 2 } });
  s = reduce(s, { type: "openRun", runId: "missing-run", complete: true });
  assert.equal(s.comparison.currentUs, null); m.serializeSnapshot(s);
});
test("resolved automatic pair and window enter snapshot; late responses do not overwrite newer object", () => {
  let s = reduce(m.initialWorkspace("CUSTOM"), { type: "openRun", runId: "a", compare: true });
  s = reduce(s, { type: "resolvedPair", runId: "a", baselineRunId: "b" });
  assert.equal(m.serializeSnapshot(s).comparison.baselineRunId, "b");
  assert.equal(reduce(s, { type: "resolvedPair", runId: "old", baselineRunId: "wrong" }), s);
  s = reduce(m.initialWorkspace("MC2"), { type: "canvas", view: "compare" });
  s = reduce(s, { type: "filters", patch: { startUs: 10, endUs: 20 } });
  s = reduce(s, { type: "resolvedWindow", currentUs: [10, 20], baselineUs: [0, 10] });
  assert.deepEqual(m.serializeSnapshot(s).comparison.baselineUs, [0, 10]);
  assert.equal(reduce(s, { type: "resolvedWindow", currentUs: [20, 30], baselineUs: [10, 20] }), s);
});
test("unsupported playback views pause, preserve cursor and never resume on return", () => {
  let s = reduce(m.initialWorkspace("MC2"), { type: "replay", cursorUs: 9, playing: true });
  s = reduce(s, { type: "task", task: "overview", mode: "system" });
  assert.equal(s.playing, false); assert.equal(s.replay.cursorUs, 9);
  s = reduce(s, { type: "togglePlaying" }); assert.equal(s.playing, false);
  s = reduce(s, { type: "canvas", view: "timeline" }); assert.equal(s.playing, false);
});
test("functional cursor updates compose atomically without entering return history", () => {
  let s = reduce(m.initialWorkspace("MC1"), { type: "cursor", value: 0 });
  s = reduce(s, { type: "cursor", value: (previous) => previous + 1 });
  s = reduce(s, { type: "cursor", value: (previous) => previous + 1 });
  assert.equal(s.replay.cursorUs, 2); assert.equal(s.returnStack.length, 0);
});
test("CUSTOM pair survives overview, re-entry, legacy run changes and return points", () => {
  let s = reduce(m.initialWorkspace("CUSTOM"), { type: "openRun", runId: "a", baselineRunId: "b" });
  s = reduce(s, { type: "task", task: "overview", mode: "runs" });
  assert.equal(m.composeEventFilters(s.baseEventFilters, s.traceObject).runId, null);
  m.serializeSnapshot(s);
  s = reduce(s, { type: "task", task: "compare", mode: "runPair" });
  assert.equal(s.traceObject.runId, "a"); assert.equal(s.comparison.baselineRunId, "b");
  m.serializeSnapshot(s);
  s = reduce(s, { type: "drillFilters", patch: { runId: "c" } });
  m.serializeSnapshot(s);
  s = reduce(s, { type: "return" });
  assert.equal(s.traceObject.runId, "a"); assert.equal(s.comparison.baselineRunId, "b");
  m.serializeSnapshot(s);
  for (const runId of ["c", null, "a"]) {
    s = reduce(s, { type: "filters", patch: { runId } });
    assert.equal(s.comparison.runId, runId); assert.equal(s.comparison.baselineRunId, null);
    m.serializeSnapshot(s);
  }
  s = reduce(s, { type: "openRun", runId: "d" }); m.serializeSnapshot(s);
  s = reduce(s, { type: "task", task: "compare", mode: "runPair" });
  assert.equal(s.traceObject.runId, "d"); assert.equal(s.comparison.runId, "d");
  m.serializeSnapshot(s);
});
test("comparison replacement, clearing and legacy window controls remain serializable", () => {
  let s = reduce(m.initialWorkspace("CUSTOM"), { type: "openRun", runId: "a", baselineRunId: "b" });
  s = reduce(s, { type: "comparison", comparison: { kind: "runPair", runId: "c", baselineRunId: "d" } });
  assert.equal(s.traceObject.runId, "c"); m.serializeSnapshot(s);
  s = reduce(s, { type: "comparison", comparison: null }); m.serializeSnapshot(s);
  s = reduce(s, { type: "comparePatch", patch: { dimension: "actor" } });
  assert.equal(s.mode, "window"); m.serializeSnapshot(s);
  s = reduce(s, { type: "comparison", comparison: { kind: "runPair", runId: null, baselineRunId: null } });
  assert.equal(s.mode, "runPair"); assert.equal(s.traceObject.runId, null); m.serializeSnapshot(s);
});
for (const filters of [{ startUs: 10, endUs: 5 }, { startUs: 5, endUs: 5 },
  { startUs: "oops", endUs: 20 }, { startUs: 1.5, endUs: 20 }, { startUs: true },
  { endUs: Number.MAX_SAFE_INTEGER + 1 }, { startUs: [], endUs: 20 }]) {
  test(`invalid legacy time window is rejected: ${JSON.stringify(filters)}`, () => {
    const p = m.planRestore({ canvas_view: "timeline", filters }, { dataset: "MC1" });
    assert.equal(p.status, "invalid"); assert.ok(p.summary[0].includes("无法恢复"));
  });
}
for (const filters of [{}, { startUs: null, endUs: null }, { startUs: 0, endUs: null }, { startUs: null, endUs: 20 }, { startUs: 0, endUs: 20 }]) {
  test(`valid legacy open endpoints remain exact: ${JSON.stringify(filters)}`, () => {
    const p = m.planRestore({ filters }, { dataset: "MC1" });
    assert.equal(p.status, "ready");
    assert.equal(p.investigation.baseEventFilters.startUs, filters.startUs ?? null);
    assert.equal(p.investigation.baseEventFilters.endUs, filters.endUs ?? null);
  });
}
test("canonical specification modes and trace localGraph serialize for every dataset", () => {
  for (const dataset of ["MC1", "MC2", "CUSTOM"]) {
    for (const [task, modes] of Object.entries(m.CAPABILITIES[dataset])) for (const mode of modes) {
      let s = reduce(m.initialWorkspace(dataset), { type: "task", task, mode });
      assert.ok(!["timeline", "local", "messages", "file"].includes(s.mode));
      assert.equal(m.planRestore(m.serializeSnapshot(s), { dataset }).status, "ready");
    }
    const s = reduce(m.initialWorkspace(dataset), { type: "task", task: "trace", mode: "localGraph" });
    assert.equal(s.mode, "localGraph"); assert.equal(m.canvasProjection(s), "graph");
    m.serializeSnapshot(s);
  }
});
test("persisted v1 aliases including return points migrate without changing original", () => {
  for (const [dataset, task, alias, canonical] of [["MC1", "overview", "timeline", "time"],
    ["CUSTOM", "overview", "local", "relations"], ["MC1", "trace", "messages", "decision"],
    ["MC2", "trace", "file", "source"]]) {
    const s = reduce(m.initialWorkspace(dataset), { type: "task", task, mode: canonical });
    const saved = m.serializeSnapshot(s);
    const { contract_version, ui_state_version, return_point, ...point } = structuredClone(saved);
    saved.return_point = point;
    for (const b of [saved, saved.return_point]) { b.mode = alias; b.task_modes[task] = alias; }
    const original = structuredClone(saved), p = m.planRestore(saved, { dataset });
    assert.equal(p.status, "ready"); assert.equal(p.investigation.mode, canonical);
    assert.equal(p.returnPoint.mode, canonical); assert.ok(p.summary.some((line) => line.includes(alias)));
    assert.deepEqual(saved, original);
    const again = m.serializeSnapshot(reduce(m.initialWorkspace(dataset), m.restoreAction(p)));
    assert.equal(again.mode, canonical); assert.equal(again.return_point.mode, canonical);
  }
});
// Shared fixture consumed by backend tests, proving cross-language contract compatibility.
const out = path.join(root, "build/ui-refactor/S0"); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "snapshot-v1-fixture.json"), JSON.stringify(snap, null, 2));
const modeFixtures = [];
for (const dataset of Object.keys(m.CAPABILITIES)) for (const [task, modes] of Object.entries(m.CAPABILITIES[dataset])) {
  for (const mode of modes) modeFixtures.push(m.serializeSnapshot(reduce(m.initialWorkspace(dataset), { type: "task", task, mode })));
}
fs.writeFileSync(path.join(out, "snapshot-mode-fixtures.json"), JSON.stringify(modeFixtures, null, 2));
console.log(`${count} workspace/snapshot behavior checks passed`);
