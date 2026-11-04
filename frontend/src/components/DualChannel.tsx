import { useMemo, useState } from "react";
import type { EventDetail } from "../data/api";

/** MC1 专属：外发消息与内部审议并置。
 *  右声道是模型生成的内部文本，不是已证实的动机，必须显式标注来源与局限。 */

const CHANNEL_LABEL: Record<string, string> = {
  reacting: "即时反应",
  rationalizing: "自我合理化",
  deliberating: "权衡与推理",
};

export function DualChannel({
  event,
  coverage,
}: {
  event: EventDetail;
  coverage: { withCount: number; total: number } | null;
}) {
  const channels = useMemo(() => {
    const entries = Object.entries(event.deliberation ?? {});
    return entries.sort((a, b) => b[1].length - a[1].length);
  }, [event.deliberation]);

  const [active, setActive] = useState(0);
  const current = channels[Math.min(active, Math.max(0, channels.length - 1))];

  const pct = coverage && coverage.total > 0 ? (coverage.withCount / coverage.total) * 100 : 0;

  return (
    <section className="dual" aria-label="外发文本与内部审议对照">
      <div className="dual-head">
        <strong>双声道对照</strong>
        {coverage && (
          <span className="muted small">
            全库 {coverage.withCount} / {coverage.total} 条含内部审议（{pct.toFixed(1)}%）
          </span>
        )}
      </div>

      <div className="dual-grid">
        <div className="dual-pane">
          <div className="dual-title">
            <span>外发文本</span>
            <span className="prov prov-observed">原始观测</span>
          </div>
          {event.outgoing_text ? (
            <div className="dual-body">{event.outgoing_text}</div>
          ) : (
            <div className="dual-body dual-empty">
              该事件类型没有外发正文。
            </div>
          )}
          <p className="dual-source mono">details.content</p>
        </div>

        <div className="dual-pane">
          <div className="dual-title">
            <span>内部审议</span>
            <span className="prov prov-hint">模型生成</span>
          </div>

          {channels.length === 0 ? (
            <div className="dual-body dual-empty">
              该事件没有记录内部审议文本。
              <span className="dual-hint">
                这只表示源数据未收录，不能据此推断"当时没有权衡"。
              </span>
            </div>
          ) : (
            <>
              {channels.length > 1 && (
                <div className="dual-tabs">
                  {channels.map(([key], i) => (
                    <button
                      key={key}
                      type="button"
                      className={`dual-tab${i === Math.min(active, channels.length - 1) ? " dual-tab-active" : ""}`}
                      onClick={() => setActive(i)}
                      aria-pressed={i === active}
                    >
                      {CHANNEL_LABEL[key] ?? key}
                    </button>
                  ))}
                </div>
              )}
              <div className="dual-body">{current?.[1]}</div>
            </>
          )}
          <p className="dual-source mono">
            {event.deliberation_source ?? "raw.internal_state（无内容）"}
          </p>
        </div>
      </div>

      <p className="dual-note muted small">
        审议文本是模型生成的内部记录，属于分析线索，不是已证实的意图。结论需同时引用外发消息与上游事件，
        不能单凭审议内容定性。
      </p>
    </section>
  );
}
