"""UI snapshot validation, independent of event/notes schemas. Never rewrites stored JSON.

POST: legacy v2 accepted, v1 strictly validated, unknown UI versions rejected.
GET/export: all stored versions preserved; unsupported/corrupt are metadata-only.
Missing references are retained; known ownership in another dataset is rejected on POST.
"""
from __future__ import annotations

import json
import math

MAX_BYTES = 256 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
CAPABILITIES = {
    "MC1": {"overview": ["activity", "time", "relations"], "trace": ["decision", "localGraph"], "compare": ["window"], "findings": ["claims", "notes"]},
    "MC2": {"overview": ["system", "time", "relations"], "trace": ["source", "localGraph", "intervention"], "compare": ["history", "window", "transitions"], "findings": ["claims", "notes"]},
    "CUSTOM": {"overview": ["runs", "time", "relations"], "trace": ["run", "localGraph"], "compare": ["runPair", "window"], "findings": ["claims", "notes"]},
}
BODY_KEYS = {"dataset_id", "task", "mode", "base_filters", "trace_object", "selection", "comparison", "task_modes", "viewports", "graph_context", "collection_filters", "replay", "intervention_position", "pinned_evidence"}
FILTER_KEYS = {"startUs", "endUs", "categories", "eventTypes", "actorId", "participantId", "channels", "keyword"}


class SnapshotError(ValueError):
    pass


def _check(condition, message="invalid UI snapshot structure"):
    if not condition:
        raise SnapshotError(message)


def _obj(value):
    _check(isinstance(value, dict), "expected object")
    return value


def _fields(value, allowed, required=None):
    _obj(value)
    _check(set(value) <= set(allowed) and set(required if required is not None else allowed) <= set(value), "unknown or missing UI snapshot fields")


def _string(value, nullable=False):
    _check((nullable and value is None) or isinstance(value, str), "expected string reference")


def _us(value):
    _check(value is None or (type(value) is int and abs(value) <= MAX_SAFE_INTEGER), "expected safe integer microseconds")


def _strings(value):
    _check(isinstance(value, list), "expected string array")
    for item in value:
        _string(item)


def _window(value):
    if value is None:
        return
    _check(isinstance(value, list) and len(value) == 2, "expected two window endpoints")
    for item in value:
        _us(item)
    _check(None not in value and value[0] < value[1], "invalid half-open window")


def _display(value, depth=0):
    _check(depth <= 10, "display config nesting exceeds budget")
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, (int, float)):
        _check(math.isfinite(value), "non-finite display parameter")
        return
    if isinstance(value, list):
        _check(len(value) <= 800, "display array exceeds budget")
        for item in value:
            _display(item, depth + 1)
        return
    for key, item in _obj(value).items():
        _check(key not in {"__proto__", "constructor", "prototype", "hover", "timer", "payload", "events", "nodes", "edges"}, "transient state/API payload is not a display config")
        _display(item, depth + 1)


def _filters(value, legacy=False):
    f = _obj(value)
    if not legacy:
        _fields(f, FILTER_KEYS)
    for key in ("startUs", "endUs"):
        if key in f:
            _us(f[key])
    if f.get("startUs") is not None and f.get("endUs") is not None:
        _window([f["startUs"], f["endUs"]])
    for key in ("actorId", "participantId", "runId"):
        if key in f:
            _string(f[key], True)
    for key in ("eventTypes", "channels"):
        if key in f:
            _strings(f[key])
    if "categories" in f:
        _check(isinstance(f["categories"], list) and all(type(n) is int and 1 <= n <= 8 for n in f["categories"]), "invalid categories")
    if "keyword" in f:
        _string(f["keyword"])


def _selection(value):
    if value is None:
        return
    s = _obj(value)
    shapes = {
        "event": ["id", "timeUs"], "entity": ["id"], "file": ["id"], "context": ["id"], "rule": ["id"],
        "activityCell": ["agentId", "bucketKey"], "graphEdge": ["sourceId", "targetId", "relation", "derivation"],
        "transitionCell": ["fromType", "toType"], "eventGroup": ["viewId", "eventIds"], "gap": ["scopeId", "key"],
    }
    kind = s.get("kind")
    _check(isinstance(kind, str) and kind in shapes, "unknown selection kind")
    _fields(s, ["kind", *shapes[kind]])
    for key in shapes[kind]:
        if key == "timeUs":
            _us(s[key])
        elif key == "eventIds":
            _strings(s[key])
            _check(len(s[key]) <= 800, "event group exceeds budget")
        else:
            _string(s[key])


