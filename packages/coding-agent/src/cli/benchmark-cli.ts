import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_REGRESSION_THRESHOLDS, compareRecords } from "../benchmark/metrics";
import { renderComparison, summarizeRunSet } from "../benchmark/report";
import { newRunSetId, runBenchmarkTask, validateBenchmarkEnvironment } from "../benchmark/runner";
import { BenchmarkStore } from "../benchmark/storage";
import { BENCHMARK_CATEGORIES, BENCHMARK_VARIANTS, type BenchmarkRunRecord, type BenchmarkRunSet, type BenchmarkTaskSuite, type BenchmarkVariant, type RegressionThresholds } from "../benchmark/types";

export interface BenchmarkCommandArgs {
	action: string;
	target?: string;
	flags: {
		suite?: string;
		repository?: string;
		tasks?: string;
		variant?: string;
		baselineCommand?: string;
		ultraCommand?: string;
		runs?: number;
		timeout?: number;
		outputDir?: string;
		model?: string;
		provider?: string;
		ompCommit?: string;
		ompUltraCommit?: string;
		branch?: string;
		requireTools?: string;
		json?: boolean;
		successThreshold?: number;
		tokenThreshold?: number;
		latencyThreshold?: number;
		modelCallThreshold?: number;
		toolCallThreshold?: number;
	};
}

const SEED_SUITE = path.join(import.meta.dir, "..", "benchmark", "seed-suite.json");

function positive(value: number | undefined, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) throw new Error(`Expected --${label} to be a positive integer, got ${value}`);
	return value;
}
function loadSuite(file: string): Promise<BenchmarkTaskSuite> {
	return fs.readFile(path.resolve(file), "utf8").then(text => {
		const suite = JSON.parse(text) as BenchmarkTaskSuite;
		validateSuite(suite);
		return suite;
	});
}
function validateSuite(suite: BenchmarkTaskSuite): void {
	if (!suite || typeof suite.name !== "string" || !Array.isArray(suite.tasks) || suite.tasks.length === 0) throw new Error("invalid benchmark suite: expected a non-empty tasks array");
	const ids = new Set<string>();
	for (const task of suite.tasks) {
		if (!task.id || ids.has(task.id)) throw new Error(`invalid or duplicate benchmark task id: ${task.id}`);
		ids.add(task.id);
		if (!BENCHMARK_CATEGORIES.includes(task.category)) throw new Error(`invalid benchmark category for ${task.id}: ${task.category}`);
		if (!task.prompt || !task.expectedOutcome || !task.verification) throw new Error(`invalid benchmark task: ${task.id}`);
		if (!task.timeout || task.timeout <= 0) throw new Error(`invalid timeout for ${task.id}`);
	}
}
function selectTasks(suite: BenchmarkTaskSuite, filter?: string) {
	if (!filter) return suite.tasks;
	const wanted = new Set(filter.split(",").map(value => value.trim()).filter(Boolean));
	const selected = suite.tasks.filter(task => wanted.has(task.id));
	if (selected.length !== wanted.size) throw new Error(`one or more requested tasks were not found: ${[...wanted].filter(id => !suite.tasks.some(task => task.id === id)).join(", ")}`);
	return selected;
}
function selectVariants(value?: string): BenchmarkVariant[] {
	const requested = value ?? "both";
	if (requested === "both") return ["baseline", "ultra"];
	if (!BENCHMARK_VARIANTS.includes(requested as BenchmarkVariant)) throw new Error(`invalid benchmark variant: ${requested}`);
	return [requested as BenchmarkVariant];
}
function thresholds(flags: BenchmarkCommandArgs["flags"]): RegressionThresholds {
	return {
		successRateDelta: flags.successThreshold ?? DEFAULT_REGRESSION_THRESHOLDS.successRateDelta,
		tokenIncreaseRatio: flags.tokenThreshold ?? DEFAULT_REGRESSION_THRESHOLDS.tokenIncreaseRatio,
		latencyIncreaseRatio: flags.latencyThreshold ?? DEFAULT_REGRESSION_THRESHOLDS.latencyIncreaseRatio,
		modelCallIncreaseRatio: flags.modelCallThreshold ?? DEFAULT_REGRESSION_THRESHOLDS.modelCallIncreaseRatio,
		toolCallIncreaseRatio: flags.toolCallThreshold ?? DEFAULT_REGRESSION_THRESHOLDS.toolCallIncreaseRatio,
	};
}
async function loadRecords(store: BenchmarkStore, ids: string[]): Promise<BenchmarkRunRecord[]> { return Promise.all(ids.map(id => store.loadRun(id))); }

