import { describe, expect, it } from "vitest";
import {
  compareMeasurements,
  createBenchmarkDocument,
  getBenchmarkDocumentStats,
  PERFORMANCE_BASELINES,
  PERFORMANCE_BUDGETS,
  type PerformanceMeasurements,
} from "../scripts/benchmark";

describe("性能基准契约", () => {
  it("生成包含完整性能负载的大型文档", () => {
    const stats = getBenchmarkDocumentStats(createBenchmarkDocument());

    expect(stats).toEqual({
      textCharacters: 50_000,
      paragraphs: 300,
      images: 50,
      tables: 20,
      listDepth: 4,
    });
  });

  it("预算允许基准值以内的测量，超过 20% 时报告具体指标", () => {
    const withinBudget: PerformanceMeasurements = { ...PERFORMANCE_BUDGETS };
    const overBudget = {
      ...withinBudget,
      initialEditableMs: PERFORMANCE_BASELINES.initialEditableMs * 1.21,
    };

    expect(compareMeasurements(withinBudget)).toEqual([]);
    expect(compareMeasurements(overBudget)).toEqual([
      expect.objectContaining({ metric: "initialEditableMs" }),
    ]);
  });
});
