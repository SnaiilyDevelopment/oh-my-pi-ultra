/**
 * Deterministic verification and bounded failure-recovery for OMP Ultra.
 *
 * Policy/planning is model-agnostic. Command execution is injected so hosts can
 * reuse their existing process/tool execution path. The coding-agent runtime
 * supplies the repository executor and uses Agent.followUp() for repairs.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TaskRouteTracker, type TaskComplexity } from "./task-router";

export type VerificationState = "VERIFIED_SUCCESS" | "PARTIAL_SUCCESS" | "FAILED" | "BLOCKED" | "UNVERIFIED";

export type VerificationFailureCategory =
	| "COMPILE_ERROR"
	| "TYPE_ERROR"
	| "LINT_ERROR"
	| "TEST_FAILURE"
	| "BUILD_FAILURE"
	| "DEPENDENCY_FAILURE"
	| "ENVIRONMENT_FAILURE"
	| "NETWORK_FAILURE"
	| "TIMEOUT"
	| "TOOL_ERROR"
	| "UNKNOWN";

export type VerificationCheckKind = "typecheck" | "test" | "lint" | "build" | "compile" | "vet" | "custom";

export interface VerificationCheck {
	name: string;
	command: string;
	args: string[];
	reason: string;
	priority: number;
	cost: "cheap" | "moderate" | "expensive";
	dependencies: string[];
	kind: VerificationCheckKind;
	packagePath?: string;
	broad?: boolean;
}

export interface VerificationPlan {
	risk: "low" | "medium" | "high" | "critical";
	scope: "single-file" | "single-package" | "multi-package" | "repository";
	checks: VerificationCheck[];
	estimatedCost: "cheap" | "moderate" | "expensive";
	requiredEvidence: string[];
	changedFiles: string[];
	unexpectedFiles: string[];
}

export interface VerificationCommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	durationMs: number;
}

export interface VerificationExecutor {
	execute(check: VerificationCheck, signal?: AbortSignal): Promise<VerificationCommandResult>;
}

export interface VerificationFailure {
	check: string;
	status: "failed";
	category: VerificationFailureCategory;
	summary: string;
	primaryError?: string;
	expectedActual?: string;
	relatedFiles: string[];
	affectedSymbols: string[];
	attempt: number;
	rawOutputAvailable: boolean;
	rawOutput: string;
}

export interface VerificationCheckResult {
	check: VerificationCheck;
	status: "passed" | "failed" | "blocked" | "skipped";
	durationMs: number;
	failure?: VerificationFailure;
}

export interface VerificationRunResult {
	state: VerificationState;
	plan: VerificationPlan;
	checks: VerificationCheckResult[];
	failure?: VerificationFailure;
	message: string;
}

export interface VerificationTelemetry {
	plan: VerificationPlan;
	checksSelected: number;
	checksExecuted: number;
	checksSkipped: number;
	checksPassed: number;
	checksFailed: number;
	checkDurationsMs: Record<string, number>;
	failureCategory?: VerificationFailureCategory;
	repairAttempts: number;
	repairsModelCalls: number;
	repairsToolCalls: number;
	escalations: number;
	finalState: VerificationState;
}

export interface VerificationPolicyInput {
	task: string;
	complexity: TaskComplexity;
	changedFiles: string[];
	availableScripts: Record<string, string>;
	packageScripts?: Record<string, Record<string, string>>;
	hasTests?: boolean;
	confidence?: number;
}

export interface RecoveryPolicyOptions {
	maxSameFailureRepairs?: number;
	maxTotalRepairs?: number;
}

const FILE_EXTENSIONS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
	".rs", ".py", ".go", ".java", ".kt", ".rb", ".php",
]);

function extension(file: string): string {
	return path.extname(file).toLowerCase();
}

function isCodeFile(file: string): boolean {
	return FILE_EXTENSIONS.has(extension(file));
}

function isTestFile(file: string): boolean {
	return /(^|[._/\\-])(test|spec)(?:[._/\\-]|$)|(?:^|[._/\\-])tests?(?:[._/\\-]|$)/i.test(file);
}

function isConfigFile(file: string): boolean {
	return /(^|[./_-])(package\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|tsconfig|vite|webpack|rollup|cargo|pyproject|requirements|go\.mod|go\.sum|gradle|pom|biome|eslint|prettier|\.env)([./_-]|$)/i.test(file);
}

function packageFor(file: string): string | undefined {
	const normalized = file.replace(/\\/g, "/");
	const marker = "/packages/";
	const index = normalized.indexOf(marker);
	if (index < 0) return undefined;
	const rest = normalized.slice(index + marker.length);
	const name = rest.split("/")[0];
	return name ? `packages/${name}` : undefined;
}

function rootScript(scripts: Record<string, string>, name: string): string | undefined {
	return typeof scripts[name] === "string" ? scripts[name] : undefined;
}

function detectLanguage(files: readonly string[]): "typescript" | "rust" | "python" | "go" | "other" {
	if (files.some(file => [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension(file)))) return "typescript";
	if (files.some(file => extension(file) === ".rs")) return "rust";
	if (files.some(file => extension(file) === ".py")) return "python";
	if (files.some(file => extension(file) === ".go")) return "go";
	return "other";
}

function riskFor(input: VerificationPolicyInput): VerificationPlan["risk"] {
	const configChanged = input.changedFiles.some(isConfigFile);
	const codeCount = input.changedFiles.filter(isCodeFile).length;
	if (input.complexity === "VERY_COMPLEX" || (configChanged && input.changedFiles.length > 2)) return "critical";
	if (input.complexity === "COMPLEX" || input.changedFiles.length > 3 || codeCount > 3) return "high";
	if (input.complexity === "NORMAL" || codeCount > 0) return "medium";
	return "low";
}

function scopeFor(input: VerificationPolicyInput): VerificationPlan["scope"] {
	const packages = new Set(input.changedFiles.map(packageFor).filter(Boolean));
	if (packages.size > 1) return "multi-package";
	if (packages.size === 1) return "single-package";
	if (input.changedFiles.length > 4) return "repository";
	return "single-file";
}

function commandForScript(script: string, packagePath?: string): { command: string; args: string[] } {
	const prefix = packagePath ? ["--cwd", packagePath] : [];
	return { command: "bun", args: [...prefix, "run", script] };
}

function pushScriptCheck(
	checks: VerificationCheck[],
	scriptName: string,
	script: string | undefined,
	input: VerificationPolicyInput,
	kind: VerificationCheckKind,
	reason: string,
	priority: number,
	cost: VerificationCheck["cost"],
	packagePath?: string,
	broad = false,
): void {
	if (!script) return;
	const { command, args } = commandForScript(scriptName, packagePath);
	checks.push({
		name: packagePath ? `${packagePath}:${scriptName}` : scriptName,
		command,
		args,
		reason,
		priority,
		cost,
		dependencies: [],
		kind,
		packagePath,
		broad,
	});
}

/** Build the smallest meaningful verification stack for the change surface. */
export function buildVerificationPlan(input: VerificationPolicyInput): VerificationPlan {
	const changed = [...new Set(input.changedFiles.map(file => file.replace(/\\/g, "/")))].sort();
	const risk = riskFor({ ...input, changedFiles: changed });
	const scope = scopeFor({ ...input, changedFiles: changed });
	const language = detectLanguage(changed);
	const codeFiles = changed.filter(isCodeFile);
	const testsChanged = changed.some(isTestFile);
	const configChanged = changed.some(isConfigFile);
	const packages = [...new Set(changed.map(packageFor).filter((value): value is string => Boolean(value)))];
	const checks: VerificationCheck[] = [];

	for (const packagePath of packages) {
		const scripts = input.packageScripts?.[packagePath] ?? {};
		if (language === "typescript" && (codeFiles.some(file => file.startsWith(`${packagePath}/`)) || testsChanged)) {
			pushScriptCheck(checks, "check:types", scripts["check:types"], input, "typecheck", "Affected package has TypeScript/JavaScript changes", 10, "cheap", packagePath);
			pushScriptCheck(checks, "lint", scripts.lint, input, "lint", "Affected package exposes a deterministic lint check", 25, "moderate", packagePath);
		}
		if (codeFiles.some(file => file.startsWith(`${packagePath}/`)) || testsChanged) {
			pushScriptCheck(checks, "test", scripts.test, input, "test", testsChanged ? "Tests changed in the affected package" : "Source changed in the affected package", 20, "moderate", packagePath);
		}
		if (configChanged || input.complexity === "COMPLEX" || input.complexity === "VERY_COMPLEX") {
			pushScriptCheck(checks, "build", scripts.build, input, "build", "Configuration/high-complexity change warrants build validation", 40, "expensive", packagePath, true);
		}
	}

	const root = input.availableScripts;
	if (checks.length === 0 && language === "typescript" && codeFiles.length > 0) {
		pushScriptCheck(checks, "check:ts", rootScript(root, "check:ts"), input, "typecheck", "No affected package check was discoverable; use repository TypeScript checks", 10, "cheap", undefined, true);
	}
	if (checks.length === 0 && language === "rust" && rootScript(root, "check:rs")) {
		checks.push({ name: "check:rs", command: "bun", args: ["run", "check:rs"], reason: "Rust changes require compiler validation", priority: 10, cost: "cheap", dependencies: [], kind: "compile", broad: true });
	}
	if (checks.length === 0 && language === "python") {
		for (const file of codeFiles) {
			checks.push({ name: `compile:${file}`, command: "python3", args: ["-m", "py_compile", file], reason: "Python source changed and no package verification script was discovered", priority: 10, cost: "cheap", dependencies: [], kind: "compile" });
		}
	}
	if (checks.length === 0 && language === "go") {
		checks.push({ name: "go-test", command: "go", args: ["test", "./..."], reason: "Go source changed", priority: 20, cost: "moderate", dependencies: [], kind: "test", broad: true });
		checks.push({ name: "go-vet", command: "go", args: ["vet", "./..."], reason: "Go source changed and vet is a deterministic static check", priority: 30, cost: "moderate", dependencies: ["go-test"], kind: "vet", broad: true });
	}

	if (language === "other" && !codeFiles.length && !testsChanged) {
		// Documentation-only edits intentionally have no application test requirement.
		if (changed.length > 0) {
			return {
				risk,
				scope,
				checks: [],
				estimatedCost: "cheap",
				requiredEvidence: ["changed files are present in the resulting workspace"],
				changedFiles: changed,
				unexpectedFiles: detectUnexpectedFiles(input.task, changed),
			};
		}
	}

	const maxDepth = input.complexity === "SIMPLE" ? 25 : input.complexity === "NORMAL" ? 30 : input.complexity === "COMPLEX" ? 45 : 60;
	const prioritized = checks
		.sort((a, b) => a.priority - b.priority)
		.filter((check, index, list) => list.findIndex(other => other.name === check.name) === index);
	const finalChecks = prioritized.filter((_, index) => index < maxDepth);
	const estimatedCost = finalChecks.some(check => check.cost === "expensive") ? "expensive" : finalChecks.some(check => check.cost === "moderate") ? "moderate" : "cheap";
	return {
		risk,
		scope,
		checks: finalChecks,
		estimatedCost,
		requiredEvidence: finalChecks.length > 0 ? finalChecks.map(check => `${check.name} passed`) : ["no deterministic application check was available"],
		changedFiles: changed,
		unexpectedFiles: detectUnexpectedFiles(input.task, changed),
	};
}

