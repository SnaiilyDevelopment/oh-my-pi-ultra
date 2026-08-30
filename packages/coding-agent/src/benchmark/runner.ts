import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { executeVerificationPlan, type VerificationPlan, type VerificationRunResult } from "@oh-my-pi/pi-agent-core";
import { failureCauseFrom, metricsFromTelemetry } from "./metrics";
import { fingerprintTask, hashCommand, redactEnvironment, sanitizeObject, sanitizeString, safePath } from "./sanitize";
import type { BenchmarkEnvironment, BenchmarkOutcome, BenchmarkRunRecord, BenchmarkTask, BenchmarkTelemetryEvidence, BenchmarkVariant } from "./types";
import { BenchmarkStore } from "./storage";

export interface BenchmarkRunOptions {
	variant: BenchmarkVariant;
	command: string;
	repository: string;
	runsRoot: string;
	runSetId: string;
	attempt: number;
	timeoutMs: number;
	model?: string;
	provider?: string;
	ompCommit?: string;
	ompUltraCommit?: string;
	branch?: string;
	environment?: Record<string, string | undefined>;
	store: BenchmarkStore;
}

interface CommandResult { code: number; signal?: string; stdout: string; stderr: string; durationMs: number; timedOut: boolean; }

export function shell(command: string, cwd: string, env: Record<string, string | undefined>, timeoutMs: number): Promise<CommandResult> {
	const started = performance.now();
	return new Promise(resolve => {
		const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
		child.stdout?.on("data", data => { stdout += String(data); });
		child.stderr?.on("data", data => { stderr += String(data); });
		child.on("error", error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error), durationMs: performance.now() - started, timedOut }); });
		child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code: code ?? -1, signal: signal ?? undefined, stdout, stderr, durationMs: performance.now() - started, timedOut }); });
	});
}

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
	const quoted = args.map(arg => JSON.stringify(arg)).join(" ");
	return shell(`git ${quoted}`, cwd, process.env as Record<string, string>, timeoutMs);
}
async function currentCommit(repository: string): Promise<string> { const result = await git(repository, ["rev-parse", "HEAD"]); if (result.code !== 0) throw new Error(`repository is not a git checkout: ${sanitizeString(result.stderr, 1000)}`); return result.stdout.trim(); }
async function currentBranch(repository: string): Promise<string> { const result = await git(repository, ["rev-parse", "--abbrev-ref", "HEAD"]); return result.code === 0 ? result.stdout.trim() : "HEAD"; }
async function makeWorktree(repository: string, commit: string, root: string, runId: string): Promise<string> { const dir = path.join(root, safePath(runId)); await fs.mkdir(root, { recursive: true }); const result = await git(repository, ["worktree", "add", "--detach", dir, commit]); if (result.code !== 0) throw new Error(`worktree setup failed: ${sanitizeString(result.stderr, 1200)}`); return dir; }
async function removeWorktree(repository: string, dir: string): Promise<void> { await git(repository, ["worktree", "remove", "--force", dir]).catch(() => undefined); await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined); }

function parseEvidence(stdout: string): BenchmarkTelemetryEvidence | undefined {
	for (const line of stdout.split(/\r?\n/).reverse()) {
		const marker = "OMP_BENCH_EVIDENCE_JSON=";
		const index = line.indexOf(marker);
		if (index < 0) continue;
		try { return sanitizeObject(JSON.parse(line.slice(index + marker.length))) as BenchmarkTelemetryEvidence; } catch { return undefined; }
	}
	return undefined;
}

