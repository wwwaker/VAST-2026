/** Shared API calls used by the current workspaces. */
import { toApiFilters, type Filters, type QueryValue } from "./filters";
import type {
  DatasetInfo,
  Capabilities,
  EventDetail,
  TraceRootItem,
  FileTrackPayload,
} from "./types";
export type * from "./types";
import { getJson } from "./http";

function withFilters(
  filters: Filters,
  extra: Record<string, QueryValue> = {},
): Record<string, QueryValue> {
  return { ...toApiFilters(filters), ...extra };
}

export function fetchDatasets(signal?: AbortSignal): Promise<DatasetInfo[]> {
  return getJson<DatasetInfo[]>("/api/datasets", undefined, signal);
}

export function fetchCapabilities(dataset: string, signal?: AbortSignal): Promise<Capabilities> {
  return getJson<Capabilities>(`/api/datasets/${dataset}/capabilities`, undefined, signal);
}

export function fetchEvent(
  dataset: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<EventDetail> {
  return getJson<EventDetail>(`/api/events/${encodeURIComponent(eventId)}`, { dataset }, signal);
}

export function fetchTraceRoots(
  signal?: AbortSignal,
): Promise<{ dataset_id: string; items: TraceRootItem[]; note: string }> {
  return getJson("/api/traces/roots", { dataset: "MC2" }, signal);
}

export async function fetchMc2Actors(
  signal?: AbortSignal,
): Promise<{ entity_id: string; label: string | null }[]> {
  const results = await Promise.all(
    ["agent", "person"].map((type) =>
      getJson<{ items: { entity_id: string; label: string | null }[] }>(
        "/api/entities",
        { dataset: "MC2", type, limit: 500 },
        signal,
      ),
    ),
  );

  return results
    .flatMap((result) => result.items)
    .sort((a, b) => (a.label ?? a.entity_id).localeCompare(b.label ?? b.entity_id));
}

export function searchFiles(
  query: string,
  signal?: AbortSignal,
): Promise<{
  dataset_id: string;
  query: string;
  count: number;
  note: string;
  items: {
    file_id: string;
    path: string;
    event_count: number;
    first_us: number | null;
    last_us: number | null;
    exact: boolean;
  }[];
}> {
  return getJson("/api/files", { dataset: "MC2", q: query, limit: 20 }, signal);
}

export function fetchFileTrack(
  params: {
    fileId: string;
    filters: Filters;
    limit?: number;
    cursor?: string | null;
    cursorUs?: number | null;
    masking?: boolean;
  },
  signal?: AbortSignal,
): Promise<FileTrackPayload> {
  return getJson<FileTrackPayload>(
    "/api/file-track",
    withFilters(params.filters, {
      dataset: "MC2",
      file_id: params.fileId,
      limit: params.limit,
      cursor: params.cursor ?? undefined,
      cursor_us: params.cursorUs ?? undefined,
      masking: params.masking ? "true" : undefined,
    }),
    signal,
  );
}
