import { WorkspaceSelect } from "./WorkspaceSelect";
import { ArrowRight, ChevronLeft, ChevronRight, FileText, UserRound, Server } from "lucide-react";
import { barShade } from "../../../shared/ui/MetricBars";
import { EntityLabel, entityVisual } from "./EntityLabel";
import { categoryIcon } from "../visuals";
import { useEffect, useRef, useState } from "react";
import {
  searchFiles,
  type Capabilities,
  type TypeInfo,
  type EventItem,
} from "../../../shared/api/client";
import { EMPTY_FILTERS, type Filters } from "../../../shared/api/filters";
import {
  actor,
  categoryColors,
  displayId,
  EventRow,
  PendingRegion,
  number,
  RequestStatus,
  time,
  useRequest,
  type ReaderTarget,
} from "../eventPresentation";
import { Collapsible } from "../../../shared/ui/Collapsible";
import { query, scopeParams, type Evidence, type FacetData, type Scope } from "../api";

export function FilterPanel({
  cap,
  actors,
  filters,
  apply,
  file,
  shortcut,
  roots,
  root,
}: {
  cap: Capabilities;
  actors: { entity_id: string; label: string | null }[];
  filters: Filters;
  apply: (f: Filters) => void;
  file: (id: string) => void;
  shortcut: (id: string, timeUs: number) => void;
  roots: { event_id: string; time_us: number; file_path: string | null }[];
  root?: { event_id: string; time_us: number };
}) {
  const [keyword, setKeyword] = useState(filters.keyword);
  const [actorQuery, setActorQuery] = useState("");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => setKeyword(filters.keyword), [filters.keyword]);
  useEffect(() => {
    if (keyword === filters.keyword) {
      return;
    }
    const timer = window.setTimeout(() => apply({ ...filters, keyword }), 300);

    return () => window.clearTimeout(timer);
  }, [keyword, filters, apply]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), 300);

    return () => window.clearTimeout(timer);
  }, [text]);

  const files = useRequest(`file-search:${q}`, (s) =>
    q ? searchFiles(q, s) : Promise.resolve(null),
  );

  const toggle = (type: string) =>
    apply({
      ...filters,
      categories: [],
      eventTypes: filters.eventTypes.includes(type)
        ? filters.eventTypes.filter((t) => t !== type)
        : [...filters.eventTypes, type],
    });

  return (
    <>
      <div className="fp-title">
        <span>调查筛选</span>
        <button
          className="fp-toggle"
          onClick={() =>
            apply({ ...EMPTY_FILTERS, startUs: filters.startUs, endUs: filters.endUs })
          }
        >
          重置
        </button>
      </div>
      <div className="fp-body">
        <div className="control-block">
          <label>
            搜索关键词
            <input
              type="text"
              aria-label="记录关键词"
              placeholder="搜索实际记录内容"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </label>
        </div>
        <Collapsible
          title="事件类型"
          defaultOpen={true}
          right={null}
        >
          <div
            className="w-type-options"
            role="group"
            aria-label="事件类型筛选列表"
            tabIndex={0}
          >
            <label className="check select-all-row">
              <input
                type="checkbox"
                checked={!filters.eventTypes.length && !filters.categories.length}
                onChange={() => apply({ ...filters, categories: [], eventTypes: [] })}
              />{" "}
              全部类型
            </label>
            {cap.categories
              .filter((c) => cap.types.some((t) => t.category === c.id && (t.count ?? 0) > 0))
              .map((c) => {
                const Icon = categoryIcon(c.id);
                const types = cap.types.filter((t) => t.category === c.id && (t.count ?? 0) > 0);

                const active =
                  filters.categories.includes(c.id) ||
                  types.every((t) => filters.eventTypes.includes(t.type));

                return (
                  <div
                    className="type-group"
                    key={c.id}
                  >
                    <label className="check group-head">
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() =>
                          apply({
                            ...filters,
                            categories: [],
                            eventTypes: active
                              ? filters.eventTypes.filter((t) => !types.some((v) => v.type === t))
                              : [...new Set([...filters.eventTypes, ...types.map((t) => t.type)])],
                          })
                        }
                      />
                      <Icon
                        size={14}
                        color={categoryColors[(c.id - 1) % categoryColors.length]}
                        aria-hidden="true"
                      />
                      {c.label}
                    </label>
                    <div className="type-grid indent">
                      {types.map((t) => (
                        <label
                          className="check"
                          key={t.type}
                        >
                          <input
                            type="checkbox"
                            checked={
                              filters.eventTypes.includes(t.type) ||
                              filters.categories.includes(c.id)
                            }
                            onChange={() => toggle(t.type)}
                          />
                          {t.display_label}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>
        </Collapsible>
        <Collapsible
          title="执行者"
          defaultOpen={false}
          right={null}
        >
          <input
            aria-label="查找执行者"
            placeholder="搜索姓名"
            value={actorQuery}
            onChange={(e) => setActorQuery(e.target.value)}
          />
          <div className="w-actor-options">
            <label className="check">
              <input
                type="radio"
                name="actor"
                checked={!filters.actorId}
                onChange={() => apply({ ...filters, actorId: null })}
              />{" "}
              全部执行者
            </label>
            {actors
              .filter((a) =>
                (a.label ?? actor(a.entity_id)).toLowerCase().includes(actorQuery.toLowerCase()),
              )
              .map((a) => (
                <label
                  className="check"
                  key={a.entity_id}
                >
                  <input
                    type="radio"
                    name="actor"
                    checked={filters.actorId === a.entity_id}
                    onChange={() => apply({ ...filters, actorId: a.entity_id })}
                  />
                  {a.label ?? actor(a.entity_id)}
                </label>
              ))}
          </div>
          <p className="mc2-note">只筛选执行者字段；参与者筛选包含入向角色。</p>
        </Collapsible>
        {filters.participantId && (
          <div className="w-notice">
            参与者：{actor(filters.participantId)}{" "}
            <button onClick={() => apply({ ...filters, participantId: null })}>清除</button>
          </div>
        )}
        <Collapsible
          title="直接调查"
          defaultOpen={true}
          right={null}
        >
          <button
            className="w-shortcut"
            disabled={!root}
            onClick={() => root && shortcut(root.event_id, root.time_us)}
          >
            异常发布与附近参与者
            <ArrowRight
              size={15}
              aria-hidden="true"
            />
          </button>
          <p className="mc2-note">查看前后60秒的活动，包含入向任务。</p>
          <label>
            有明确来源的发布
            <WorkspaceSelect
              aria-label="来源发布实例"
              value=""
              onChange={(e) => {
                const r = roots.find((r) => r.event_id === e.target.value);
                if (r) {
                  shortcut(r.event_id, r.time_us);
                }
              }}
            >
              <option value="">选择实例…</option>
              {roots.map((r) => (
                <option
                  key={r.event_id}
                  value={r.event_id}
                >
                  {r.file_path} · {time(r.time_us)}
                </option>
              ))}
            </WorkspaceSelect>
          </label>
        </Collapsible>
        <Collapsible
          title="定位文件"
          defaultOpen={false}
          right={null}
        >
          <label>
            文件名或路径
            <input
              aria-label="文件名或路径"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="例如 SwiftWren"
            />
          </label>
          {q && (
            <>
              <RequestStatus {...files} />
              <PendingRegion
                {...files}
                minimum={70}
              >
                <div className="mc2-file-results">
                  {files.data?.items.map((f) => (
                    <button
                      key={f.file_id}
                      onClick={() => file(f.file_id)}
                    >
                      {f.path}
                    </button>
                  ))}
                </div>
                {files.data?.items.length === 0 && <p>没有匹配文件。</p>}
              </PendingRegion>
              <p className="mc2-note">全历史检索，选中后按当前范围调查。</p>
            </>
          )}
        </Collapsible>
      </div>
    </>
  );
}

export type FacetView = { kind: string; offset: number; q: string };

export function ObjectFacets({
  scope,
  chooseFile,
  noFile,
  chooseActor,
  chooseSystem,
  enabled = true,
  cache,
}: {
  scope: Scope;
  chooseFile: (id: string) => void;
  noFile: () => void;
  chooseActor: (id: string) => void;
  chooseSystem: (id: string) => void;
  enabled?: boolean;
  cache?: Map<string, FacetView>;
}) {
  const scopeKey = JSON.stringify(scope.filters);
  const saved = cache?.get(scopeKey);
  const [kind, setKind] = useState(saved?.kind ?? "file");
  const [offset, setOffset] = useState(saved?.offset ?? 0);
  const [q, setQ] = useState(saved?.q ?? "");
  const [previousScope, setPreviousScope] = useState(scopeKey);
  if (previousScope !== scopeKey) {
    setPreviousScope(scopeKey);
    setOffset(saved?.offset ?? 0);
    setKind(saved?.kind ?? "file");
    setQ(saved?.q ?? "");
  }
  useEffect(() => {
    cache?.set(scopeKey, { kind, offset, q });
  }, [cache, scopeKey, kind, offset, q]);
  const params = { ...scopeParams({ filters: scope.filters }), kind, offset, q };

  const data = useRequest(
    JSON.stringify(params),
    (signal) => query<FacetData>("facets", params, signal),
    enabled,
  );

  const max = Math.max(1, data.data?.scale_max ?? 1);

  const facetVisual = entityVisual(
    kind === "file" ? "file_path" : kind === "actor" ? "person" : "system",
  );

  return (
    <section className="w-facets">
      <h3>
        上级范围内的对象 ·{" "}
        {data.loading
          ? "…"
          : data.error
            ? "数量暂不可用"
            : number(data.data?.meta.matched_events ?? 0)}{" "}
        条
      </h3>
      <div className="w-tabs">
        {[
          ["file", "文件"],
          ["actor", "执行者"],
          ["system", "系统"],
        ].map(([id, text]) => (
          <button
            key={id}
            aria-pressed={kind === id}
            onClick={() => {
              setKind(id);
              setOffset(0);
            }}
          >
            {id === "file" ? (
              <FileText
                size={14}
                aria-hidden="true"
              />
            ) : id === "actor" ? (
              <UserRound
                size={14}
                aria-hidden="true"
              />
            ) : (
              <Server
                size={14}
                aria-hidden="true"
              />
            )}
            {text}
          </button>
        ))}
      </div>
      <input
        aria-label="筛选对象分布"
        type="text"
        placeholder="筛选名称或路径"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOffset(0);
        }}
      />
      <RequestStatus
        {...data}
        maskWhileLoading
        loadingLabel="正在加载对象分布…"
      />
      <PendingRegion
        {...data}
        minimum={280}
        maskWhileLoading
        loadingLabel="正在加载对象分布…"
      >
        {data.data && (
          <>
            <p className="mc2-note">
              全局条件与活动选择共 {number(data.data.meta.matched_events)} 条 · 显示{" "}
              {Math.min(offset + 1, data.data.total)}–{Math.min(offset + 12, data.data.total)} /{" "}
              {data.data.total} 个对象
            </p>
            <div className="w-facet-bars">
              {data.data.items.map((item) => (
                <button
                  key={item.id}
                  title={`${displayId(item.id)}\n${item.count} 条不同事件`}
                  onClick={() =>
                    kind === "file"
                      ? chooseFile(item.id)
                      : kind === "actor"
                        ? chooseActor(item.id)
                        : chooseSystem(item.id)
                  }
                >
                  <span className="w-facet-name">
                    <EntityLabel
                      id={item.id}
                      label={displayId(item.label ?? actor(item.id))}
                      kind={item.entity_type}
                    />
                  </span>
                  <span className="w-facet-track">
                    <i
                      style={{
                        width: `${(item.count / max) * 100}%`,
                        background: barShade(facetVisual.color, item.count / max),
                      }}
                    />
                  </span>
                  <b>{number(item.count)}</b>
                </button>
              ))}
            </div>
            <button
              className="w-missing"
              disabled={kind !== "file" || data.data.missing === 0}
              onClick={noFile}
            >
              {kind === "file"
                ? "无明确文件关联"
                : kind === "actor"
                  ? "缺少执行者"
                  : "无明确系统关联"}{" "}
              · {number(data.data.missing)} 条
            </button>
            <div className="mc2-pagination">
              <button
                disabled={offset === 0}
                onClick={() => setOffset((v) => Math.max(0, v - 12))}
              >
                <ChevronLeft
                  size={14}
                  aria-hidden="true"
                />
                上一组
              </button>
              <button
                disabled={offset + 12 >= data.data.total}
                onClick={() => setOffset((v) => v + 12)}
              >
                下一组
                <ChevronRight
                  size={14}
                  aria-hidden="true"
                />
              </button>
            </div>
            <p className="mc2-note">
              条长使用此类对象全量最大值，翻页与名称搜索不改变比例。此列表跟随全局条件与活动选择，保留文件和关系筛选前的对象分布。点击执行者只筛选其执行的活动；图中节点另可查看入向参与。各条数量不能直接相加。
            </p>
          </>
        )}
      </PendingRegion>
    </section>
  );
}

export function EvidenceList({
  scope,
  types,
  open,
  process,
  cache,
  enabled = true,
}: {
  scope: Scope;
  types: TypeInfo[];
  open: (target: ReaderTarget, trigger: HTMLElement) => void;
  process: (e: EventItem) => void;
  cache: Map<string, { cursors: (string | null)[]; direction: string; scroll: number }>;
  enabled?: boolean;
}) {
  const key = JSON.stringify(scope);
  const initial = cache.get(key);
  const [cursors, setCursors] = useState<(string | null)[]>(initial?.cursors ?? [null]);
  const [direction, setDirection] = useState(initial?.direction ?? "asc");
  const list = useRef<HTMLDivElement | null>(null);
  const params = { ...scopeParams(scope), cursor: cursors.at(-1) ?? undefined, direction };

  const data = useRequest(
    JSON.stringify(params),
    (s) => query<Evidence>("evidence", params, s),
    enabled,
  );

  const savedScroll = useRef(initial?.scroll ?? 0);
  const [previousScope, setPreviousScope] = useState(key);
  if (previousScope !== key) {
    // Reset paging before the new scope commits, without unmounting the list or
    // sending its old cursor to a different selection.
    setPreviousScope(key);
    setCursors(initial?.cursors ?? [null]);
    setDirection(initial?.direction ?? "asc");
    savedScroll.current = initial?.scroll ?? 0;
  }

  const save = (scroll: number, c = cursors, d = direction) =>
    cache.set(key, { cursors: c, direction: d, scroll });

  const move = (next?: string) => {
    const c = next ? [...cursors, next] : cursors.slice(0, -1);
    savedScroll.current = 0;
    save(0, c);
    setCursors(c);
    if (list.current) {
      list.current.scrollTop = 0;
    }
  };

  return (
    <>
      <div className="mc2-list-toolbar">
        <span data-testid="evidence-count">
          匹配{" "}
          {!data.loading && !data.error && data.data ? number(data.data.meta.matched_events) : "…"}{" "}
          条 · 第 {cursors.length} 页
        </span>
        <label>
          排序
          <WorkspaceSelect
            aria-label="记录排序"
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value);
              setCursors([null]);
              savedScroll.current = 0;
              save(0, [null], e.target.value);
            }}
          >
            <option value="asc">时间正序</option>
            <option value="desc">时间倒序</option>
          </WorkspaceSelect>
        </label>
      </div>
      <RequestStatus {...data} />
      <PendingRegion
        {...data}
        minimum={350}
      >
        <div
          className="mc2-record-list"
          ref={(el) => {
            list.current = el;
            if (el && data.data && el.scrollTop !== savedScroll.current) {
              el.scrollTop = savedScroll.current;
            }
          }}
          onScroll={(e) => {
            savedScroll.current = e.currentTarget.scrollTop;
            save(savedScroll.current);
          }}
          tabIndex={0}
        >
          {data.data?.items.map((item) => (
            <div
              className="w-record-wrap"
              key={item.event_id}
            >
              <EventRow
                event={item}
                types={types}
                open={open}
              />
              <button
                className="w-process-link"
                onClick={() => process(item)}
              >
                查看过程及附近活动
                <ArrowRight
                  size={14}
                  aria-hidden="true"
                />
              </button>
            </div>
          ))}
          {data.data?.items.length === 0 && (
            <p className="mc2-empty">没有符合条件的记录。可清除关系选择或调整调查范围。</p>
          )}
        </div>
      </PendingRegion>
      <div className="mc2-pagination">
        <button
          disabled={cursors.length === 1 || data.loading}
          onClick={() => move()}
        >
          <ChevronLeft
            size={14}
            aria-hidden="true"
          />
          上一页
        </button>
        <span>每页最多 40 条 · 聚合统计使用全部匹配记录</span>
        <button
          disabled={!data.data?.next_cursor || data.loading}
          onClick={() => move(data.data!.next_cursor!)}
        >
          下一页
          <ChevronRight
            size={14}
            aria-hidden="true"
          />
        </button>
      </div>
    </>
  );
}

export { HistoricalComparison } from "./ComparisonTimeline";
