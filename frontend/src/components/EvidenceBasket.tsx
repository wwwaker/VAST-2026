import { useEffect, useState } from "react";
import { useWorkspace } from "../state/workspace";
import { SavedInvestigations } from "./SavedInvestigations";
import { createCase, createFinding, deleteFinding, fetchFindings, type FindingRecord } from "../data/api";

const ROLE_TEXT = { support: "支持", counter: "反证", uncertain: "待核实" } as const;
const STATUS_TEXT = { hypothesis: "假设", supported: "有证据支持", inconclusive: "证据不足" } as const;

/** 证据篮 + 结构化结论：结论必须挂在一个案例上，证据来自篮内引用。 */
export function EvidenceBasket() {
  const {
    dataset,
    snapshot,
    basket,
    removeFromBasket,
    clearBasket,
    activeCase,
    setActiveCase,
    findingDraft,
    setFindingDraft,
  } = useWorkspace();

  const [findings, setFindings] = useState<FindingRecord[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!activeCase) {
      setFindings([]);
      return;
    }
    const controller = new AbortController();
    fetchFindings(activeCase.case_id, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setFindings(data.items); })
      .catch(() => { if (!controller.signal.aborted) setFindings([]); });
    return () => controller.abort();
  }, [activeCase]);

  const saveCase = async () => {
    const trimmed = findingDraft.title.trim();
    if (!trimmed) {
      setMessage("先给案例起个名字");
      return;
    }
    setBusy(true);
    try {
      const created = await createCase({ dataset_id: dataset, title: trimmed, snapshot: snapshot() });
      setActiveCase({ case_id: created.case_id, title: created.title }, dataset);
      setFindingDraft({ title: "" });
      setMessage(`已保存案例 ${created.case_id}（${basket.length} 条固定证据）`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const saveFinding = async () => {
    if (!activeCase) {
      setMessage("先保存或选择一个案例");
      return;
    }
    if (!findingDraft.claim.trim() || !findingDraft.explanation.trim()) {
      setMessage("主张与解释都要填");
      return;
    }
    setBusy(true);
    try {
      const created = await createFinding({
        case_id: activeCase.case_id,
        claim: findingDraft.claim.trim(),
        status: findingDraft.status,
        explanation: findingDraft.explanation.trim(),
        limitations: findingDraft.limitations.trim() || null,
        evidence: basket.map((item) => ({
          reference_id: item.event_id,
          role: item.role,
          excerpt: item.excerpt || null,
        })),
      });
      setFindings((prev) => [...prev, created]);
      setFindingDraft({ claim: "", explanation: "", limitations: "" });
      setMessage(created.evidence.length ? `已记录结论（${created.evidence.length} 条证据）` : "已记录结论（尚无证据）");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存结论失败");
    } finally {
      setBusy(false);
    }
  };

  const removeFinding = async (findingId: string) => {
    await deleteFinding(findingId);
    setFindings((prev) => prev.filter((item) => item.finding_id !== findingId));
  };

  return (
    <div className="basket">
      <SavedInvestigations />
      <h3>案例</h3>
      {activeCase ? (
        <div className="callout">
          <strong>{activeCase.title}</strong>
          <p className="muted small mono">{activeCase.case_id}</p>
          <div className="drawer-actions">
            <a className="btn" href={`/api/cases/${activeCase.case_id}/export?format=md`}>
              导出 Markdown
            </a>
            <a className="btn btn-quiet" href={`/api/cases/${activeCase.case_id}/export?format=json`}>
              导出 JSON
            </a>
            <button type="button" className="btn btn-quiet" onClick={() => setActiveCase(null)}>
              取消关联
            </button>
          </div>
        </div>
      ) : (
        <div className="callout">
          <p className="muted small">
            结论需要挂在一个案例上。保存会把当前筛选、画布、选中事件与固定证据一起写下；
            数据重建后可按版本判断是否过期。
          </p>
          <div className="drawer-actions">
            <input
              type="text"
              value={findingDraft.title}
              placeholder="案例标题"
              onChange={(e) => setFindingDraft({ title: e.target.value })}
              className="text-input"
              maxLength={80}
            />
            <button type="button" className="btn" onClick={saveCase} disabled={busy}>
              保存当前案例
            </button>
          </div>
        </div>
      )}

      <h3>
        证据篮 <span className="muted small">（{basket.length} 条）</span>
      </h3>
      {basket.length === 0 ? (
        <p className="muted small">在「消息」页用「支持 / 反证 / 待核实」把当前事件加入证据篮。</p>
      ) : (
        <>
          <ul className="trace-list">
            {basket.map((item) => (
              <li key={`${item.event_id}-${item.role}`}>
                <div className="trace-item">
                  <span className="role-chip">{ROLE_TEXT[item.role]}</span>
                  <span className="mono small">{item.event_id}</span>
                  <span className="muted small">{item.excerpt || item.label}</span>
                  <button
                    type="button"
                    className="btn btn-quiet pattern-event"
                    onClick={() => removeFromBasket(item.event_id, item.role)}
                  >
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-quiet" onClick={clearBasket}>
            清空证据篮
          </button>
        </>
      )}

      <h3>记录结论</h3>
      <div className="finding-form">
        <input
          type="text"
          className="text-input"
          placeholder="主张（一句话）"
          value={findingDraft.claim}
          onChange={(e) => setFindingDraft({ claim: e.target.value })}
          maxLength={200}
        />
        <select value={findingDraft.status} onChange={(e) => setFindingDraft({ status: e.target.value as FindingRecord["status"] })}>
          <option value="hypothesis">假设</option>
          <option value="supported">有证据支持</option>
          <option value="inconclusive">证据不足</option>
        </select>
        <textarea
          className="text-input"
          rows={3}
          placeholder="解释：哪条证据支持这个主张，推理是什么"
          value={findingDraft.explanation}
          onChange={(e) => setFindingDraft({ explanation: e.target.value })}
        />
        <textarea
          className="text-input"
          rows={2}
          placeholder="局限（可选）：数据缺什么、结论不能覆盖什么"
          value={findingDraft.limitations}
          onChange={(e) => setFindingDraft({ limitations: e.target.value })}
        />
        <button type="button" className="btn" onClick={saveFinding} disabled={busy || !activeCase}>
          保存结论（{basket.length} 条证据）
        </button>
      </div>

      {message && <p className="muted small">{message}</p>}

      <h3>已有结论（{findings.length}）</h3>
      {findings.length === 0 ? (
        <p className="muted small">还没有记录结论。</p>
      ) : (
        <ul className="finding-list">
          {findings.map((item) => (
            <li key={item.finding_id}>
              <div className="finding-head">
                <strong>{item.claim}</strong>
                <span className="tag">{STATUS_TEXT[item.status]}</span>
                <button
                  type="button"
                  className="btn btn-quiet pattern-event"
                  onClick={() => removeFinding(item.finding_id)}
                >
                  删除
                </button>
              </div>
              <p className="muted small">{item.explanation}</p>
              {item.limitations && <p className="muted small">局限：{item.limitations}</p>}
              <p className="muted small">
                {item.evidence.length === 0
                  ? "尚无证据"
                  : item.evidence
                      .map((e) => `${ROLE_TEXT[e.role]} ${e.reference_id}`)
                      .join(" · ")}
              </p>
              <p className="muted small">记录于 {item.created_at}</p>
            </li>
          ))}
        </ul>
      )}

      <p className="muted small">保存案例时会一并记下当前筛选、画布与选中事件，导出里可直接复核。</p>
    </div>
  );
}