def _canonical_body(value, dataset):
    """Normalize persisted v1 aliases for validation only; never mutate stored JSON."""
    b = dict(_obj(value))
    def canonical(task, mode):
        if task == "overview":
            return "time" if mode == "timeline" else "relations" if mode == "local" else mode
        if task == "trace":
            if mode == "messages" and dataset == "MC1":
                return "decision"
            if mode == "file" and dataset == "MC2":
                return "source"
        return mode
    b["mode"] = canonical(b.get("task"), b.get("mode"))
    b["task_modes"] = {task: canonical(task, mode) for task, mode in _obj(b.get("task_modes")).items()}
    return b


def _body(value, dataset):
    _fields(value, BODY_KEYS)
    b = _canonical_body(value, dataset)
    _check(b["dataset_id"] == dataset, "snapshot dataset mismatch")
    task = b["task"]
    _check(isinstance(task, str) and task in CAPABILITIES[dataset], "unsupported task")
    _check(b["mode"] in CAPABILITIES[dataset][task], "mode not supported by dataset/task")
    modes = _obj(b["task_modes"])
    _fields(modes, CAPABILITIES[dataset])
    for key, mode in modes.items():
        _check(mode in CAPABILITIES[dataset][key], "unsupported task mode")
    _check(modes[task] == b["mode"], "task/mode out of sync")
    _filters(b["base_filters"])
    t = _obj(b["trace_object"])
    _check(t.get("dataset") == dataset, "trace dataset mismatch")
    if dataset == "MC1":
        _fields(t, ["dataset", "windowUs"])
        _window(t["windowUs"])
    elif dataset == "MC2":
        _fields(t, ["dataset", "rootEventId", "fileId"])
        _string(t["rootEventId"], True)
        _string(t["fileId"], True)
    else:
        _fields(t, ["dataset", "runId"])
        _string(t["runId"], True)
    _selection(b["selection"])
    c = b["comparison"]
    if c is not None:
        c = _obj(c)
        kind = c.get("kind")
        if kind == "window":
            _fields(c, ["kind", "dimension", "currentUs", "baselineMode", "baselineUs"])
            _check(c["dimension"] in ("actor", "event_type") and c["baselineMode"] in ("auto", "manual"), "invalid window comparison enums")
            _window(c["currentUs"])
            _window(c["baselineUs"])
            f = b["base_filters"]
            current = [f["startUs"], f["endUs"]] if f["startUs"] is not None and f["endUs"] is not None else None
            _check(c["currentUs"] == current, "comparison window differs from event filters")
        elif kind == "runPair" and dataset == "CUSTOM":
            _fields(c, ["kind", "runId", "baselineRunId"])
            _string(c["runId"], True)
            _string(c["baselineRunId"], True)
        elif kind == "history" and dataset == "MC2":
            _fields(c, ["kind", "targetRootId", "includedRootIds", "alignment", "beforeUs"])
            _string(c["targetRootId"], True)
            _strings(c["includedRootIds"])
            _check(c["alignment"] in ("stage", "postTime"), "invalid history alignment")
            _us(c["beforeUs"])
        elif kind == "transitions" and dataset == "MC2":
            _fields(c, ["kind", "selectedPair", "maxLagUs"])
            _us(c["maxLagUs"])
            _check(c["maxLagUs"] is None or c["maxLagUs"] >= 0, "negative transition interval")
            if c["selectedPair"] is not None:
                _strings(c["selectedPair"])
                _check(len(c["selectedPair"]) == 2, "expected transition pair")
        else:
            raise SnapshotError("comparison not supported by dataset")
    if task == "compare":
        _check(c is not None and c["kind"] == b["mode"], "comparison/mode out of sync")
    if b["mode"] == "runPair":
        _check(t["runId"] == c["runId"], "run pair/trace out of sync")
    g = _obj(b["graph_context"])
    _fields(g, ["focusedEntityId", "depth", "transform"], ["focusedEntityId", "depth"])
    _string(g["focusedEntityId"], True)
    _check(type(g["depth"]) is int and g["depth"] in (1, 2, 3), "invalid graph depth")
    if "transform" in g:
        _fields(g["transform"], ["x", "y", "k"])
        _check(all(type(n) in (int, float) and math.isfinite(n) for n in g["transform"].values()) and g["transform"]["k"] > 0, "invalid graph transform")
    _obj(b["viewports"])
    _display(b["viewports"])
    collection = b["collection_filters"]
    _fields(collection, ["model", "fixture", "scenario", "observed"])
    for key in ("model", "fixture", "scenario"):
        _string(collection[key], True)
    _check(collection["observed"] is None or type(collection["observed"]) is bool, "invalid observed")
    replay = b["replay"]
    _fields(replay, ["cursorUs", "masking"])
    _us(replay["cursorUs"])
    _check(type(replay["masking"]) is bool, "invalid masking")
    _string(b["intervention_position"], True)
    _check(dataset == "MC2" or b["intervention_position"] is None, "intervention only supported by MC2")
    _check(isinstance(b["pinned_evidence"], list), "expected evidence array")
    for e in b["pinned_evidence"]:
        _fields(e, ["event_id", "dataset", "role", "label", "excerpt"])
        _check(e["dataset"] == dataset, "pinned evidence dataset mismatch")
        _check(e["role"] in ("support", "counter", "uncertain"), "invalid evidence role")
        for key in ("event_id", "label", "excerpt"):
            _string(e[key])


