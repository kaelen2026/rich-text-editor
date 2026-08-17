#!/usr/bin/env node
/**
 * 从真实 CI 记录反推性能基线（方案 §14）。
 *
 * 现在 `scripts/benchmark.ts` 里的 `PERFORMANCE_BASELINES` 是**拍出来的初始阈值**，
 * 不是采集来的。这个脚本负责把它换成有依据的数字，但它换不出无中生有的数据——
 * 输入必须是至少三次同环境的真实运行结果。
 *
 * 取样口径与理由：
 *
 * - **按环境分组。** 本机和 CI runner 的结果不可比，混在一起算出的阈值会同时冤枉
 *   两边：对慢的那台太严，对快的那台太松。
 * - **基线取样本最大值，不取平均。** 门禁要拦的是回归，不是描述典型情况。用平均
 *   值当基线，意味着有一半的正常运行天生就在基线之上，只能靠余量兜——那余量就不
 *   再是"允许多少回归"，而是"填补取样口径的错"。
 * - **余量仍是 20%**，含义不变：环境波动加上可接受的回归。改余量是产品决策，
 *   不该混在校准里一起做。
 *
 * 用法：`node scripts/calibrate-budgets.mjs bench-*.json`
 */
import { readFileSync } from "node:fs";

const MIN_SAMPLES = 3;
const MARGIN = 1.2;

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("用法：node scripts/calibrate-budgets.mjs <bench-run.json...>");
  console.error("每个文件由 `pnpm bench --json <path>` 产出；CI 的 Quality 会把它归档。");
  process.exit(1);
}

const runs = files.map((file) => ({ file, ...JSON.parse(readFileSync(file, "utf8")) }));
const groups = new Map();
for (const run of runs) {
  const key = `${run.environment} · node ${run.node}`;
  groups.set(key, [...(groups.get(key) ?? []), run]);
}

let usable = false;
for (const [environment, samples] of groups) {
  console.log(`\n=== ${environment}（${samples.length} 次） ===`);
  if (samples.length < MIN_SAMPLES) {
    console.log(`样本不足 ${MIN_SAMPLES} 次，跳过。阈值要能代表这台机器的分布，两次跑不出分布。`);
    continue;
  }
  usable = true;
  console.log(`采样时间：${samples.map((sample) => sample.recordedAt).join("、")}`);
  console.table(
    metricsOf(samples).map((metric) => {
      const values = samples.map((sample) => sample.measurements[metric]);
      const max = Math.max(...values);
      return {
        metric,
        样本: values.map((value) => value.toFixed(2)).join(" / "),
        最大值: max.toFixed(2),
        建议基线: round(max),
        建议上限: (round(max) * MARGIN).toFixed(1),
        当前上限: samples[0].budgets[metric].toFixed(1),
      };
    }),
  );
  console.log("\n把下面这段替换进 scripts/benchmark.ts 的 PERFORMANCE_BASELINES：\n");
  console.log("export const PERFORMANCE_BASELINES = {");
  for (const metric of metricsOf(samples)) {
    const max = Math.max(...samples.map((sample) => sample.measurements[metric]));
    console.log(`  ${metric}: ${round(max)},`);
  }
  console.log("} as const;");
}

if (!usable) {
  console.error(
    `\n没有任何一组样本达到 ${MIN_SAMPLES} 次，未产出建议值。\n` +
      "这不是脚本的问题：阈值校准需要真实的连续运行记录，编不出来。",
  );
  process.exit(1);
}

console.log(
  "\n改完之后：把本次采样的运行链接与日期写进 docs/performance-budgets.md，" +
    "让下一个人知道这组数字是哪来的。",
);

function metricsOf(samples) {
  return Object.keys(samples[0].measurements);
}

/** 取整到两位有效数字：基线精确到小数位是假精度，只会让 diff 每次都变。 */
function round(value) {
  if (value >= 100) {
    return Math.ceil(value / 10) * 10;
  }
  return Math.ceil(value);
}
