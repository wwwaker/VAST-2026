import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  fetchEvent,
  fetchFileTrack,
  type EventDetail,
  type FileTrackPayload,
  type TypeInfo,
} from "../../../shared/api/client";
import { EMPTY_FILTERS, type Filters } from "../../../shared/api/filters";
import {
  actor,
  categoryColors,
  displayId,
  EventMetadata,
  EventRow,
  number,
  PendingRegion,
  RequestStatus,
  time,
  typeLabel,
  useRequest,
  type ReaderTarget,
} from "../eventPresentation";

import { CompactSource } from "./CompactSource";
import { ReadingActions } from "../../../shared/ui/MessageMetadata";
import { useReaderScrollLock } from "../../../shared/ui/ReaderDialog";
import { query, relationName, type ProcessData, type ProcessMembers } from "../api";

type Entry = ReaderTarget & { scroll: number; cursors: (string | null)[] };
export function Reader({
  initial,
  filters,
  types,
  close,
  filterActor,
}: {
  initial: ReaderTarget;
  filters: Filters;
  types: TypeInfo[];
  close: () => void;
  filterActor: (id: string) => void;
}) {
  const [history, setHistory] = useState<Entry[]>([{ ...initial, scroll: 0, cursors: [null] }]);
  const current = history[history.length - 1];
  const modal = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const readingFilters = current.reading?.filters ?? filters;
  const cursor = current.cursors[current.cursors.length - 1];

  const resource = useRequest<EventDetail | FileTrackPayload>(
    JSON.stringify([current.kind, current.id, readingFilters, cursor]),
    (signal) =>
      current.kind === "event"
        ? fetchEvent("MC2", current.id, signal)
        : fetchFileTrack(
            { fileId: current.id, filters: readingFilters, limit: 40, cursor },
            signal,
          ),
  );

  useReaderScrollLock(modal);
  useEffect(() => {
    if (body.current && !resource.loading) {
      body.current.scrollTop = current.scroll;
    }
  }, [current, resource.loading]);
  useEffect(() => {
    modal.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [current.kind, current.id, cursor]);

  const open = (target: ReaderTarget) => {
    setHistory((items) => [
      ...items.slice(0, -1),
      { ...current, scroll: body.current?.scrollTop ?? 0 },
      {
        ...target,
        reading: target.reading ?? current.reading ?? { filters, label: "打开时的主调查范围" },
        scroll: 0,
        cursors: [null],
      },
    ]);
  };

  const page = (next?: string) =>
    setHistory((items) => [
      ...items.slice(0, -1),
      {
        ...current,
        scroll: 0,
        cursors: next ? [...current.cursors, next] : current.cursors.slice(0, -1),
      },
    ]);

  return (
    <div
      className="flow-overlay w-reader-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      <div
        className="flow-modal mc2-reader w-reader"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mc2-reader-title"
        ref={modal}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          }
          if (event.key === "Tab") {
            const controls = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), a[href], summary, [tabindex="0"]',
              ),
            ].filter(
              (el) =>
                !el.closest("[inert]") &&
                (!el.closest("details:not([open])") || el.tagName === "SUMMARY"),
            );

            const first = controls[0];
            const last = controls[controls.length - 1];

            const active =
              event.currentTarget.getRootNode() instanceof ShadowRoot
                ? (event.currentTarget.getRootNode() as ShadowRoot).activeElement
                : document.activeElement;

            if (event.shiftKey && active === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && active === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="flow-modal-head">
          <div>
            <h3 id="mc2-reader-title">{current.kind === "event" ? "阅读记录" : "阅读文件轨迹"}</h3>
            <p className="mc2-note">{displayId(current.id)}</p>
          </div>
          <ReadingActions
            onBack={
              history.length > 1 ? () => setHistory((items) => items.slice(0, -1)) : undefined
            }
            onClose={close}
            backLabel="返回上次阅读"
            closeLabel="关闭阅读记录"
          />
        </div>
        <div
          className="flow-list mc2-reader-body"
          ref={body}
          tabIndex={0}
        >
          <p className="w-notice">
            阅读入口：{current.reading?.label ?? "打开时的主调查范围"}
            {current.reading?.independent ? " · 独立阅读，不改变主调查" : ""}
          </p>
          {current.kind === "file" && (
            <button
              className="w-text-link"
              onClick={() =>
                open({
                  ...current,
                  reading: {
                    filters: { ...EMPTY_FILTERS },
                    label: "该文件全历史（显式切换）",
                    independent: true,
                  },
                })
              }
            >
              查看该文件全历史
            </button>
          )}
          {current.kind === "file" && (
            <p className="mc2-note mc2-reader-scope">
              文件轨迹范围：
              {readingFilters.startUs == null ? "数据起点" : time(readingFilters.startUs)} →{" "}
              {readingFilters.endUs == null ? "数据终点" : time(readingFilters.endUs)}（不含终点）
              {readingFilters.categories.length
                ? ` · 类别 ${readingFilters.categories.join("、")}`
                : ""}
              {readingFilters.actorId ? ` · ${actor(readingFilters.actorId)}` : ""}
              {readingFilters.eventTypes.length ? ` · ${readingFilters.eventTypes.join("、")}` : ""}
              {readingFilters.keyword ? ` · 关键词「${readingFilters.keyword}」` : ""}
            </p>
          )}
          <RequestStatus {...resource} />
          <PendingRegion
            {...resource}
            minimum={340}
          >
            {!resource.loading &&
              !resource.error &&
              resource.data &&
              (current.kind === "event" ? (
                <EventContent
                  event={resource.data as EventDetail}
                  types={types}
                  open={open}
                  filterActor={filterActor}
                />
              ) : (
                <FileContent
                  track={resource.data as FileTrackPayload}
                  types={types}
                  open={open}
                  previous={current.cursors.length > 1}
                  page={page}
                />
              ))}
          </PendingRegion>
        </div>
      </div>
    </div>
  );
}

