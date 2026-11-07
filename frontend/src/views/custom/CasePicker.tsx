import { useEffect, useState } from "react";
import { useWorkspace } from "../../state/workspace";
import { fetchCases, type CaseItem, type CaseListPayload } from "../../data/api";
import { RestoreCaseButton } from "../../components/RestoreCaseButton";

const STATUS_CLASS: Record<string, string> = {
  ok: "tag tag-ok",
  stale: "tag tag-warn",
  mismatch: "tag tag-risk",
  missing_run: "tag tag-risk",
};

/** 五条冻结案例：run_id、配对与期望值都来自 backend/app/cases/custom.json。 */
export function CasePicker({
  onOpen,
}: {
  onOpen: (runId: string, baselineRunId: string | null) => void;
}) {
  const { setActiveCase, activeCase } = useWorkspace();
  const [payload, setPayload] = useState<CaseListPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchCases(controller.signal)
      .then((data) => { if (!controller.signal.aborted) setPayload(data); })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "案例读取失败");
      });
    return () => controller.abort();
  }, [activeCase?.case_id]);

  if (error) {
    return <p className="muted small">冻结案例不可用：{error}</p>;
  }
  if (!payload) return <p className="muted small">正在读取冻结案例…</p>;

  const pick = (item: CaseItem) => {
    setActive(item.case_id);
    // 预置案例只读，但允许把结论写进独立 notes.db；导出走同一个案例接口
    setActiveCase({ case_id: item.case_id, title: item.title });
    onOpen(item.run_id, item.baseline_run_id);
  };

  return (
    <div className="case-picker">
      <div className="case-picker-head">
        <strong>冻结案例</strong>
        <span className="muted small">
          {payload.status_counts.ok ?? 0}/{payload.total} 与重算结果一致
        </span>
        {payload.stale && <span className="tag tag-warn">数据版本已变，案例整组标 stale</span>}
      </div>
      <div className="case-chips">
        {payload.items.map((item) => (
          <button
            key={item.case_id}
            type="button"
            className={`case-chip${active === item.case_id ? " case-chip-active" : ""}`}
            onClick={() => pick(item)}
            title={`${item.run_id}${item.baseline_run_id ? ` ↔ ${item.baseline_run_id}` : ""}`}
          >
            <span className="case-title">{item.title}</span>
            <span className="case-meta">
              <span className={STATUS_CLASS[item.status] ?? "tag"}>{item.status_label}</span>
              <span className="muted small mono">{item.run_id.replace(/^run-/, "").slice(0, 10)}</span>
              {item.baseline_run_id && (
                <span className="muted small mono">↔ {item.baseline_run_id.replace(/^run-/, "").slice(0, 10)}</span>
              )}
            </span>
            {item.diffs.length > 0 && (
              <span className="muted small">
                {item.diffs.map((diff) => `${diff.field}: ${String(diff.actual)}≠${String(diff.expected)}`).join("；")}
              </span>
            )}
          </button>
        ))}
      </div>
      <p className="muted small">
        案例只是入口：期望值来自对当前主库的重算，点开后可继续改筛选、查看原始事件；
        选中后可在「证据篮」写结论并导出 Markdown/JSON，预置案例本身不会被修改。
      </p>

      {payload.user_items.length > 0 && (
        <>
          <div className="case-picker-head">
            <strong>我的案例</strong>
            <span className="muted small">{payload.user_items.length} 条（存在 notes.db，重建主库不影响）</span>
          </div>
          <ul className="trace-list">
            {payload.user_items.map((item) => (
              <li key={item.case_id}>
                <div className="trace-item">
                  <span>{item.title}</span>
                  <span className={STATUS_CLASS[item.status] ?? "tag"}>{item.status_label}</span>
                  <span className="mono small">{item.case_id}</span>
                  <RestoreCaseButton caseId={item.case_id} />
                  <a
                    className="btn btn-quiet pattern-event"
                    href={`/api/cases/${item.case_id}/export?format=md`}
                    title="导出 Markdown 报告"
                  >
                    MD
                  </a>
                  <a
                    className="btn btn-quiet pattern-event"
                    href={`/api/cases/${item.case_id}/export?format=json`}
                    title="导出可恢复的 JSON"
                  >
                    JSON
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
