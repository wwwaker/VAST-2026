export const DATASETS = ["MC1", "MC2", "CUSTOM"] as const;

export type DatasetId = (typeof DATASETS)[number];
