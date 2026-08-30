import type { BenchmarkRunRecord, CategoryComparison, ComparisonReport, MetricStats } from "./types";
import { compareRecords, stats } from "./metrics";

const fmt = (value: number) => Number.isFinite(value) ? value.toFixed(2) : "n/a";
function metricLine(label: string, value: MetricStats): string { return `${label} mean=${fmt(value.mean)} median=${fmt(value.median)} p95=${fmt(value.p95)} n=${value.n}`; }
export function summarizeRunSet(records: BenchmarkRunRecord[]): string {
	const eligible = records.filter(record => record.comparisonEligible);
	const success = eligible.filter(record => record.metrics.success).length;
	const excluded = records.length - eligible.length;
	const tokens = stats(eligible.map(record => record.metrics.totalTokens));
	const latency = stats(eligible.map(record => record.metrics.wallClockMs));
	return [
		`Runs: ${records.length}`,
		`Eligible: ${eligible.length}`,
		`Excluded: ${excluded}`,
		`Success: ${success}/${eligible.length} (${eligible.length ? fmt(success / eligible.length * 100) : "0.00"}%)`,
		metricLine("Tokens", tokens),
		metricLine("Latency (ms)", latency),
	].join("\n");
}
function side(label: string, row: CategoryComparison): string { const side = label === "baseline" ? row.baseline : row.ultra; return `${label}: success=${fmt(side.successRate * 100)}% n=${side.total} tokens=${fmt(side.tokens.mean)} latency=${fmt(side.latencyMs.mean)}ms modelCalls=${fmt(side.modelCalls.mean)} toolCalls=${fmt(side.toolCalls.mean)} human=${fmt(side.humanInterventionRate * 100)}%`; }
function renderRow(row: CategoryComparison): string[] {
	return [
		`${row.category}:`,
		`  ${side("baseline", row)}`,
		`  ${side("ultra", row)}`,
		`  Δ success=${fmt(row.deltas.successRate * 100)}pp tokens=${row.deltas.tokensRatio == null ? "n/a" : `${fmt(row.deltas.tokensRatio)}x`} latency=${row.deltas.latencyRatio == null ? "n/a" : `${fmt(row.deltas.latencyRatio)}x`} modelCalls=${row.deltas.modelCallsRatio == null ? "n/a" : `${fmt(row.deltas.modelCallsRatio)}x`}`,
		...row.flags.map(flag => `  ⚠ ${flag}`),
	];
}
export function renderComparison(report: ComparisonReport): string {
	const lines = ["OMP ULTRA BENCHMARK COMPARISON", "", `Raw baseline runs: ${report.sampleCounts.baseline} (eligible ${report.eligibleSampleCounts.baseline}, excluded ${report.excludedRuns.baseline})`, `Raw ultra runs: ${report.sampleCounts.ultra} (eligible ${report.eligibleSampleCounts.ultra}, excluded ${report.excludedRuns.ultra})`, ""];
	lines.push(...renderRow(report.overall));
	for (const row of report.categories) lines.push("", ...renderRow(row));
	if (report.notes.length) lines.push("", "Notes", ...report.notes.map(note => `- ${note}`));
	return lines.join("\n");
}
export function reportFrom(records: BenchmarkRunRecord[], baselineRunSet: string, ultraRunSet: string): ComparisonReport { return compareRecords(records.filter(record => record.variant === "baseline"), records.filter(record => record.variant === "ultra"), baselineRunSet, ultraRunSet); }