function EventContent({
  event,
  types,
  open,
  filterActor,
}: {
  event: EventDetail;
  types: TypeInfo[];
  open: (target: ReaderTarget) => void;
  filterActor: (id: string) => void;
}) {
  const files = [
    ...new Set(
      event.relations.filter((r) => r.dst_id.startsWith("MC2:file_path:")).map((r) => r.dst_id),
    ),
  ];

  const details = event.details ?? {};
  const color = categoryColors[(event.category - 1) % categoryColors.length];

  return (
    <>
      <article
        className="chat-bubble selected w-reading-message"
        style={{ borderLeftColor: color }}
      >
        <EventMetadata
          event={event}
          types={types}
          filterActor={filterActor}
        />
        <div className="cb-body">
          {event.reading?.fields.map((field) => (
            <section
              className="w-message-text"
              key={field.key}
            >
              <b>{field.label}</b>
              <p>{field.value}</p>
            </section>
          ))}
          {!event.reading?.fields.length && (
            <p>{event.reading?.summary ?? "此条日志未提供消息正文，可核对原始字段。"}</p>
          )}
          {event.event_type === "queue_subordinate_task" && (
            <p className="mc2-note">这是任务排队记录，不能判断目标已执行成功。</p>
          )}
        </div>
        <div className="provenance-note">
          原始记录：{displayId(event.event_id)} · 点击执行者姓名可筛选主页面
        </div>
      </article>
      <CompactSource
        event={event}
        open={open}
      />
      {event.relations.length > 0 && (
        <section className="mc2-reading-block">
          <h3>这条记录涉及谁、涉及什么</h3>
          {event.relations.map((r, i) => (
            <div
              className="w-evidence-role"
              key={i}
            >
              <span>{actor(r.src_id)}</span>
              <span className="w-role-arrow">
                — {relationName[r.relation] ?? r.relation}
                <ArrowRight
                  size={14}
                  aria-hidden="true"
                />
              </span>
              <button
                className="w-text-link"
                onClick={() =>
                  r.dst_id.startsWith("MC2:file_path:")
                    ? open({ kind: "file", id: r.dst_id })
                    : r.target_kind === "event"
                      ? open({ kind: "event", id: r.dst_id })
                      : undefined
                }
                disabled={!r.dst_id.startsWith("MC2:file_path:") && r.target_kind !== "event"}
              >
                {r.dst_id.startsWith("MC2:file_path:")
                  ? r.dst_id.slice("MC2:file_path:".length)
                  : actor(r.dst_id)}
              </button>
            </div>
          ))}
        </section>
      )}
      {files.length > 0 && (
        <section className="mc2-reading-block">
          <h3>关联文件与轨迹</h3>
          {files.map((id) => (
            <button
              className="mc2-link-row"
              key={id}
              onClick={() => open({ kind: "file", id })}
            >
              {id.slice("MC2:file_path:".length)}
              <ArrowRight
                size={14}
                aria-hidden="true"
              />
            </button>
          ))}
        </section>
      )}
      <NearbyActivity
        event={event}
        open={open}
        types={types}
      />
      {event.deliberation && (
        <details className="mc2-reading-block">
          <summary>内部审议</summary>
          {Object.entries(event.deliberation).map(([key, value]) => (
            <p key={key}>
              <b>{key}：</b>
              {typeof value === "string" ? value : JSON.stringify(value)}
            </p>
          ))}
        </details>
      )}
      <details className="mc2-reading-block">
        <summary>完整字段与角色依据</summary>
        <dl className="mc2-fields">
          {Object.entries(details).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                {displayId(typeof value === "string" ? value : JSON.stringify(value, null, 2))}
              </dd>
            </div>
          ))}
        </dl>
        {event.relations.map((r, i) => (
          <p
            className="mc2-note"
            key={i}
          >
            {relationName[r.relation] ?? r.relation}：{r.derivation}
          </p>
        ))}
      </details>
      <details className="mc2-reading-block">
        <summary>原始记录与来源定位</summary>
        <p>
          {event.source_file ?? "来源文件未记录"} · 序号 {event.source_ordinal ?? "未知"} ·{" "}
          {event.source_json_pointer}
        </p>
        <pre>{JSON.stringify(event.raw, null, 2)}</pre>
      </details>
    </>
  );
}

