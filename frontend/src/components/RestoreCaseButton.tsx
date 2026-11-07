import { useRef, useState } from "react";
import { fetchCaseById, fetchDatasets, fetchRun } from "../data/api";
import { useWorkspace } from "../state/workspace";

/** Both the basket and CUSTOM case list use the same restore plan and reducer action. */
export function RestoreCaseButton({ caseId }: { caseId: string }) {
  const { dataset, restoreSnapshot, setActiveCase } = useWorkspace();
  const current = useRef(dataset);
  current.current = dataset;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const restore = async () => {
    setBusy(true); setMessage(null);
    const requestedDataset = dataset;
    try {
      const [item, datasets] = await Promise.all([fetchCaseById(caseId), fetchDatasets()]);
      if (current.current !== requestedDataset) return;
      if (item.dataset_id !== requestedDataset) throw new Error("案例属于另一数据集");
      if (item.snapshot_status?.status === "invalid" || item.snapshot_status?.cross_dataset_references?.length) throw new Error(`快照不可恢复：${item.snapshot_status.error ?? "跨数据集引用"}，可导出原始 JSON。`);
      const info = datasets.find((d) => d.dataset_id === requestedDataset);
      let bounds = info?.start_us != null && info.end_us != null ? { startUs: info.start_us, endUs: info.end_us + 1 } : undefined;
      const missing = item.snapshot_status?.missing_references ?? [];
      const trace = item.snapshot.trace_object as { runId?: string } | undefined;
      if (requestedDataset === "CUSTOM" && trace?.runId && !missing.some((r) => r.id === trace.runId)) {
        const detail = await fetchRun(trace.runId);
        if (detail.run.start_us != null && detail.run.end_us != null) bounds = { startUs: detail.run.start_us, endUs: detail.run.end_us + 1 };
      }
      if (current.current !== requestedDataset) return;
      const plan = restoreSnapshot(item.snapshot, { dataset: requestedDataset, savedDataVersion: item.data_version,
        currentDataVersion: info?.data_version, bounds, missingReferences: missing.map((r) => r.id) });
      if (plan.status === "ready") {
        setActiveCase({ case_id: item.case_id, title: item.title });
      }
      else setMessage(plan.summary.join(" "));
    } catch (error) { setMessage(error instanceof Error ? error.message : "恢复失败"); }
    finally { setBusy(false); }
  };
  return <><button type="button" className="btn btn-quiet restore-investigation" onClick={restore} disabled={busy}>恢复调查</button>
    {message && <span role="status" className="muted small">{message} <a href={`/api/cases/${encodeURIComponent(caseId)}/export?format=json`}>导出 JSON</a></span>}</>;
}
