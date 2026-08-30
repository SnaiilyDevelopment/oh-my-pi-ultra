import type { AgentRunSummary } from "@oh-my-pi/pi-agent-core";
import type { BenchmarkCategory, BenchmarkMetrics, BenchmarkRunRecord, BenchmarkTelemetryEvidence, CategoryComparison, ComparisonReport, FailureCause, MetricStats, RegressionThresholds } from "./types";

export function metricsFromTelemetry(
	summary: AgentRunSummary | undefined,
	evidence: BenchmarkTelemetryEvidence | undefined,
	wallClockMs: number,
	verification: { success: boolean; finalState: string; testsPassed?: number; regressions?: number },
): BenchmarkMetrics {
	const usage = summary?.usage;
	const modelCalls = summary?.chats.total ?? 0;
	const toolCalls = summary?.tools.total ?? 0;
	const toolFailures = summary?.tools.error ?? 0;
	const inputTokens = usage?.inputTokens ?? 0;
	const outputTokens = usage?.outputTokens ?? 0;
	const reasoningTokens = usage?.reasoningOutputTokens ?? 0;
	const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
	const modelMs = evidence?.latency?.modelMs ?? summary?.chats.totalLatencyMs ?? 0;
	const toolMs = evidence?.latency?.toolMs ?? summary?.tools.totalLatencyMs ?? 0;
	const context = { samples: evidence?.context?.samples ?? 0, ...evidence?.context };
	const tools = { toolCalls, failures: toolFailures, ...evidence?.tools };
	const orchestration = { ...evidence?.orchestration };
	const verificationTelemetry = evidence?.verification;
	const humanInterventions = (evidence?.humanInterventions ?? []).filter(item => item.type !== "none").reduce((sum, item) => sum + item.count, 0);
	return {
		success: verification.success,
		testsPassed: verification.testsPassed ?? verificationTelemetry?.testsPassed ?? 0,
		regressions: verification.regressions ?? verificationTelemetry?.regressions ?? 0,
		inputTokens,
		outputTokens,
		toolOutputTokens: evidence?.tools?.toolOutputTokens ?? 0,
		reasoningTokens,
		totalTokens,
		modelCalls,
		toolCalls,
		retryCount: evidence?.tools?.retries ?? 0,
		repairAttempts: verificationTelemetry?.repairAttempts ?? 0,
		escalations: verificationTelemetry?.escalations ?? 0,
		specialistInvocations: evidence?.specialists?.invocations ?? orchestration.specialistCalls ?? 0,
		parallelGroups: evidence?.specialists?.parallelGroups ?? orchestration.parallelGroups ?? 0,
		wallClockMs,
		humanInterventions,
		finalVerificationState: verification.finalState,
		context,
		tools,
		orchestration,
		latency: {
			totalMs: wallClockMs,
			modelMs,
			toolMs,
			verificationMs: evidence?.latency?.verificationMs ?? 0,
			orchestrationMs: evidence?.latency?.orchestrationMs ?? 0,
			waitingMs: evidence?.latency?.waitingMs ?? 0,
			specialistMs: evidence?.latency?.specialistMs ?? 0,
			parallelSavingsMs: evidence?.latency?.parallelSavingsMs,
		},
		costUsd: evidence?.costUsd,
		costUnknownReason: evidence?.costUnknownReason,
	};
}

export function stats(values: number[]): MetricStats {
	if (values.length === 0) return { mean: 0, median: 0, p95: 0, min: 0, max: 0, n: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const nearestRank = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
	return { mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, median: nearestRank(0.5), p95: nearestRank(0.95), min: sorted[0]!, max: sorted[sorted.length - 1]!, n: sorted.length };
}

export function wilson(successes: number, total: number): { low: number; high: number } {
	if (total === 0) return { low: 0, high: 0 };
	const z = 1.96;
	const p = successes / total;
	const d = 1 + z * z / total;
	const c = (p + z * z / (2 * total)) / d;
	const h = (z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)) / d;
	return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
}

function ratio(ultra: number, baseline: number): number | null { return baseline > 0 ? ultra / baseline : null; }
function side(records: BenchmarkRunRecord[], variant: "baseline" | "ultra", category?: BenchmarkCategory) {
	const rows = records.filter(record => record.variant === variant && (category === undefined || record.category === category));
	const successes = rows.filter(record => record.metrics.success).length;
	return {
		successRate: rows.length ? successes / rows.length : 0,
		successCount: successes,
		total: rows.length,
		successInterval: wilson(successes, rows.length),
		tokens: stats(rows.map(record => record.metrics.totalTokens)),
		latencyMs: stats(rows.map(record => record.metrics.wallClockMs)),
		modelCalls: stats(rows.map(record => record.metrics.modelCalls)),
		toolCalls: stats(rows.map(record => record.metrics.toolCalls)),
		humanInterventionRate: rows.length ? rows.filter(record => record.metrics.humanInterventions > 0).length / rows.length : 0,
	};
}

