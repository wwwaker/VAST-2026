import { barShade } from "../../../shared/ui/MetricBars";
import { categoryIcon } from "../visuals";
import { useMemo, useRef } from "react";
import type { ActivityData, Selection } from "../api";
import { categoryColors, number, time } from "../eventPresentation";

export function ActivityOverview({
  data,
  selected,
  choose,
  day,
  chooseDay,
  collapsed,
  scrollCache,
  anchorTime,
}: {
  data: ActivityData;
  selected: Selection | null;
  choose: (s: Selection | null) => void;
  day: Selection | null;
  chooseDay: (s: Selection | null) => void;
  collapsed: boolean;
  scrollCache: Map<string, number>;
  anchorTime?: number;
}) {
  const legendMax = useRef({ key: "", max: 1 });

  const { cells, totals, rowTotals, max } = useMemo(() => {
    const cells = new Map(data.cells.map((c) => [`${c.type}:${c.bucket}`, c.count]));
    const byBucket = new Map<number, number>();

    const rowTotals: Record<string, number> = Object.fromEntries(
      data.types.map((t) => [t.type, 0]),
    );

    data.cells.forEach((c) => {
      byBucket.set(c.bucket, (byBucket.get(c.bucket) ?? 0) + c.count);
      rowTotals[c.type] = (rowTotals[c.type] ?? 0) + c.count;
    });
    const totals = data.buckets.map((b) => byBucket.get(b) ?? 0);

    return { cells, totals, rowTotals, max: Math.max(1, ...data.cells.map((c) => c.count)) };
  }, [data]);

  const key = `${data.meta.selection_hash}:${data.step}`;
  if (legendMax.current.key !== key) {
    legendMax.current = { key, max };
  }
  const width = Math.max(640, data.buckets.length * 13);
  const peak = Math.max(1, ...totals);
  const rowPeak = Math.max(1, ...Object.values(rowTotals));

  return (
    <>
      <div
        className="mc2-chart-scroll"
        tabIndex={0}
        aria-label="24 类型活动矩阵"
        ref={(el) => {
          const saved = scrollCache.get(data.meta.selection_hash);
          if (el && saved !== undefined) {
            el.scrollLeft = saved;
          }
        }}
        onScroll={(e) => scrollCache.set(data.meta.selection_hash, e.currentTarget.scrollLeft)}
      >
        <div
          className="w-activity"
          style={{ width: width + 260 }}
        >
          <div className="w-volume-label">
            记录总量
            <br />
            <b>{number(peak)}</b>
          </div>
          <svg
            width={width}
            height="65"
            role="group"
            aria-label="时间总量柱"
          >
            {totals.map((n, i) => {
              const start = Math.floor(data.buckets[i] / 86400e6) * 86400e6;
              const active = day?.start === start;

              const pick = () =>
                chooseDay(
                  active
                    ? null
                    : {
                        start,
                        end: start + 86400e6,
                        label: new Date(start / 1000).toISOString().slice(0, 10),
                      },
                );

              return (
                <g
                  key={data.buckets[i]}
                  className="w-volume-bar"
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  aria-label={`筛选当天 ${new Date(start / 1000).toISOString().slice(0, 10)} ${n} 条`}
                  onClick={pick}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      pick();
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <title>
                    {time(data.buckets[i])} · 此柱 {number(n)} 条；点击选择所属 UTC
                    整日，与顶部窗口取交集
                  </title>
                  {active && (
                    <rect
                      x={(i * width) / totals.length}
                      width={width / totals.length}
                      height="65"
                      fill="light-dark(#f5e6ce, var(--surface-subtle))"
                    />
                  )}
                  <rect
                    className="w-bar-mark"
                    x={(i * width) / totals.length + 1}
                    y={58 - (n / peak) * 51}
                    width={Math.max(2, width / totals.length - 2)}
                    height={Math.max(2, (n / peak) * 51)}
                    fill={
                      active
                        ? "light-dark(#ce8a35, var(--status-warning-text))"
                        : barShade("light-dark(#338d83, var(--text-readable))", n / peak)
                    }
                  />
                  <rect
                    className="w-bar-hit"
                    x={(i * width) / totals.length}
                    y="0"
                    width={width / totals.length}
                    height="65"
                    fill="transparent"
                  />
                </g>
              );
            })}
            {anchorTime !== undefined &&
              anchorTime >= data.buckets[0] &&
              anchorTime < data.buckets.at(-1)! + data.step && (
                <g>
                  <title>
                    保留的过程锚点 · {time(anchorTime)}；是否符合当前类型请看局部过程状态。
                  </title>
                  <line
                    x1={((anchorTime - data.buckets[0]) / data.step / data.buckets.length) * width}
                    x2={((anchorTime - data.buckets[0]) / data.step / data.buckets.length) * width}
                    y1="0"
                    y2="65"
                    stroke="light-dark(#d58c27, var(--selection-anchor))"
                    strokeWidth="2"
                    strokeDasharray="3 2"
                  />
                </g>
              )}
          </svg>
          <div className="w-row-total">当前范围总量</div>
          <div className="w-axis-label">事件类型 / UTC</div>
          <div
            className="w-axis"
            style={{ gridTemplateColumns: `repeat(${data.buckets.length || 1},1fr)` }}
          >
            {data.buckets.map((b, i) => (
              <span key={b}>
                {i % Math.max(1, Math.ceil(data.buckets.length / 10)) === 0
                  ? new Date(b / 1000)
                      .toISOString()
                      .slice(5, data.step < 86400e6 ? 13 : 10)
                      .replace("T", " ")
                  : ""}
              </span>
            ))}
          </div>
          <div />
          {!collapsed &&
            data.types.map((t, index) => {
              const Icon = categoryIcon(t.category);
              const color = categoryColors[(t.category - 1) % categoryColors.length];
              const rowSelected = selected?.type === t.type;

              return (
                <div
                  className={`w-heat-row ${rowSelected ? "is-focused" : ""} ${index === 0 || data.types[index - 1].category !== t.category ? "group-start" : ""}`}
                  key={t.type}
                >
                  <button
                    className={`w-type-label ${rowSelected ? "is-selected" : ""}`}
                    aria-pressed={rowSelected}
                    style={{
                      borderLeft: `3px solid ${categoryColors[(t.category - 1) % categoryColors.length]}`,
                    }}
                    title={`${t.type} · ${data.categories.find((c) => c.id === t.category)?.label}`}
                    onClick={() =>
                      choose(
                        rowSelected
                          ? null
                          : {
                              start: data.coverage.start,
                              end: data.coverage.end,
                              type: t.type,
                              label: t.display_label,
                            },
                      )
                    }
                  >
                    <Icon
                      size={12}
                      color={color}
                      aria-hidden="true"
                    />
                    <span>{t.display_label}</span>
                  </button>
                  <div
                    className="w-cells"
                    style={{ gridTemplateColumns: `repeat(${data.buckets.length || 1},1fr)` }}
                  >
                    {data.buckets.map((b) => {
                      const n = cells.get(`${t.type}:${b}`) ?? 0;
                      const isSelected = selected?.type === t.type && selected.cellBucket === b;
                      const covered = b < data.coverage.end && b + data.step > data.coverage.start;

                      return (
                        <button
                          key={b}
                          className={`mc2-cell ${isSelected ? "selected" : ""} ${!covered ? "outside" : ""}`}
                          disabled={!covered}
                          aria-pressed={!!isSelected}
                          aria-label={`${t.type} ${time(b)} ${n} 条记录`}
                          title={`${t.display_label} · ${t.type}\n${time(b)} 至 ${time(b + data.step)}（不含终点）\n${covered ? `此格 ${number(n)} 条记录；点击筛选此类型，日期保持不变` : "数据覆盖外"}`}
                          style={{
                            background: covered
                              ? n
                                ? barShade(color, Math.log1p(n) / Math.log1p(legendMax.current.max))
                                : "light-dark(#eef2f6, var(--surface-grid))"
                              : undefined,
                          }}
                          onClick={() =>
                            choose(
                              isSelected
                                ? null
                                : {
                                    start: data.coverage.start,
                                    end: data.coverage.end,
                                    type: t.type,
                                    label: t.display_label,
                                    cellBucket: b,
                                  },
                            )
                          }
                        />
                      );
                    })}
                  </div>
                  <div className="w-total-bar">
                    <i
                      style={{
                        width: `${(rowTotals[t.type] / rowPeak) * 100}%`,
                        background: barShade(color, rowTotals[t.type] / rowPeak),
                      }}
                    />
                    <b>{number(rowTotals[t.type])}</b>
                  </div>
                </div>
              );
            })}
        </div>
      </div>
      <div className="w-category-legend">
        {data.categories
          .filter((c) => data.types.some((t) => t.category === c.id))
          .map((c) => {
            const Icon = categoryIcon(c.id);
            const color = categoryColors[(c.id - 1) % categoryColors.length];

            return (
              <span
                key={c.id}
                style={{ color }}
              >
                <Icon
                  size={13}
                  aria-hidden="true"
                />
                {c.label}
              </span>
            );
          })}
      </div>
      <div className="mc2-legend">
        <span>零记录</span>
        <i style={{ background: "light-dark(#eef2f6, var(--surface-grid))" }} />
        <span>少</span>
        {[0.1, 0.45, 1].map((r) => (
          <i
            key={r}
            style={{ background: barShade("light-dark(#66758f, var(--text-secondary))", r) }}
          />
        ))}
        <span>多 · 最大 {number(max)} · 各类别共用对数数量刻度；色相区分类别</span>
      </div>
    </>
  );
}