def references(snapshot):
    """Extract only typed reference fields; do not interpret arbitrary display text as IDs."""
    refs = []
    def add(kind, value):
        if isinstance(value, str) and value:
            refs.append((kind, value))
    def body(b):
        if "ui_state_version" not in snapshot:
            # Legacy migration consumes only these fields. Modern-looking extensions
            # and unknown extras are opaque, not v1 references or restore instructions.
            f = b.get("filters", {})
            for key in ("actorId", "participantId"):
                add("entity", f.get(key))
            add("run", f.get("runId"))
            for channel in f.get("channels", []):
                add("entity", channel)
            for e in b.get("pinned_evidence", []):
                add("event", e.get("event_id"))
            for key, kind in (("selected_event_id", "event"), ("trace_root_id", "event"), ("focused_entity_id", "entity"), ("trace_file_id", "entity"), ("selected_run_id", "run")):
                add(kind, b.get(key))
            for run_id in b.get("run_pair") or []:
                add("run", run_id)
            return
        f = b.get("base_filters", b.get("filters")) or {}
        for key in ("actorId", "participantId"):
            add("entity", f.get(key))
        add("run", f.get("runId"))
        for channel in f.get("channels", []):
            add("entity", channel)
        t = b.get("trace_object") or {}
        add("event", t.get("rootEventId")); add("entity", t.get("fileId")); add("run", t.get("runId"))
        s = b.get("selection") or {}
        if s.get("kind") in ("event", "entity", "file"):
            add("event" if s["kind"] == "event" else "entity", s.get("id"))
        for event_id in s.get("eventIds", []):
            add("event", event_id)
        if s.get("kind") == "activityCell":
            add("entity", s.get("agentId"))
        if s.get("kind") == "graphEdge":
            # Graph endpoints can be event or entity references; resolve actual ownership across both.
            add("object", s.get("sourceId")); add("object", s.get("targetId"))
        c = b.get("comparison") or {}
        add("event", c.get("targetRootId"))
        for root in c.get("includedRootIds", []):
            add("event", root)
        add("run", c.get("runId")); add("run", c.get("baselineRunId"))
        add("entity", (b.get("graph_context") or {}).get("focusedEntityId"))
        for e in b.get("pinned_evidence", []):
            add("event", e.get("event_id"))
        for key, kind in (("selected_event_id", "event"), ("trace_root_id", "event"), ("focused_entity_id", "entity"), ("trace_file_id", "entity"), ("selected_run_id", "run")):
            add(kind, b.get(key))
        for run_id in b.get("run_pair") or []:
            add("run", run_id)
    body(snapshot)
    if "ui_state_version" in snapshot and snapshot.get("return_point"):
        body(snapshot["return_point"])
    return sorted(set(refs))


