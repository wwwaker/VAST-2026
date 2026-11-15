import { lazy, Suspense, useEffect, useState } from "react";
import type { DatasetId } from "../shared/types/dataset";
import { datasetFromUrl, selectDatasetUrl, normalizeWorkspaceUrl } from "./navigation";

const Mc1Page = lazy(() =>
  import("../features/mc1/Mc1Page").then((module) => ({ default: module.Mc1Page })),
);

const Mc2Page = lazy(() =>
  import("../features/mc2/Mc2Page").then((module) => ({ default: module.Mc2Page })),
);

const CustomPage = lazy(() =>
  import("../features/custom/CustomPage").then((module) => ({ default: module.CustomPage })),
);

/** Each workspace owns its investigation state; the app only selects a dataset. */
export default function App() {
  const [dataset, setDataset] = useState<DatasetId>(() =>
    datasetFromUrl(new URL(window.location.href)),
  );

  useEffect(() => {
    const sync = () => {
      const url = normalizeWorkspaceUrl(new URL(window.location.href));
      if (url.href !== window.location.href) {
        window.history.replaceState(null, "", url);
      }
      setDataset(datasetFromUrl(url));
    };

    sync();
    window.addEventListener("popstate", sync);

    return () => window.removeEventListener("popstate", sync);
  }, []);

  const select = (id: DatasetId) => {
    window.history.replaceState(null, "", selectDatasetUrl(new URL(window.location.href), id));
    setDataset(id);
  };

  return (
    <Suspense
      fallback={
        <p
          role="status"
          style={{ padding: 24 }}
        >
          正在打开 {dataset}…
        </p>
      }
    >
      {dataset === "MC1" ? (
        <Mc1Page onDatasetChange={select} />
      ) : dataset === "MC2" ? (
        <Mc2Page onDatasetChange={select} />
      ) : (
        <CustomPage onDatasetChange={select} />
      )}
    </Suspense>
  );
}
