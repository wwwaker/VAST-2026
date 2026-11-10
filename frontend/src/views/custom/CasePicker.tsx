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

const EVIDENCE_LABEL: Record<string, string> = {
  attempt: "发布尝试",
  review: "审核",
  publisher_read: "发布者读取",
  result: "发布结果",
  handoff_1: "交接 1",
  handoff_2: "交接 2",
  handoff_return: "回返回",
};

function shortId(runId: string): string {
  return runId.replace(/^run-/, "").slice(0, 10);
}

/**
 * 五条冻结案例：run_id、固定 baseline 与期望值都来自 backend/app/cases/custom.json。
 * 这里只是紧凑入口：异常案例按指定 baseline 进入配对，正常案例进入单运行；
 * 标题、状态、差异、固定证据与导出仍可展开查，预置案例本身只读。
 */
export function CasePicker({
  onOpen,
  onOpenEvent,
}: {
  onOpen: (runId: string, baselineRunId: string | null) => void;
  onOpenEvent: (eventId: string, timeUs: number | null, trigger?: Element | null) => void;
}) {
  const { setActiveCase, activeCase } = useWorkspace();
  const [payload, setPayload] = useState<CaseListPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCase, setOpenCase] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchCases(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setPayload(data);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "案例读取失败");
      });
    return () => controller.abort();
    // 保存/恢复新案例后重新读取“我的案例”，与当前案例同步
  }, [activeCase?.case_id]);

  if (error) return <p className="muted small">冻结案例不可用：{error}</p>;
  if (!payload) return <p className="muted small">正在读取冻结案例…</p>;

  const pick = (item: CaseItem) => {
    // 预置案例只读；结论仍写入独立 notes.db，导出走同一案例接口
    setActiveCase({ case_id: item.case_id, title: item.title });
    setOpenCase(item.case_id);
    onOpen(item.run_id, item.baseline_run_id);
  };

  const detail = payload.items.find((item) => item.case_id === (openCase ?? activeCase?.case_id)) ?? null;

  return (
    <div className="custom-cases" data-testid="custom-cases">
      <div className="custom-cases-head">
        <strong>冻结案例</strong>
        <span className="muted small" data-testid="custom-cases-status">
          {payload.status_counts.ok ?? 0}/{payload.total} 与重算结果一致
        </span>
        {payload.stale && <span className="tag tag-warn">数据版本已变，案例整组标 stale</span>}
      </div>

      <div className="custom-case-chips" role="group" aria-label="冻结案例入口">
        {payload.items.map((item) => (
          <button
            key={item.case_id}
            type="button"
            className={`custom-case-chip${activeCase?.case_id === item.case_id ? " is-active" : ""}`}
            data-case-id={item.case_id}
            onClick={() => pick(item)}
            title={`${item.title}\n${item.run_id}${item.baseline_run_id ? ` ↔ ${item.baseline_run_id}` : ""}`}
          >
            <span>{item.title.split("：")[0]}</span>
            <span className={STATUS_CLASS[item.status] ?? "tag"}>{item.status_label}</span>
            {item.baseline_run_id && <span className="muted small mono">↔{shortId(item.baseline_run_id)}</span>}
          </button>
        ))}
      </div>

      {detail && (
        <div className="custom-case-detail" data-testid="custom-case-detail">
          <p className="small">
            <strong>{detail.title}</strong>{" "}
            <span className={STATUS_CLASS[detail.status] ?? "tag"}>{detail.status_label}</span>
          </p>
          <p className="muted small mono">
            当前 {detail.run_id}
            {detail.baseline_run_id ? ` ↔ 对照 ${detail.baseline_run_id}` : " · 无固定对照（正常案例）"}
          </p>
          {detail.note && <p className="muted small">{detail.note}</p>}
          {detail.diffs.length > 0 && (
            <p className="muted small">
              差异：
              {detail.diffs.map((diff) => `${diff.field}=${String(diff.actual)}（期望 ${String(diff.expected)}）`).join("；")}
            </p>
          )}
          <div className="custom-case-evidence" role="group" aria-label="固定证据">
            <span className="muted small">固定证据：</span>
            {Object.entries(detail.evidence).map(([role, eventId]) => (
              <button
                key={role}
                type="button"
                className="btn btn-quiet"
                data-event-id={eventId}
                onClick={(click) => onOpenEvent(eventId, null, click.currentTarget)}
                title={`${eventId}\n在阅读区打开该证据事件`}
              >
                {EVIDENCE_LABEL[role] ?? role}
              </button>
            ))}
          </div>
          <p className="muted small">
            案例只是入口：期望值来自对当前主库的重算；点开后可继续改筛选、查看原始事件。
          </p>
        </div>
      )}

      {payload.user_items.length > 0 && (
        <details className="custom-user-cases">
          <summary>我的案例（{payload.user_items.length}，存在 notes.db，重建主库不影响）</summary>
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
        </details>
      )}
    </div>
  );
}