function NearbyActivity({
  event,
  types,
  open,
}: {
  event: EventDetail;
  types: TypeInfo[];
  open: (target: ReaderTarget) => void;
}) {
  const params = { anchor: event.event_id, seconds: 60, context: "true" };

  const resource = useRequest(`reader-context:${event.event_id}`, (signal) =>
    query<ProcessData>("process", params, signal),
  );

  return (
    <section className="mc2-reading-block">
      <h3>附近参与活动</h3>
      <p className="mc2-note">
        前后60秒内，按执行者及明确来源／目标角色查询，含入向任务；时间接近不表示因果。此处独立于主页面筛选。
      </p>
      <RequestStatus {...resource} />
      <PendingRegion
        {...resource}
        minimum={80}
      >
        {resource.data?.valid && (
          <NearbyRecords
            key={resource.data.selection_key}
            data={resource.data}
            open={open}
            types={types}
          />
        )}
      </PendingRegion>
    </section>
  );
}

function NearbyRecords({
  data,
  open,
  types,
}: {
  data: Extract<ProcessData, { valid: true }>;
  open: (t: ReaderTarget) => void;
  types: TypeInfo[];
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);

  const args = {
    anchor: data.anchor,
    seconds: 60,
    context: "true",
    aggregate_id: "all",
    data_version: data.data_version,
    selection_key: data.selection_key,
    cursor: cursors.at(-1) ?? undefined,
  };

  const resource = useRequest(JSON.stringify(args), (s) =>
    query<ProcessMembers>("process-members", args, s),
  );

  const items = resource.data?.items.filter((i) => i.event_id !== data.anchor) ?? [];

  return (
    <>
      <p className="mc2-note">
        共 {Math.max(0, data.total - 1)} 条附近活动 · 第 {cursors.length}{" "}
        页（每页最多40条，包含锚点时在此省略）
      </p>
      <RequestStatus {...resource} />
      <PendingRegion {...resource}>
        {items.map((i) => (
          <EventRow
            key={i.event_id}
            event={i}
            types={types}
            open={(target) =>
              open({
                ...target,
                reading: {
                  filters: { ...EMPTY_FILTERS, startUs: data.start, endUs: data.end },
                  label: "阅读中的附近参与活动窗口",
                  independent: true,
                },
              })
            }
          />
        ))}
        {data.total === 1 && <p>此窗口内未找到其他参与活动。</p>}
      </PendingRegion>
      <div className="mc2-pagination">
        <button
          disabled={cursors.length < 2 || resource.loading}
          onClick={() => setCursors((v) => v.slice(0, -1))}
        >
          上一页附近活动
        </button>
        <button
          disabled={!resource.data?.next_cursor || resource.loading}
          onClick={() => setCursors((v) => [...v, resource.data!.next_cursor!])}
        >
          下一页附近活动
        </button>
      </div>
    </>
  );
}