function detectUnexpectedFiles(task: string, changedFiles: readonly string[]): string[] {
	const mentions = task.match(/(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[\w]+/g) ?? [];
	if (mentions.length === 0) return [];
	const normalizedMentions = mentions.map(file => file.replace(/\\/g, "/").toLowerCase());
	return changedFiles.filter(file => {
		const normalized = file.toLowerCase();
		return !normalizedMentions.some(mention => normalized === mention || normalized.endsWith(`/${mention}`));
	});
}

function classifyFailure(check: VerificationCheck, result: VerificationCommandResult, output: string): VerificationFailureCategory {
	if (result.killed) return /timeout/i.test(output) ? "TIMEOUT" : "ENVIRONMENT_FAILURE";
	if (/network|fetch|econnreset|enotfound|socket|timed out|connection refused/i.test(output)) return "NETWORK_FAILURE";
	if (/no such file|permission denied|command not found|working directory|executable/i.test(output)) return "ENVIRONMENT_FAILURE";
	if (/could not resolve|unable to resolve|cannot find module|package.*not found|lockfile/i.test(output)) return "DEPENDENCY_FAILURE";
	if (check.kind === "typecheck" || /TS\d{3,5}|typescript|type .* is not assignable|property .* does not exist/i.test(output)) return "TYPE_ERROR";
	if (check.kind === "compile" || /syntax error|parse error|compilation failed|cannot compile|compile error/i.test(output)) return "COMPILE_ERROR";
	if (check.kind === "lint" || /eslint|biome|lint/i.test(output)) return "LINT_ERROR";
	if (check.kind === "test" || /failed tests?|failing tests?|assertion|expected .*received|test suite/i.test(output)) return "TEST_FAILURE";
	if (check.kind === "build" || /build failed|build error|vite .*error|webpack .*error/i.test(output)) return "BUILD_FAILURE";
	if (check.kind === "vet" && /error:/i.test(output)) return "COMPILE_ERROR";
	if (/tool|invalid argument|unsupported option|usage:/i.test(output)) return "TOOL_ERROR";
	return "UNKNOWN";
}

function extractRelatedFiles(output: string): string[] {
	const matches = output.match(/(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[^\s:'"]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|rb|php|json|yaml|yml|toml|css|scss|md)(?=[:(\s]|$)/g) ?? [];
	return [...new Set(matches.map(value => value.replace(/[),.;]+$/, "")))].slice(0, 12);
}

function extractSymbols(output: string): string[] {
	const symbols = output.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}(?=\(|\b)/g) ?? [];
	return [...new Set(symbols)].slice(0, 12);
}

function firstErrorLine(output: string): string | undefined {
	return output.split(/\r?\n/).find(line => /error|failed|exception|traceback|assertion/i.test(line))?.trim().slice(0, 500);
}

function compactSummary(output: string): string {
	const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	const highSignal = lines.filter(line => /error|failed|failure|exception|assertion|warning|expected|received/i.test(line));
	const selected = (highSignal.length > 0 ? highSignal : lines).slice(0, 6);
	return selected.join(" | ").slice(0, 1200) || "Verification command failed without diagnostic text.";
}

export function extractVerificationFailure(
	check: VerificationCheck,
	result: VerificationCommandResult,
	attempt: number,
): VerificationFailure {
	const rawOutput = `${result.stdout}\n${result.stderr}`.trim().slice(0, 64_000);
	const category = classifyFailure(check, result, rawOutput);
	const primaryError = firstErrorLine(rawOutput);
	const expected = rawOutput.match(/expected[^\n]{0,240}(?:received|actual)[^\n]{0,240}/i)?.[0]?.slice(0, 500);
	return {
		check: check.name,
		status: "failed",
		category,
		summary: compactSummary(rawOutput),
		primaryError,
		expectedActual: expected,
		relatedFiles: extractRelatedFiles(rawOutput),
		affectedSymbols: extractSymbols(rawOutput),
		attempt,
		rawOutputAvailable: rawOutput.length > 0,
		rawOutput,
	};
}

function blockedCategory(category: VerificationFailureCategory): boolean {
	return category === "ENVIRONMENT_FAILURE" || category === "NETWORK_FAILURE" || category === "TIMEOUT" || category === "DEPENDENCY_FAILURE";
}

export function failureTrigger(category: VerificationFailureCategory): "unexpected_dependency" | "test_failure" | "verification_failure" | "repair_failure" {
	if (category === "DEPENDENCY_FAILURE") return "unexpected_dependency";
	if (category === "TEST_FAILURE") return "test_failure";
	return category === "UNKNOWN" || category === "TOOL_ERROR" ? "repair_failure" : "verification_failure";
}

/** Execute a verification plan with cheap-first short-circuiting. */
export async function executeVerificationPlan(
	plan: VerificationPlan,
	executor: VerificationExecutor,
	signal?: AbortSignal,
): Promise<VerificationRunResult> {
	if (plan.checks.length === 0) {
		return {
			state: "UNVERIFIED",
			plan,
			checks: [],
			message: "No meaningful deterministic verification was available for this change surface.",
		};
	}
	const results: VerificationCheckResult[] = [];
	for (const check of plan.checks) {
		if (signal?.aborted) {
			results.push({ check, status: "blocked", durationMs: 0 });
			return { state: "BLOCKED", plan, checks: results, message: "Verification was aborted before all checks completed." };
		}
		if (check.dependencies.some(dependency => results.find(result => result.check.name === dependency)?.status !== "passed")) {
			results.push({ check, status: "skipped", durationMs: 0 });
			continue;
		}
		const started = performance.now();
		let result: VerificationCommandResult;
		try {
			result = await executor.execute(check, signal);
		} catch (error) {
			const durationMs = performance.now() - started;
			const failure: VerificationFailure = {
				check: check.name,
				status: "failed",
				category: "TOOL_ERROR",
				summary: error instanceof Error ? error.message : String(error),
				relatedFiles: [],
				affectedSymbols: [],
				attempt: 1,
				rawOutputAvailable: false,
				rawOutput: "",
			};
			results.push({ check, status: blockedCategory(failure.category) ? "blocked" : "failed", durationMs, failure });
			return {
				state: blockedCategory(failure.category) ? "BLOCKED" : "FAILED",
				plan,
				checks: results,
				failure,
				message: failure.summary,
			};
		}
		const durationMs = result.durationMs || performance.now() - started;
		if (result.code === 0 && !result.killed) {
			results.push({ check, status: "passed", durationMs });
			continue;
		}
		const failure = extractVerificationFailure(check, result, 1);
		results.push({ check, status: "failed", durationMs, failure });
		return {
			state: blockedCategory(failure.category) ? "BLOCKED" : "FAILED",
			plan,
			checks: results,
			failure,
			message: failure.summary,
		};
	}
	const skipped = results.some(result => result.status === "skipped");
	return {
		state: skipped ? "PARTIAL_SUCCESS" : "VERIFIED_SUCCESS",
		plan,
		checks: results,
		message: skipped ? "The meaningful checks that could run passed; dependent checks were skipped." : "All selected verification checks passed.",
	};
}

/**
 * Render compact repair context. Raw output remains available in the failure
 * record but is not injected into the model-facing repair message.
 */
export function buildRepairMessage(
	task: string,
	failure: VerificationFailure,
	previousAttempts: readonly string[],
	nextCheck: VerificationCheck | undefined,
	complexity: TaskComplexity,
): string {
	const files = failure.relatedFiles.length > 0 ? failure.relatedFiles.join(", ") : "none extracted";
	const symbols = failure.affectedSymbols.length > 0 ? failure.affectedSymbols.join(", ") : "none extracted";
	const attempts = previousAttempts.length > 0 ? previousAttempts.join(" | ") : "none";
	const verificationTarget = nextCheck?.name ?? failure.check;
	return [
		"Verification failed. Do a targeted repair, not a repository-wide rewrite.",
		`Task: ${task}`,
		`Failed check: ${failure.check}`,
		`Failure category: ${failure.category}`,
		`Summary: ${failure.summary}`,
		`Primary error: ${failure.primaryError ?? "not extracted"}`,
		`Expected/actual: ${failure.expectedActual ?? "not extracted"}`,
		`Related files: ${files}`,
		`Affected symbols: ${symbols}`,
		`Previous repair attempts: ${attempts}`,
		`Current Task Router complexity: ${complexity}`,
		`Next verification target: ${verificationTarget}`,
		`Raw command output is available from verification telemetry if deeper diagnosis is needed.`,
		"Inspect the affected symbol/dependency, make the smallest repair justified by the evidence, then stop so the deterministic check can rerun.",
	].join("\n");
}

export interface VerificationRecoveryDecision {
	action: "repair" | "escalate" | "stop";
	reason: string;
	failureSignature: string;
	escalated: boolean;
}

/** Finite recovery policy shared by runtime integrations and tests. */
export class VerificationRecoveryController {
	readonly maxSameFailureRepairs: number;
	readonly maxTotalRepairs: number;
	private totalRepairs = 0;
	private sameFailureCounts = new Map<string, number>();
	private lastWorkspaceSignature?: string;

	constructor(options: RecoveryPolicyOptions = {}) {
		this.maxSameFailureRepairs = options.maxSameFailureRepairs ?? 2;
		this.maxTotalRepairs = options.maxTotalRepairs ?? 4;
	}

	get repairAttempts(): number {
		return this.totalRepairs;
	}

	decide(
		failure: VerificationFailure,
		workspaceSignature: string,
		tracker: TaskRouteTracker,
	): VerificationRecoveryDecision {
		const signature = `${failure.category}|${failure.check}|${failure.primaryError ?? failure.summary.slice(0, 180)}`;
		const same = (this.sameFailureCounts.get(signature) ?? 0) + 1;
		this.sameFailureCounts.set(signature, same);
		const changedWorkspace = this.lastWorkspaceSignature !== undefined && this.lastWorkspaceSignature !== workspaceSignature;
		this.lastWorkspaceSignature = workspaceSignature;

		if (blockedCategory(failure.category)) {
			return { action: "stop", reason: "Verification is blocked by the environment/dependency/network condition.", failureSignature: signature, escalated: false };
		}
		if (this.totalRepairs >= this.maxTotalRepairs) {
			return { action: "stop", reason: "Maximum autonomous repair budget reached.", failureSignature: signature, escalated: false };
		}
		if (same > this.maxSameFailureRepairs) {
			return { action: "stop", reason: "The same verification failure persisted beyond the bounded repair policy.", failureSignature: signature, escalated: false };
		}
		if (failure.category === "UNKNOWN" && same > 1) {
			return { action: "stop", reason: "Repeated unknown verification failures require human diagnosis.", failureSignature: signature, escalated: false };
		}
		if (same > 1 && !changedWorkspace) {
			return { action: "stop", reason: "The attempted repair did not change the workspace, so rerunning the same deterministic failure would be wasteful.", failureSignature: signature, escalated: false };
		}

		const escalation = tracker.observe(failureTrigger(failure.category), `verification ${failure.check} failed: ${failure.summary.slice(0, 220)}`);
		if (escalation) {
			return { action: "repair", reason: `Escalated ${escalation.from} → ${escalation.to} after bounded verification evidence.`, failureSignature: signature, escalated: true };
		}
		this.totalRepairs++;
		return { action: "repair", reason: "Targeted repair is still within the bounded recovery budget.", failureSignature: signature, escalated: false };
	}
}

export async function readWorkspacePackageScripts(cwd: string): Promise<{ rootScripts: Record<string, string>; packageScripts: Record<string, Record<string, string>> }> {
	const packageScripts: Record<string, Record<string, string>> = {};
	let rootScripts: Record<string, string> = {};
	try {
		const root = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
		rootScripts = Object.fromEntries(Object.entries(root.scripts ?? {}).filter(([, value]) => typeof value === "string")) as Record<string, string>;
	} catch {}
	try {
		const entries = await fs.readdir(path.join(cwd, "packages"), { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			try {
				const pkg = JSON.parse(await fs.readFile(path.join(cwd, "packages", entry.name, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
				packageScripts[`packages/${entry.name}`] = Object.fromEntries(
					Object.entries(pkg.scripts ?? {}).filter(([, value]) => typeof value === "string"),
				) as Record<string, string>;
			} catch {}
		}
	} catch {}
	return { rootScripts, packageScripts };
}
