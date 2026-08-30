/**
 * Cheap, deterministic task routing for OMP Ultra.
 *
 * This module intentionally has no model/provider dependency and performs no I/O.
 * It turns task text + already-known repository hints into a bounded workflow policy.
 */

export const TASK_COMPLEXITIES = ["SIMPLE", "NORMAL", "COMPLEX", "VERY_COMPLEX"] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

export type TaskReasoningDepth = "minimal" | "low" | "medium" | "high" | "maximum";
export type TaskVerificationDepth = "basic" | "standard" | "deep" | "final";

export interface TaskWorkflowPolicy {
	inspect: boolean;
	plan: boolean;
	explore: boolean;
	architecture: boolean;
	specialistResearch: boolean;
	verification: TaskVerificationDepth;
	reviewPasses: 0 | 1 | 2;
	maxEscalations: 1 | 2 | 3;
	reasoningDepth: TaskReasoningDepth;
}

export interface TaskRepositorySignals {
	repositorySize?: "small" | "medium" | "large";
	projectType?: string;
	framework?: string;
	hasTests?: boolean;
	relevantFileCount?: number;
	subsystemCount?: number;
	crossesSubsystems?: boolean;
	knownUncertainty?: boolean;
}

export interface TaskClassifierSignals {
	requestedOutcomes: number;
	likelyFiles: number;
	bugFix: boolean;
	debugging: boolean;
	architecture: boolean;
	newFeature: boolean;
	refactor: boolean;
	migration: boolean;
	explicitTests: boolean;
	externalResearch: boolean;
	crossSubsystem: boolean;
	uncertain: boolean;
}

export interface TaskClassification {
	complexity: TaskComplexity;
	confidence: number;
	score: number;
	reasons: string[];
	signals: TaskClassifierSignals;
	workflow: TaskWorkflowPolicy;
}

export interface TaskEscalation {
	from: TaskComplexity;
	to: TaskComplexity;
	reason: string;
	trigger: TaskEscalationTrigger;
	timestamp: number;
}

export type TaskEscalationTrigger =
	| "unexpected_dependency"
	| "test_failure"
	| "verification_failure"
	| "repair_failure"
	| "cross_subsystem_discovered";

export interface TaskRoutingTelemetry {
	initialComplexity: TaskComplexity;
	initialConfidence: number;
	selectedWorkflow: TaskWorkflowPolicy;
	escalations: TaskEscalation[];
	finalComplexity: TaskComplexity;
	finalWorkflow: TaskWorkflowPolicy;
}

/** Foundation for later benchmark aggregation; this type does not claim measurements. */
export interface TaskRoutingBenchmarkRecord {
	taskComplexity: TaskComplexity;
	initialConfidence: number;
	finalComplexity: TaskComplexity;	
	escalationCount: number;
	tokens?: number;
	modelCalls?: number;
	toolCalls?: number;
	retries?: number;
	latencyMs?: number;
	taskSuccess?: boolean;
}

const SIMPLE_PATTERNS = [
	/\b(rename|renaming)\b/i,
	/\b(fix|correct)\s+(the\s+)?(typo|spelling|grammar)\b/i,
	/\b(change|update|replace)\s+(the\s+)?(button|label|text|string)\b/i,
	/\b(update|change|set)\s+(the\s+)?(constant|literal)\b/i,
	/\bformat\b/i,
];

const BUG_PATTERNS = [
	/\bbug\b/i,
	/\b(broken|crash|crashes|error|fails|failure)\b/i,
	/\bfix\b/i,
];

const DEBUG_PATTERNS = [
	/\bdebug\b/i,
	/\bdebugging\b/i,
	/\binvestigate\b/i,
	/\breproduce\b/i,
	/\brepro\b/i,
	/\broot cause\b/i,
];

const ARCHITECTURE_PATTERNS = [
	/\barchitect(?:ure|ural)\b/i,
	/\bredesign\b/i,
	/\brework\b/i,
	/\breplace\s+(?:the\s+)?(?:architecture|persistence|data layer|auth(?:entication)? system)\b/i,
];

const FEATURE_PATTERNS = [
	/\b(add|implement|create|introduce|build)\b/i,
	/\b(new feature|new page|new endpoint|new command)\b/i,
];

const REFACTOR_PATTERNS = [
	/\brefactor\b/i,
	/\brestructure\b/i,
	/\bcleanup\b/i,
	/\bextract\b/i,
];