function verificationPlanFor(task: BenchmarkTask): VerificationPlan {
	const checks = (task.verification.commands ?? []).map((command, index) => ({
		name: `benchmark:command:${index + 1}`,
		command: process.platform === "win32" ? "cmd.exe" : "sh",
		args: process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command],
		reason: "benchmark deterministic verification command",
		priority: index + 1,
		cost: "moderate" as const,
		dependencies: index ? [`benchmark:command:${index}`] : [],
		kind: "custom" as const,
	}));
	const hasFilesystemChecks = (task.verification.requiredPaths?.length ?? 0) > 0 || (task.verification.forbiddenPaths?.length ?? 0) > 0 || (task.verification.expectedText?.length ?? 0) > 0;
	if (hasFilesystemChecks) checks.push({ name: "benchmark:filesystem", command: "internal", args: [], reason: "benchmark expected files and behavior", priority: checks.length + 1, cost: "cheap" as const, dependencies: checks.map(check => check.name), kind: "benchmark-files" as const });
	return { risk: task.difficulty === "hard" ? "high" : task.difficulty === "medium" ? "medium" : "low", scope: "repository", checks, estimatedCost: checks.some(check => check.cost === "moderate") ? "moderate" : "cheap", requiredEvidence: checks.map(check => `${check.name} passed`), changedFiles: [], unexpectedFiles: [] };
}

async function runVerification(task: BenchmarkTask, workspace: string): Promise<VerificationRunResult> {
	const plan = verificationPlanFor(task);
	const executor = {
		execute: async (check: VerificationPlan["checks"][number]) => {
			if (check.kind === "benchmark-files") {
				const missing: string[] = [];
				for (const relative of task.verification.requiredPaths ?? []) { try { await fs.access(path.join(workspace, relative)); } catch { missing.push(`missing:${relative}`); } }
				for (const relative of task.verification.forbiddenPaths ?? []) { try { await fs.access(path.join(workspace, relative)); missing.push(`forbidden:${relative}`); } catch {} }
				for (const item of task.verification.expectedText ?? []) { try { const text = await fs.readFile(path.join(workspace, item.path), "utf8"); if (!text.includes(item.text)) missing.push(`expected:${item.path}`); } catch { missing.push(`unreadable:${item.path}`); } }
				return { stdout: missing.length ? missing.join("\n") : "filesystem checks passed", stderr: "", code: missing.length ? 1 : 0, killed: false, durationMs: 0 };
			}
			const command = [check.command, ...check.args.map(arg => JSON.stringify(arg))].join(" ");
			const result = await shell(command, workspace, process.env as Record<string, string>, task.verification.timeoutMs ?? task.timeout);
			return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.timedOut, durationMs: result.durationMs };
		},
	};
	return executeVerificationPlan(plan, executor);
}

function outcomeFrom(command: CommandResult, verification: VerificationRunResult | undefined): BenchmarkOutcome {
	if (command.timedOut) return "TIMEOUT";
	if (command.code !== 0) return command.code === 127 ? "BLOCKED" : "FAILED";
	if (verification?.state === "BLOCKED") return "BLOCKED";
	if (verification?.state !== "VERIFIED_SUCCESS") return "UNVERIFIED";
	return "SUCCESS";
}