export const DEFAULT_REGRESSION_THRESHOLDS: RegressionThresholds = {
	successRateDelta: 0,
	tokenIncreaseRatio: 1.10,
	latencyIncreaseRatio: 1.10,
	modelCallIncreaseRatio: 1.10,
	toolCallIncreaseRatio: 1.15,
};

export function compareRecords(
	baseline: BenchmarkRunRecord[],
	ultra: BenchmarkRunRecord[],
	baselineRunSet: string,
	ultraRunSet: string,
	thresholds: RegressionThresholds = DEFAULT_REGRESSION_THRESHOLDS,
): ComparisonReport {
	const all = [...baseline, ...ultra];
	const categories = [...new Set(all.map(record => record.category))].sort() as BenchmarkCategory[];
	const make = (category?: BenchmarkCategory): CategoryComparison => {
		const b = side(all, "baseline", category);
		const u = side(all, "ultra", category);
		const flags: string[] = [];
		if (b.total > 0 && u.total > 0) {
			if (u.successRate < b.successRate - thresholds.successRateDelta) flags.push("REGRESSION: success rate decreased beyond configured threshold");
			if (b.tokens.mean > 0 && u.tokens.mean / b.tokens.mean > thresholds.tokenIncreaseRatio) flags.push("EFFICIENCY REGRESSION: mean tokens increased beyond configured threshold");
			if (b.latencyMs.mean > 0 && u.latencyMs.mean / b.latencyMs.mean > thresholds.latencyIncreaseRatio) flags.push("LATENCY REGRESSION: mean latency increased beyond configured threshold");
			if (b.modelCalls.mean > 0 && u.modelCalls.mean / b.modelCalls.mean > thresholds.modelCallIncreaseRatio) flags.push("MODEL-CALL REGRESSION: mean model calls increased beyond configured threshold");
			if (b.toolCalls.mean > 0 && u.toolCalls.mean / b.toolCalls.mean > thresholds.toolCallIncreaseRatio) flags.push("TOOL REGRESSION: mean tool calls increased beyond configured threshold");
			if (u.toolCalls.mean > b.toolCalls.mean && u.successRate <= b.successRate) flags.push("TRADEOFF: more tool calls without a success-rate gain");
		}
		return {
			category: category ?? "overall",
			baseline: b,
			ultra: u,
			deltas: {
				successRate: u.successRate - b.successRate,
				tokensRatio: ratio(u.tokens.mean, b.tokens.mean),
				latencyRatio: ratio(u.latencyMs.mean, b.latencyMs.mean),
				modelCallsRatio: ratio(u.modelCalls.mean, b.modelCalls.mean),
				toolCallsRatio: ratio(u.toolCalls.mean, b.toolCalls.mean),
				humanInterventionRate: u.humanInterventionRate - b.humanInterventionRate,
			},
			flags,
		};
	};
	return {
		version: 1,
		baselineRunSet,
		ultraRunSet,
		sampleCounts: { baseline: baseline.length, ultra: ultra.length },
		overall: make(),
		categories: categories.map(category => make(category)),
		notes: [
			`Thresholds are configurable heuristics: success decrease > ${thresholds.successRateDelta}, token ratio > ${thresholds.tokenIncreaseRatio}x, latency ratio > ${thresholds.latencyIncreaseRatio}x, model-call ratio > ${thresholds.modelCallIncreaseRatio}x, tool-call ratio > ${thresholds.toolCallIncreaseRatio}x.`,
			"Wilson 95% intervals are descriptive; small samples do not establish strong statistical certainty.",
			"Raw dimensions remain authoritative; no composite score hides regressions.",
		],
	};
}

export function failureCauseFrom(exitCode: number, timedOut: boolean, verificationFailed: boolean, evidence?: BenchmarkTelemetryEvidence): FailureCause {
	if (evidence?.failureCause) return evidence.failureCause;
	if (timedOut) return "MODEL_FAILURE";
	if (verificationFailed) return "VERIFICATION_FAILURE";
	if (exitCode !== 0) {
		if ((evidence?.summary?.tools.error ?? 0) > 0) return "TOOL_FAILURE";
		if ((evidence?.summary?.errors.total ?? 0) > 0) return "MODEL_FAILURE";
		return "UNKNOWN";
	}
	return "UNKNOWN";
}