export async function runBenchmarkCommand(args: BenchmarkCommandArgs): Promise<unknown> {
	const store = new BenchmarkStore(path.resolve(args.flags.outputDir ?? ".omp/benchmarks"));
	await store.init();
	if (args.action === "list") {
		const suite = await loadSuite(args.flags.suite ?? SEED_SUITE);
		return { suite: suite.name, version: suite.version, taskCount: suite.tasks.length, tasks: suite.tasks.map(task => ({ id: task.id, category: task.category, difficulty: task.difficulty, description: task.description, tags: task.tags })) };
	}
	if (args.action === "task") {
		const suite = await loadSuite(args.flags.suite ?? SEED_SUITE);
		const task = suite.tasks.find(candidate => candidate.id === args.target);
		if (!task) throw new Error(`unknown benchmark task: ${args.target}`);
		return task;
	}
	if (args.action === "report") {
		const set = await store.loadRunSet(args.target ?? "");
		const records = await loadRecords(store, set.runs);
		if (set.variants.includes("baseline") && set.variants.includes("ultra")) return renderComparison(compareRecords(records.filter(r => r.variant === "baseline"), records.filter(r => r.variant === "ultra"), set.runSetId, set.runSetId, thresholds(args.flags)));
		return summarizeRunSet(records);
	}
	if (args.action === "compare") {
		const baselineSetId = args.flags.outputDir ? args.target?.split(",")[0]?.trim() : args.target?.split(",")[0]?.trim();
		const ultraSetId = args.target?.split(",")[1]?.trim();
		if (!baselineSetId || !ultraSetId) throw new Error("compare requires <baseline-run-set>,<ultra-run-set>");
		const baselineSet = await store.loadRunSet(baselineSetId);
		const ultraSet = await store.loadRunSet(ultraSetId);
		const report = compareRecords(await loadRecords(store, baselineSet.runs), await loadRecords(store, ultraSet.runs), baselineSet.runSetId, ultraSet.runSetId, thresholds(args.flags));
		await store.saveReport(`${baselineSet.runSetId}-vs-${ultraSet.runSetId}`, report);
		return args.flags.json ? report : renderComparison(report);
	}
	if (args.action === "replay") {
		const record = await store.loadRun(args.target ?? "");
		return {
			runId: record.runId,
			taskId: record.taskId,
			variant: record.variant,
			repositoryCommit: record.environment.repositoryCommit,
			model: record.environment.model,
			provider: record.environment.provider,
			commandProfile: record.reproducibility.commandProfile,
			taskFingerprint: record.reproducibility.taskFingerprint,
			probabilisticModelRun: record.reproducibility.probabilisticModelRun,
			message: "Replay metadata is reproducible only when the same repository commit, model/settings, benchmark task, and runner command are restored. Raw secrets are never persisted.",
		};
	}
	if (args.action !== "run") throw new Error(`unknown benchmark action: ${args.action}`);

	const suitePath = args.flags.suite ?? SEED_SUITE;
	const suite = await loadSuite(suitePath);
	const tasks = selectTasks(suite, args.flags.tasks);
	const variants = selectVariants(args.flags.variant);
	const runsPerTask = positive(args.flags.runs, 1, "runs");
	const timeoutMs = positive(args.flags.timeout, 900_000, "timeout");
	const repositoryCandidates = [...new Set(tasks.map(task => task.repository).filter(Boolean))];
	const repository = path.resolve(args.flags.repository ?? repositoryCandidates[0] ?? process.cwd());
	if (!args.flags.repository && repositoryCandidates.length > 1) throw new Error("selected tasks reference multiple repositories; pass --repository explicitly");
	const envErrors = await validateBenchmarkEnvironment(repository);
	if (envErrors.length) throw new Error(`benchmark environment invalid:\n- ${envErrors.join("\n- ")}`);

	const runSetId = newRunSetId();
	const runIds: string[] = [];
	for (const variant of variants) {
		for (const task of tasks) {
			const command = variant === "baseline" ? (args.flags.baselineCommand ?? task.commands?.baseline) : (args.flags.ultraCommand ?? task.commands?.ultra);
			if (!command) throw new Error(`no ${variant} runner command configured for task ${task.id}; use --${variant === "baseline" ? "baseline" : "ultra"}-command or task.commands`);
			for (let attempt = 1; attempt <= runsPerTask; attempt += 1) {
				const record = await runBenchmarkTask(task, { variant, command, repository, runsRoot: store.root, runSetId, attempt, timeoutMs: Math.min(timeoutMs, task.timeout), model: args.flags.model, provider: args.flags.provider, ompCommit: args.flags.ompCommit, ompUltraCommit: args.flags.ompUltraCommit, branch: args.flags.branch, store, environment: {} });
				await store.saveRun(record);
				runIds.push(record.runId);
			}
		}
	}
	const set: BenchmarkRunSet = { version:1, runSetId, createdAt:new Date().toISOString(), suiteName:suite.name, suiteVersion:suite.version, tasks:tasks.map(task=>task.id), variants, runs:runIds, config:{runsPerTask,timeoutMs,repositoryOverride:args.flags.repository,model:args.flags.model,provider:args.flags.provider,suitePath:path.resolve(suitePath)} };
	await store.saveRunSet(set);
	await store.saveTaskSuite(suite);
	const records = await loadRecords(store, runIds);
	if (args.flags.json) return { runSet:set, summary:summarizeRunSet(records) };
	return `Run set ${runSetId}\n${summarizeRunSet(records)}`;
}