def reference_status(conn, snapshot, dataset):
    refs = references(snapshot)
    ownership = {"event": {}, "entity": {}, "run": {}}
    ids = sorted({ref for _, ref in refs})
    # Bounded batches, never one query per reference.
    for start in range(0, len(ids), 500):
        batch = ids[start:start + 500]
        placeholders = ",".join("?" for _ in batch)
        for kind, table, column in (("event", "events", "event_id"), ("entity", "entities", "entity_id"), ("run", "runs", "run_id")):
            for row in conn.execute(f"SELECT dataset_id, {column} FROM {table} WHERE {column} IN ({placeholders})", batch):
                ownership[kind].setdefault(row[column], set()).add(row["dataset_id"])
    missing, cross = [], []
    for kind, ref in refs:
        owners = ownership[kind].get(ref, set()) if kind != "object" else ownership["event"].get(ref, set()) | ownership["entity"].get(ref, set())
        known_owners = ownership["event"].get(ref, set()) | ownership["entity"].get(ref, set()) | ownership["run"].get(ref, set())
        prefix = ref.split(":", 1)[0]
        if (known_owners and dataset not in known_owners) or (not known_owners and prefix in CAPABILITIES and prefix != dataset):
            cross.append({"kind": kind, "id": ref})
        elif not owners:
            missing.append({"kind": kind, "id": ref})
    return {"missing_references": missing, "cross_dataset_references": cross}


def validate(snapshot, dataset, conn):
    _obj(snapshot)
    try:
        encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, RecursionError) as exc:
        raise SnapshotError("snapshot is not safe JSON") from exc
    _check(len(encoded) <= MAX_BYTES, "snapshot exceeds 256 KiB UTF-8")
    _check(snapshot.get("contract_version", 2) == 2, "unsupported time contract")
    _check(snapshot.get("dataset_id", dataset) == dataset, "snapshot dataset mismatch")
    version = snapshot.get("ui_state_version")
    if "ui_state_version" in snapshot:
        _check(type(version) is int and version == 1, "unsupported UI snapshot version; export only")
        _check(type(snapshot.get("contract_version")) is int and snapshot.get("contract_version") == 2, "UI v1 requires contract v2")
        _fields(snapshot, BODY_KEYS | {"contract_version", "ui_state_version", "return_point"})
        _body({key: snapshot[key] for key in BODY_KEYS}, dataset)
        if snapshot["return_point"] is not None:
            _body(snapshot["return_point"], dataset)
    else:
        _filters(snapshot.get("filters", {}), legacy=True)
        # Known extension containers must have safe shapes, but their contents
        # remain opaque in legacy snapshots and are preserved on export.
        for key in ("selection", "comparison", "trace_object", "graph_context", "base_filters", "return_point"):
            if key in snapshot and snapshot[key] is not None:
                _obj(snapshot[key])
        _check(snapshot.get("canvas_view", "timeline") in ("timeline", "graph", "compare", "trace"), "invalid legacy canvas")
        _check(dataset == "CUSTOM" or not snapshot.get("filters", {}).get("runId"), "runId only supported by CUSTOM")
        for key in ("selected_event_id", "focused_entity_id", "trace_root_id", "trace_file_id", "selected_run_id"):
            if key in snapshot:
                _string(snapshot[key], True)
        if "run_pair" in snapshot and snapshot["run_pair"] is not None:
            _strings(snapshot["run_pair"])
            _check(len(snapshot["run_pair"]) == 2 and dataset == "CUSTOM", "invalid legacy run pair")
        if "pinned_evidence" in snapshot:
            _check(isinstance(snapshot["pinned_evidence"], list), "invalid legacy evidence")
            for e in snapshot["pinned_evidence"]:
                _string(_obj(e).get("event_id"))
                _check(e.get("role") in ("support", "counter", "uncertain"), "invalid evidence role")
    status = reference_status(conn, snapshot, dataset)
    _check(not any(kind == "event" and ref.startswith("env:") for kind, ref in references(snapshot)), "environment context is not event evidence")
    _check(not status["cross_dataset_references"], "cross-dataset snapshot reference")
    return status


def describe(snapshot, dataset, conn):
    """Read-side policy: validation failure annotates metadata, leaving the original untouched."""
    try:
        version = snapshot.get("ui_state_version") if isinstance(snapshot, dict) else None
        if isinstance(snapshot, dict) and "ui_state_version" in snapshot and (type(version) is not int or version != 1):
            return {"status": "unsupported", "ui_state_version": version, "restorable": False, "exportable": True}
        status = validate(snapshot, dataset, conn)
        return {"status": "legacy" if version is None else "v1", "restorable": True, "exportable": True, **status}
    except (SnapshotError, TypeError, KeyError, RecursionError) as exc:
        return {"status": "invalid", "restorable": False, "exportable": True, "error": str(exc)}
