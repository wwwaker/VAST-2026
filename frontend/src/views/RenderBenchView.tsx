import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../theme/theme";
import { fetchOverview, type OverviewPayload } from "../data/api";
import { EMPTY_FILTERS } from "../data/filterContext";

type Mode = "svg" | "canvas";

interface Result {
  label: string;
  mode: Mode;
  nodes: number;
  ms: number;
}

const VIEW_W = 880;
const VIEW_H = 320;

export function RenderBenchView() {
  const { colors } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchOverview("MC2", { filters: EMPTY_FILTERS, granularity: "hour" })
      .then(setData)
      .catch(() => setData(null));
  }, []);

  const cells = useMemo(() => {
    if (!data) return [] as [number, number, number][];
    return data.global_context.series.points;
  }, [data]);

  const clear = useCallback(() => {
    const host = hostRef.current;
    if (host) host.replaceChildren();
    setResults([]);
  }, []);

  const geometry = useCallback((n: number) => {
    const cols = Math.ceil(Math.sqrt(n * (VIEW_W / VIEW_H)));
    const rows = Math.ceil(n / cols);
    const cw = VIEW_W / cols;
    const ch = VIEW_H / rows;
    return { cols, cw, ch };
  }, []);

  const renderSvg = useCallback(
    (n: number, label: string) => {
      const host = hostRef.current;
      if (!host || !data) return;
      host.replaceChildren();
      const { cols, cw, ch } = geometry(n);
      const t0 = performance.now();
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", String(VIEW_W));
      svg.setAttribute("height", String(VIEW_H));
      svg.setAttribute("viewBox", `0 0 ${VIEW_W} ${VIEW_H}`);

      for (let i = 0; i < n; i++) {
        const point = data.global_context.series.points[i];
        const cat = point ? point[1] % 8 : 0;
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", String((i % cols) * cw));
        rect.setAttribute("y", String(Math.floor(i / cols) * ch));
        rect.setAttribute("width", String(Math.max(0.5, cw - 0.6)));
        rect.setAttribute("height", String(Math.max(0.5, ch - 0.6)));
        rect.setAttribute("fill", colors.categories[cat]);
        svg.appendChild(rect);
      }
      host.appendChild(svg);
      // 强制一次布局，把排版成本计入测量
      void host.offsetHeight;
      const ms = performance.now() - t0;
      setResults((prev) => [...prev, { label, mode: "svg", nodes: n, ms }]);
    },
    [colors, data, geometry],
  );

  const renderCanvas = useCallback(
    (n: number, label: string) => {
      const host = hostRef.current;
      if (!host || !data) return;
      host.replaceChildren();
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = VIEW_W * dpr;
      canvas.height = VIEW_H * dpr;
      canvas.style.width = `${VIEW_W}px`;
      canvas.style.height = `${VIEW_H}px`;
      host.appendChild(canvas);

      const t0 = performance.now();
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { cols, cw, ch } = geometry(n);
      for (let i = 0; i < n; i++) {
        const point = data.global_context.series.points[i];
        const cat = point ? point[1] % 8 : 0;
        ctx.fillStyle = colors.categories[cat];
        ctx.fillRect(
          (i % cols) * cw,
          Math.floor(i / cols) * ch,
          Math.max(0.6, cw - 0.6),
          Math.max(0.6, ch - 0.6),
        );
      }
      const ms = performance.now() - t0;
      setResults((prev) => [...prev, { label, mode: "canvas", nodes: n, ms }]);
    },
    [colors, data, geometry],
  );

  const run = useCallback(
    (mode: Mode, n: number, label: string) => {
      setBusy(true);
      // 让出两帧，避免把按钮状态更新计入测量窗口
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (mode === "svg") renderSvg(n, label);
          else renderCanvas(n, label);
          setBusy(false);
        }),
      );
    },
    [renderCanvas, renderSvg],
  );

  return (
    <div className="bench">
      <div className="bench-head">
        <div>
          <h2>渲染能力基准</h2>
          <p className="muted">
            用真实的 MC2 聚合数据在浏览器里测量 SVG 与 Canvas 的绘制成本。
            这是阶段 2 之前唯一无法靠后端基准回答的问题。
          </p>
        </div>
        <button type="button" className="btn" onClick={clear} disabled={busy || !data}>
          清空
        </button>
      </div>

      <div className="bench-actions">
        <button
          type="button"
          className="btn"
          onClick={() => run("svg", cells.length, `${cells.length.toLocaleString()} 图元（小时×类型）`)}
          disabled={busy || !data}
        >
          SVG · {cells.length.toLocaleString()} 图元
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => run("canvas", cells.length, `${cells.length.toLocaleString()} 图元（小时×类型）`)}
          disabled={busy || !data}
        >
          Canvas · {cells.length.toLocaleString()} 图元
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            run("svg", data?.global_context.series.buckets.length ?? 0, `${(data?.global_context.series.buckets.length ?? 0).toLocaleString()} 图元（小时聚合）`)
          }
          disabled={busy || !data}
        >
          SVG · {data?.global_context.series.buckets.length.toLocaleString()} 图元（聚合）
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            run("canvas", data?.global_context.series.buckets.length ?? 0, `${(data?.global_context.series.buckets.length ?? 0).toLocaleString()} 图元（小时聚合）`)
          }
          disabled={busy || !data}
        >
          Canvas · {data?.global_context.series.buckets.length.toLocaleString()} 图元（聚合）
        </button>
      </div>

      <div className="bench-stage" ref={hostRef} />

      {results.length > 0 && (
        <table className="bench-table">
          <thead>
            <tr>
              <th>数据密度</th>
              <th>方式</th>
              <th>图元数</th>
              <th>耗时</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <td>{r.label}</td>
                <td>{r.mode.toUpperCase()}</td>
                <td>{r.nodes.toLocaleString()}</td>
                <td className={r.ms > 100 ? "over" : "under"}>{r.ms.toFixed(1)} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="muted small">
        SVG 为每个图元创建真实 DOM 节点，节点数超过数千时会被布局与重绘拖慢；
        Canvas 只写像素，成本与图元数弱相关，但失去逐元素的焦点与命中检测，需要自行实现。
      </p>
    </div>
  );
}