export async function validateBenchmarkEnvironment(repository: string): Promise<string[]> {
	const errors: string[] = [];
	try { await fs.access(repository); } catch { return [`repository does not exist: ${repository}`]; }
	try { await currentCommit(repository); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
	return errors;
}

export async function runBenchmarkTask(task: BenchmarkTask, options: BenchmarkRunOptions): Promise<BenchmarkRunRecord> {
	const runId = `${options.runSetId}-${task.id}-${options.variant}-${options.attempt}`;
	const startedAt = new Date().toISOString();
	const repository = path.resolve(options.repository);
	const commit = await currentCommit(repository);
	const branch = options.branch ?? await currentBranch(repository);
	const environment: BenchmarkEnvironment = {
		repository: "<sanitized>",
		repositoryCommit: commit,
		branch,
		os: `${os.platform()} ${os.release()}`,
		arch: os.arch(),
		runtimeVersions: { node: process.version, bun: process.versions.bun ?? "unavailable" },
		configuration: redactEnvironment(options.environment ?? {}),
		model: options.model,
		provider: options.provider,
		ompCommit: options.ompCommit,
		ompUltraCommit: options.ompUltraCommit,
		harnessVersion: 1,
	};
	let workspace = "";
	let command: CommandResult = { code: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };
	let verification: VerificationRunResult | undefined;
	let outcome: BenchmarkOutcome = "FAILED";
	let failureDetail: string | undefined;
	let telemetry: BenchmarkTelemetryEvidence | undefined;
	let comparisonEligible = true;
	try {
		workspace = await makeWorktree(repository, commit, path.join(options.runsRoot, "worktrees"), runId);
		for (const setup of task.setup ?? []) {
			const setupResult = await shell(setup, workspace, process.env as Record<string, string>, options.timeoutMs);
			if (setupResult.code !== 0 || setupResult.timedOut) {
				comparisonEligible = false;
				outcome = "BLOCKED";
				failureDetail = `benchmark setup failed: ${sanitizeString(setupResult.stderr || setupResult.stdout, 1200)}`;
				break;
			}
		}
		if (comparisonEligible) {
			const env = {
				OMP_BENCH_TASK_ID: task.id,
				OMP_BENCH_TASK_PROMPT: task.prompt,
				OMP_BENCH_EXPECTED_OUTCOME: task.expectedOutcome,
				OMP_BENCH_VARIANT: options.variant,
				OMP_BENCH_RUN_ID: runId,
				OMP_BENCH_EVIDENCE_FILE: path.join(options.store.root, "runs", `${safePath(runId)}.evidence.json`),
				OMP_BENCH_HARNESS_VERSION: "1",
			};
			command = await shell(options.command, workspace, env, options.timeoutMs);
			telemetry = parseEvidence(command.stdout);
			verification = command.code === 0 && !command.timedOut ? await runVerification(task, workspace) : undefined;
			outcome = outcomeFrom(command, verification);
			if (outcome !== "SUCCESS") failureDetail = sanitizeString(command.stderr || command.stdout || verification?.message || "benchmark run did not satisfy success criteria", 1600);
		}
	} catch (error) {
		comparisonEligible = false;
		outcome = "BLOCKED";
		failureDetail = sanitizeString(error instanceof Error ? error.message : String(error), 1600);
	} finally {
		const logs = await options.store.writeLog(runId, options.variant, command.stdout, command.stderr);
		if (workspace) await removeWorktree(repository, workspace);
		void logs;
	}
	const verificationState = verification?.state ?? (comparisonEligible ? "UNVERIFIED" : "ENVIRONMENT_FAILURE");
	const verificationSuccess = verificationState === "VERIFIED_SUCCESS";
	const checks = verification?.checks ?? [];
	const evidenceForMetrics = verification ? { success: verificationSuccess, finalState: verificationState, testsPassed: checks.filter(check => check.status === "passed").length, regressions: telemetry?.verification?.regressions ?? 0 } : { success: false, finalState: verificationState, testsPassed: 0, regressions: 0 };
	const metrics = metricsFromTelemetry(telemetry?.summary, telemetry, command.durationMs + checks.reduce((sum, check) => sum + check.durationMs, 0), evidenceForMetrics);
	metrics.failureCause = failureCauseFrom(command.code, command.timedOut, !verificationSuccess, telemetry);
	if (outcome === "SUCCESS") metrics.failureCause = "UNKNOWN";
	const cause = comparisonEligible ? (outcome === "SUCCESS" ? "UNKNOWN" : metrics.failureCause ?? "UNKNOWN") : "ENVIRONMENT_FAILURE";
	return {
		version: 1,
		runId,
		taskId: task.id,
		category: task.category,
		variant: options.variant,
		attempt: options.attempt,
		startedAt,
		durationMs: command.durationMs,
		environment,
		outcome,
		comparisonEligible,
		failureCause: cause,
		failureDetail,
		metrics,
		verification: {
			commands: checks.map(check => ({ commandHash: hashCommand(`${check.check.command} ${check.check.args.join(" ")}`), exitCode: check.status === "passed" ? 0 : 1, durationMs: check.durationMs })),
			requiredPathsMissing: [],
			forbiddenPathsFound: [],
			expectedTextMissing: [],
			finalState: verificationState,
		},
		telemetry: telemetry ?? {},
		artifacts: {
			stdoutLog: path.join(options.store.logsPath, `${safePath(runId)}-${options.variant}.stdout.log`),
			stderrLog: path.join(options.store.logsPath, `${safePath(runId)}-${options.variant}.stderr.log`),
		},
		reproducibility: { taskFingerprint: fingerprintTask(task), commandProfile: hashCommand(options.command), probabilisticModelRun: true },
	};
}

export function newRunSetId(): string { return `bench-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`; }