const MIGRATION_PATTERNS = [
	/\bmigrat(?:e|ion|ing)\b/i,
	/\bupgrade\s+(?:the\s+)?schema\b/i,
];

const RESEARCH_PATTERNS = [
	/\bresearch\b/i,
	/\bcompare\b/i,
	/\binvestigate\s+(?:options|alternatives)\b/i,
	/\blook\s+up\b/i,
	/\bexternal\b/i,
];

const CROSS_SUBSYSTEM_PATTERNS = [
	/\b(across|between|spanning|throughout)\b/i,
	/\b(frontend|front-end|backend|back-end|api|database|worker|service|cli)\b.*\b(frontend|front-end|backend|back-end|api|database|worker|service|cli)\b/i,
	/\bmultiple\s+(?:services|subsystems|packages|apps|repositories|repos)\b/i,
	/\bfull[- ]stack\b/i,
];

const TEST_PATTERNS = [/\btests?\b/i, /\bspec(?:s)?\b/i, /\btest suite\b/i, /\bcoverage\b/i];

function matchesAny(text: string, patterns: RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(text));
}

function countMatches(text: string, patterns: RegExp[]): number {
	return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function estimateOutcomes(text: string): number {
	const explicit = (text.match(/\b(and|then|also|plus|as well as)\b/gi) ?? []).length;
	const actionVerbs = (text.match(/\b(rename|change|update|add|remove|delete|fix|implement|create|refactor|migrate|redesign|replace|upgrade)\b/gi) ?? []).length;
	return Math.max(1, Math.min(6, Math.max(actionVerbs, 1) + explicit));
}

function estimateLikelyFiles(text: string, repository?: TaskRepositorySignals): number {
	if (repository?.relevantFileCount !== undefined) return Math.max(1, repository.relevantFileCount);
	const namedPaths = (text.match(/(?:^|\s)(?:[\w.-]+\/)+[\w./-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|rb|php|sql|css|scss|md|json|yaml|yml)\b/gi) ?? []).length;
	if (namedPaths > 0) return Math.min(12, namedPaths);
	if (matchesAny(text, [/\bmultiple\b/i, /\bseveral\b/i, /\bacross\b/i])) return 4;
	return 1;
}

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function baseScore(signals: TaskClassifierSignals, repository?: TaskRepositorySignals): number {
	let score = 0;
	score += Math.max(0, signals.requestedOutcomes - 1) * 0.8;
	score += Math.max(0, signals.likelyFiles - 1) * 0.55;
	if (signals.bugFix) score += 0.9;
	if (signals.debugging) score += 1.4;
	if (signals.architecture) score += 2.7;
	if (signals.newFeature) score += 1.1;
	if (signals.refactor) score += 1.8;
	if (signals.migration) score += 2.4;
	if (signals.explicitTests) score += 0.5;
	if (signals.externalResearch) score += 1.0;
	if (signals.crossSubsystem) score += 2.1;
	if (signals.uncertain) score += 0.9;
	if (repository?.repositorySize === "large") score += 0.5;
	if (repository?.subsystemCount !== undefined) score += Math.min(1.5, Math.max(0, repository.subsystemCount - 1) * 0.3);
	if (repository?.crossesSubsystems) score += 1.0;
	return score;
}

function complexityFromScore(score: number, signals: TaskClassifierSignals): TaskComplexity {
	if (signals.architecture && signals.migration && signals.crossSubsystem) return "VERY_COMPLEX";
	if (signals.architecture && signals.crossSubsystem && signals.requestedOutcomes >= 2) return "VERY_COMPLEX";
	if (signals.migration && signals.crossSubsystem && signals.likelyFiles >= 4) return "VERY_COMPLEX";
	if (score >= 9.5) return "VERY_COMPLEX";
	if (score >= 5.4) return "COMPLEX";
	if (score >= 2.0) return "NORMAL";
	return "SIMPLE";
}

function ensureSaferClassification(
	complexity: TaskComplexity,
	confidence: number,
	signals: TaskClassifierSignals,
): TaskComplexity {
	if (confidence < 0.58 && complexity === "SIMPLE") return "NORMAL";
	if (confidence < 0.48 && complexity === "NORMAL" && (signals.debugging || signals.crossSubsystem)) return "COMPLEX";
	return complexity;
}

function workflowForComplexity(complexity: TaskComplexity): TaskWorkflowPolicy {
	switch (complexity) {
		case "SIMPLE":
			return {
				inspect: true,
				plan: false,
				explore: false,
				architecture: false,
				specialistResearch: false,
				verification: "basic",
				reviewPasses: 0,
				maxEscalations: 1,
				reasoningDepth: "minimal",
			};
		case "NORMAL":
			return {
				inspect: true,
				plan: true,
				explore: false,
				architecture: false,
				specialistResearch: false,
				verification: "standard",
				reviewPasses: 1,
				maxEscalations: 2,
				reasoningDepth: "low",
			};
		case "COMPLEX":
			return {
				inspect: true,
				plan: true,
				explore: true,
				architecture: true,
				specialistResearch: false,
				verification: "deep",
				reviewPasses: 1,
				maxEscalations: 2,
				reasoningDepth: "high",
			};
		case "VERY_COMPLEX":
			return {
				inspect: true,
				plan: true,
				explore: true,
				architecture: true,
				specialistResearch: true,
				verification: "final",
				reviewPasses: 2,
				maxEscalations: 3,
				reasoningDepth: "maximum",
			};
	}
}

function confidenceFor(score: number, signals: TaskClassifierSignals, complexity: TaskComplexity): number {
	let confidence = 0.72;
	if (signals.uncertain) confidence -= 0.16;
	if (signals.requestedOutcomes >= 3) confidence += 0.04;
	if (signals.likelyFiles >= 4) confidence += 0.04;
	if (signals.architecture || signals.migration || signals.crossSubsystem) confidence += 0.04;
	if (complexity === "SIMPLE" && (signals.debugging || signals.bugFix)) confidence -= 0.1;
	if (score >= 9.5 || score <= 0.7) confidence += 0.04;
	return Math.max(0.35, Math.min(0.97, confidence));
}

function buildReasons(signals: TaskClassifierSignals, repository?: TaskRepositorySignals): string[] {
	const reasons: string[] = [];
	if (signals.requestedOutcomes > 1) reasons.push(`${signals.requestedOutcomes} requested outcomes`);
	if (signals.likelyFiles > 1) reasons.push(`likely touches ~${signals.likelyFiles} files`);
	if (signals.bugFix) reasons.push("bug/fix request");
	if (signals.debugging) reasons.push("debugging or reproduction required");
	if (signals.architecture) reasons.push("architecture decision/rework");
	if (signals.newFeature) reasons.push("new feature/change");
	if (signals.refactor) reasons.push("refactor/restructure");
	if (signals.migration) reasons.push("migration/schema work");
	if (signals.explicitTests) reasons.push("tests explicitly requested");
	if (signals.externalResearch) reasons.push("external research signal");
	if (signals.crossSubsystem) reasons.push("cross-subsystem scope");
	if (signals.uncertain) reasons.push("uncertainty signal");
	if (repository?.framework) reasons.push(`repository framework hint: ${repository.framework}`);
	return reasons.length > 0 ? reasons : ["low-complexity single-outcome task"];
}

export function classifyTask(text: string, repository?: TaskRepositorySignals): TaskClassification {
	const normalized = normalizeText(text);
	const signals: TaskClassifierSignals = {
		requestedOutcomes: estimateOutcomes(normalized),
		likelyFiles: estimateLikelyFiles(normalized, repository),
		bugFix: matchesAny(normalized, BUG_PATTERNS),
		debugging: matchesAny(normalized, DEBUG_PATTERNS),
		architecture: matchesAny(normalized, ARCHITECTURE_PATTERNS),
		newFeature: matchesAny(normalized, FEATURE_PATTERNS),
		refactor: matchesAny(normalized, REFACTOR_PATTERNS),
		migration: matchesAny(normalized, MIGRATION_PATTERNS),
		explicitTests: matchesAny(normalized, TEST_PATTERNS),
		externalResearch: matchesAny(normalized, RESEARCH_PATTERNS),
		crossSubsystem: matchesAny(normalized, CROSS_SUBSYSTEM_PATTERNS) || repository?.crossesSubsystems === true,
		uncertain: repository?.knownUncertainty === true || /\b(maybe|unclear|not sure|figure out|mystery)\b/i.test(normalized),
	};

	const simpleSignalCount = countMatches(normalized, SIMPLE_PATTERNS);
	const score = baseScore(signals, repository) - (simpleSignalCount >= 1 ? 1.6 : 0);
	let complexity = complexityFromScore(score, signals);
	if (simpleSignalCount >= 1 && signals.requestedOutcomes === 1 && !signals.debugging && !signals.refactor && !signals.migration && !signals.crossSubsystem && !signals.architecture) {
		complexity = "SIMPLE";
	}
	if (signals.requestedOutcomes >= 4 && complexity === "NORMAL") complexity = "COMPLEX";
	const rawConfidence = confidenceFor(score, signals, complexity);
	complexity = ensureSaferClassification(complexity, rawConfidence, signals);
	const confidence = complexity === "SIMPLE" && rawConfidence < 0.58 ? 0.61 : rawConfidence;

	return {
		complexity,
		confidence,
		score,
		reasons: buildReasons(signals, repository),
		signals,
		workflow: workflowForComplexity(complexity),
	};
}

function nextComplexity(complexity: TaskComplexity): TaskComplexity {
	const index = TASK_COMPLEXITIES.indexOf(complexity);
	return TASK_COMPLEXITIES[Math.min(TASK_COMPLEXITIES.length - 1, index + 1)];
}

export class TaskRouteTracker {
	readonly initial: TaskClassification;
	readonly #escalations: TaskEscalation[] = [];
	#current: TaskClassification;
	#testFailures = 0;
	#repairFailures = 0;
	#verificationFailures = 0;

	constructor(initial: TaskClassification) {
		this.initial = initial;
		this.#current = initial;
	}

	get current(): TaskClassification {
		return this.#current;
	}

	get telemetry(): TaskRoutingTelemetry {
		return {
			initialComplexity: this.initial.complexity,
			initialConfidence: this.initial.confidence,
			selectedWorkflow: this.initial.workflow,
			escalations: this.#escalations.slice(),
			finalComplexity: this.#current.complexity,
			finalWorkflow: this.#current.workflow,
		};
	}

	observe(trigger: TaskEscalationTrigger, reason: string): TaskEscalation | undefined {
		switch (trigger) {
			case "test_failure":
				this.#testFailures++;
				if (this.#testFailures < 2) return undefined;
				break;
			case "repair_failure":
				this.#repairFailures++;
				if (this.#repairFailures < 2) return undefined;
				break;
			case "verification_failure":
				this.#verificationFailures++;
				if (this.#verificationFailures < 2) return undefined;
				break;
			case "unexpected_dependency":
			case "cross_subsystem_discovered":
				break;
		}

		const maxEscalations = this.initial.workflow.maxEscalations;
		if (this.#escalations.length >= maxEscalations) return undefined;
		if (this.#current.complexity === "VERY_COMPLEX") return undefined;

		const from = this.#current.complexity;
		const to = nextComplexity(from);
		if (to === from) return undefined;
		const escalation: TaskEscalation = {
			from,
			to,
			reason,
			trigger,
			timestamp: Date.now(),
		};
		this.#escalations.push(escalation);
		this.#current = {
			...this.#current,
			complexity: to,
			confidence: Math.max(this.#current.confidence, 0.75),
			workflow: workflowForComplexity(to),
			reasons: [...this.#current.reasons, `escalated: ${reason}`],
		};
		return escalation;
	}
}

export function createTaskRoutingBenchmarkRecord(
	telemetry: TaskRoutingTelemetry,
	metrics: Omit<TaskRoutingBenchmarkRecord, "taskComplexity" | "initialConfidence" | "finalComplexity" | "escalationCount"> = {},
): TaskRoutingBenchmarkRecord {
	return {
		taskComplexity: telemetry.initialComplexity,
		initialConfidence: telemetry.initialConfidence,
		finalComplexity: telemetry.finalComplexity,
		escalationCount: telemetry.escalations.length,
		...metrics,
	};
}

export function isTaskFailureMessage(text: string): boolean {
	return /\b(test|verification|build|lint|typecheck|compile)\b.*\b(fail|failed|failure|error|broken)\b/i.test(text);
}

export function inferEscalationTrigger(text: string): TaskEscalationTrigger | undefined {
	if (/\b(unexpected dependency|new dependency|hidden dependency|unanticipated dependency)\b/i.test(text)) return "unexpected_dependency";
	if (/\b(test|tests|test suite)\b.*\b(fail|failed|failure|error)\b/i.test(text)) return "test_failure";
	if (/\b(verify|verification|build|lint|typecheck|compile)\b.*\b(fail|failed|failure|error)\b/i.test(text)) return "verification_failure";
	if (/\b(repair|fix attempt|retry)\b.*\b(fail|failed|failure)\b/i.test(text)) return "repair_failure";
	if (/\b(cross[- ]subsystem|another subsystem|another service|different package)\b/i.test(text)) return "cross_subsystem_discovered";
	return undefined;
}
