import type { Annotation } from "./api";

export type BadgeTone = "risk" | "warn" | "neutral";

export interface Badge {
  text: string;
  tone: BadgeTone;
}

/**
 * 标签四态。`observed=false` 不等于异常，normal 场景更不能显示风险结论。
 * 运行阶段结果（读到旧版/拒绝发布）由审计面板单独呈现，不复用 observed。
 */
export function annotationBadge(annotation: Annotation): Badge {
  const scenario = (annotation.scenario ?? "").trim();
  if (!scenario) return { text: "未标注", tone: "neutral" };
  if (scenario.toLowerCase() === "normal") return { text: "正常对照", tone: "neutral" };
  if (annotation.observed) return { text: "已观测目标异常", tone: "risk" };
  return { text: "未观测到目标异常", tone: "warn" };
}

export function badgeClass(tone: BadgeTone): string {
  if (tone === "risk") return "tag tag-risk";
  if (tone === "warn") return "tag tag-warn";
  return "tag";
}
