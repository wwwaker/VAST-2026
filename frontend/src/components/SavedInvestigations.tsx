import { useEffect, useState } from "react";
import { fetchCases, type CaseListPayload } from "../data/api";
import { useWorkspace } from "../state/workspace";
import { RestoreCaseButton } from "./RestoreCaseButton";

export function SavedInvestigations() {
  const { dataset, activeCase } = useWorkspace();
  const [items, setItems] = useState<CaseListPayload["user_items"]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setItems([]); setError(null);
    fetchCases(controller.signal, dataset).then((p) => { if (!controller.signal.aborted) setItems(p.user_items); })
      .catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [dataset, activeCase?.case_id]);
  return <div className="saved-investigations"><h3>已保存调查</h3>
    {error && <p className="muted small">{error}</p>}
    {items.map((item) => <div className="drawer-actions" key={item.case_id}><span>{item.title} · {item.status_label}</span><RestoreCaseButton caseId={item.case_id} /><a href={`/api/cases/${item.case_id}/export?format=json`}>JSON</a></div>)}
  </div>;
}