function FileContent({
  track,
  types,
  open,
  previous,
  page,
}: {
  track: FileTrackPayload;
  types: TypeInfo[];
  open: (target: ReaderTarget) => void;
  previous: boolean;
  page: (next?: string) => void;
}) {
  const file = track.file;

  return (
    <>
      <section className="mc2-reading-block">
        <h3>{file.path}</h3>
        <p className={file.content_status === "available" ? "mc2-note" : "mc2-warning"}>
          {file.content_status === "available"
            ? "可定位到正文字段"
            : file.events_truncated
              ? "当前检查未发现文件正文"
              : "未提供文件正文"}{" "}
          · {file.reason}
        </p>
        {file.events_truncated && (
          <p className="mc2-note">
            正文检查仅覆盖最早的 500 条关联记录；不能据此判断全部历史是否含正文。
          </p>
        )}
        <p className="mc2-note">
          全历史：{number(file.event_count)} 条记录 · {time(file.first_us)} 至 {time(file.last_us)}
          {file.size_hint != null && ` · size_hint 原始值 ${file.size_hint}`}
        </p>
        <p className="mc2-note">
          文件阅读沿用打开时的时间、类型、执行者和关键词；展示此范围的文件轨迹，不叠加关系图中选中边的端点限制。
        </p>
        {file.content_sources.map((source) => (
          <button
            className="mc2-link-row"
            key={`${source.event_id}:${source.field}`}
            onClick={() => open({ kind: "event", id: source.event_id })}
          >
            查看文本依据：{source.field} · {number(source.length)} 字符
            <ArrowRight
              size={14}
              aria-hidden="true"
            />
          </button>
        ))}
      </section>
      <section className="mc2-reading-block">
        <h3>当前筛选内的文件轨迹 · {number(track.meta.matched_events)} 条</h3>
        <div className="mc2-type-counts">
          {Object.entries(track.event_type_counts ?? {}).map(([type, count]) => (
            <span key={type}>
              {typeLabel(type, types)} <b>{number(count)}</b>
            </span>
          ))}
        </div>
        <p className="mc2-note">
          按时间正序排列。此处继承阅读入口保存的范围；全历史总数不随筛选变化。
        </p>
        {track.items.map((item) => (
          <div key={item.event_id}>
            <EventRow
              event={item}
              types={types}
              open={(target) => open(target)}
            />
            <p className="mc2-relation-note">日志关系：{item.file_relations.join("、")}</p>
          </div>
        ))}
        {!track.items.length && (
          <p className="mc2-empty">
            当前筛选内没有此文件的记录，可点击上方“查看该文件全历史”，显式切换范围。
          </p>
        )}
        <div className="mc2-pagination">
          <button
            disabled={!previous}
            onClick={() => page()}
          >
            <ChevronLeft
              size={14}
              aria-hidden="true"
            />
            上一页
          </button>
          <span>每页最多 40 条</span>
          <button
            disabled={!track.next_cursor}
            onClick={() => page(track.next_cursor!)}
          >
            下一页
            <ChevronRight
              size={14}
              aria-hidden="true"
            />
          </button>
        </div>
      </section>
    </>
  );
}
