import { DATASETS, type DatasetId } from "../shared/types/dataset";

export function datasetFromUrl(url: URL): DatasetId {
  return DATASETS.find((id) => url.searchParams.has(id.toLowerCase())) ?? "MC2";
}

/** Old bookmarks select the current workspace; no legacy renderer remains. */
export function normalizeWorkspaceUrl(url: URL): URL {
  const next = new URL(url);
  for (const id of DATASETS) {
    if (next.searchParams.get(id.toLowerCase()) === "legacy") {
      next.searchParams.set(id.toLowerCase(), "reference");
    }
  }
  next.searchParams.delete("bench");

  return next;
}

export function selectDatasetUrl(url: URL, dataset: DatasetId): URL {
  const next = new URL(url);
  for (const key of ["mc1", "mc2", "custom", "run", "baseline", "tab", "bench"]) {
    next.searchParams.delete(key);
  }
  next.searchParams.set(dataset.toLowerCase(), "reference");

  return next;
}
