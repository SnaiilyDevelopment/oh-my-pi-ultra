import { ptree, getAgentDir } from "@oh-my-pi/pi-utils";
import {
	Agent,
	applyDecision,
	classifyTask,
	createModelCapabilityTelemetry,
	currentCapabilityProfile,
	decideNextAction,
	orchestrationStateFrom,
	type AgentMessage,
	type OrchestrationDecision,
	type OrchestrationState,
} from "@oh-my-pi/pi-agent-core";
import { getRepositoryIntelligence, getVerification, getTaskRouting, getContextIntelligence } from "@oh-my-pi/pi-agent-core";
import { getProjectMemoryTelemetry } from "./memories/project-memory-runtime";

const kPatched = Symbol.for("oh-my-pi-ultra.orchestration.patched");
const kYieldPatched = Symbol.for("oh-my-pi-ultra.orchestration.yield-composer");
const byAgent = new WeakMap<Agent, Runtime>();

type YieldHook = () => Promise<void> | void;
const yieldHooks = new WeakMap<Agent, { primary?: YieldHook; extras: Set<YieldHook> }>();

interface OrchestrationAgentState {
	orchestration?: OrchestrationState;
}

interface Runtime {
	state: OrchestrationState;
	startedAt: number;
	lastDecision?: OrchestrationDecision;
	lastDirectiveFingerprint?: string;
	reviewRequested: boolean;
	lastToolNames: string[];
	lastToolCount: number;
	lastToolFailures: number;
	removeHook: () => void;
	removeYieldHook: () => void;
	unsubscribe: () => void;
}

function enabled(): boolean {
	return process.env.PI_ORCHESTRATION !== "0";
}

function taskFromInput(input: unknown): string | undefined {
	if (typeof input === "string") return input.trim() || undefined;
	if (!Array.isArray(input)) return undefined;
	const text = input
		.filter(item => item && typeof item === "object" && (item as { role?: string }).role === "user")
		.map(item => {
			const content = (item as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content.map(block => block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : "").join(" ");
		})
		.join(" ")
		.trim();
	return text || undefined;
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map(item => item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : "").join(" ");
}

function extractToolNames(agent: Agent): string[] {
	const names: string[] = [];
	for (const message of agent.state.messages) {
		const content = (message as unknown as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const value = block as { type?: string; name?: unknown };
			if (value.type === "toolCall" && typeof value.name === "string") names.push(value.name);
		}
	}
	return names.slice(-12);
}

function changedFilesFromVerification(agent: Agent): string[] {
	const verification = getVerification(agent) as unknown as { plan?: { changedFiles?: unknown } } | undefined;
	return Array.isArray(verification?.plan?.changedFiles)
		? verification.plan.changedFiles.filter((item): item is string => typeof item === "string").slice(0, 32)
		: [];
}

function mapVerification(agent: Agent): OrchestrationState["verification"] {
	const verification = getVerification(agent) as unknown as {
		finalState?: string;
		failureCategory?: string;
		lastFailure?: { check?: string; category?: string; summary?: string };
		checksSelected?: number;
		checksPassed?: number;
		checksFailed?: number;
		workspaceChanged?: boolean;
	} | undefined;
	if (!verification) return { state: "PENDING", workspaceChanged: false };
	const raw = verification.finalState;
	const state = raw === "VERIFIED_SUCCESS" || raw === "VERIFIED" ? "VERIFIED" : raw === "BLOCKED" ? "BLOCKED" : raw === "FAILED" ? "FAILED" : raw === "UNVERIFIED" ? "UNVERIFIED" : "PENDING";
	return {
		state,
		failureCategory: verification.failureCategory ?? verification.lastFailure?.category,
		failureCheck: verification.lastFailure?.check,
		checksSelected: verification.checksSelected,
		checksPassed: verification.checksPassed,
		checksFailed: verification.checksFailed,
		workspaceChanged: verification.workspaceChanged === true,
		blocked: state === "BLOCKED",
	};
}

function syncStateFromSubsystems(agent: Agent, runtime: Runtime): void {
	const state = runtime.state;
	const routing = getTaskRouting(agent) as unknown as { finalComplexity?: OrchestrationState["complexity"] } | undefined;
	const repository = getRepositoryIntelligence(agent) as unknown as {
		profile?: { repositorySize?: string; relevantFileCount?: number; subsystemCount?: number };
		repositorySignals?: { relevantFileCount?: number; crossesSubsystems?: boolean };
	} | undefined;
	const context = getContextIntelligence(agent) as unknown as {
		estimatedTokensBefore?: number;
		estimatedTokensAfter?: number;
		contextBudget?: number;
	} | undefined;
	const memory = getProjectMemoryTelemetry(agent) as unknown as { retrieved?: number; memoryContextTokens?: number; degraded?: boolean } | undefined;
	const capabilities = currentCapabilityProfile(agent);
	const strategy = createModelCapabilityTelemetry(agent.state.model, classifyTask(state.task)).strategy;

	if (routing?.finalComplexity) state.complexity = routing.finalComplexity;
	state.repository = {
		available: Boolean(repository?.profile),
		fresh: Boolean(repository?.profile),
		changed: false,
		relevantFileCount: repository?.repositorySignals?.relevantFileCount ?? repository?.profile?.relevantFileCount,
		crossesSubsystems: repository?.repositorySignals?.crossesSubsystems,
	};
	state.context = {
		available: Boolean(context),
		estimatedTokens: context?.estimatedTokensAfter ?? context?.estimatedTokensBefore,
		budgetTokens: context?.contextBudget,
		pressure: context?.estimatedTokensBefore && context?.contextBudget ? Math.min(1, context.estimatedTokensBefore / context.contextBudget) : undefined,
	};
	state.memory = {
		retrieved: memory?.retrieved ?? 0,
		contextTokens: memory?.memoryContextTokens ?? 0,
		degraded: memory?.degraded === true,
	};
	state.modelCapabilities = capabilities;
	state.modelStrategy = strategy;
	state.changedFiles = changedFilesFromVerification(agent);
	state.verification = mapVerification(agent);
	state.tools.lastTools = runtime.lastToolNames;
	state.tools.calls = runtime.lastToolCount;
	state.tools.failures = runtime.lastToolFailures;
	state.tools.parallelSupported = strategy.allowParallelTools;
}

function directiveFor(decisionResult: OrchestrationDecision): string | undefined {
	switch (decisionResult.action) {
		case "DISCOVER": return "[Orchestration] Use the existing repository intelligence/query surfaces first. Avoid broad duplicate exploration.";
		case "PLAN": return "[Orchestration] Plan before implementation: identify constraints, affected scope, and the smallest reliable change. Do not produce a large plan.";
		case "IMPLEMENT": return undefined;
		case "VERIFY": return "[Orchestration] Treat verification as the completion gate. Use the smallest relevant checks and preserve failure evidence.";
		case "DIAGNOSE": return "[Orchestration] Diagnose the concrete failure before changing code. Preserve affected files, failure evidence, and the previous strategy.";
		case "REPAIR": return "[Orchestration] Perform a targeted repair using a meaningfully different strategy from prior failed attempts.";
		case "REVIEW": return "[Orchestration] Review changed scope, task requirements, and verification evidence. Look for regressions or unexpected changes.";
		case "COMPACT": return "[Orchestration] Context pressure is high. Preserve task constraints, decisions, active files, failures, and next action before continuing.";
		case "REFRESH_CONTEXT": return "[Orchestration] The current strategy is repeating. Refresh the targeted context and change the hypothesis before retrying.";
		case "REFRESH_REPOSITORY": return "[Orchestration] Repository state changed. Re-check current repository intelligence before relying on prior structural assumptions.";
		case "ESCALATE": return "[Orchestration] Escalate deliberately: increase investigation/reasoning only as justified by the failure evidence; do not repeat the same strategy.";
		case "COMPLETE":
		case "BLOCK": return undefined;
	}
}

function reviewMessage(): AgentMessage {
	return {
		role: "user",
		content: "[Orchestration review] Verification passed. Before yielding, perform one bounded review of the implemented scope, diff, task requirements, and any relevant regression signals. Do not make unrelated changes.",
		timestamp: Date.now(),
	} as AgentMessage;
}

function patchYieldComposition(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown; setOnBeforeYield: (hook?: YieldHook) => void };
	if (target[kYieldPatched]) return;
	target[kYieldPatched] = true;
	const original = target.setOnBeforeYield;
	target.setOnBeforeYield = function composedOrchestrationYieldHook(this: Agent, primary?: YieldHook): void {
		let record = yieldHooks.get(this);
		if (!record) {
			record = { extras: new Set() };
			yieldHooks.set(this, record);
		}
		record.primary = primary;
		const extras = record.extras;
		const combined = record.primary || extras.size > 0
			? async () => {
				if (record?.primary) await record.primary();
				for (const hook of extras) await hook();
			}
			: undefined;
		original.call(this, combined);
	};
}

function addBeforeYieldHook(agent: Agent, hook: YieldHook): () => void {
	patchYieldComposition();
	let record = yieldHooks.get(agent);
	if (!record) {
		record = { extras: new Set() };
		yieldHooks.set(agent, record);
	}
	record.extras.add(hook);
	agent.setOnBeforeYield(record.primary);
	return () => {
		const current = yieldHooks.get(agent);
		if (!current) return;
		current.extras.delete(hook);
		agent.setOnBeforeYield(current.primary);
		if (!current.primary && current.extras.size === 0) yieldHooks.delete(agent);
	};
}

function decideAndPublish(agent: Agent, runtime: Runtime): void {
	syncStateFromSubsystems(agent, runtime);
	const decisionResult = decideNextAction(runtime.state);
	runtime.lastDecision = decisionResult;
	applyDecision(runtime.state, decisionResult);
	const fingerprint = decisionResult.strategyFingerprint;
	if (runtime.lastDirectiveFingerprint === fingerprint) {
		(agent.state as OrchestrationAgentState).orchestration = runtime.state;
		return;
	}
	runtime.lastDirectiveFingerprint = fingerprint;
	const directive = directiveFor(decisionResult);
	if (directive) {
		agent.appendMessage({ role: "user", content: directive, timestamp: Date.now() } as AgentMessage);
	}
	(agent.state as OrchestrationAgentState).orchestration = runtime.state;
}

async function attach(agent: Agent, task: string): Promise<Runtime> {
	const previous = byAgent.get(agent);
	previous?.unsubscribe();
	previous?.removeHook();
	previous?.removeYieldHook();

	const classification = classifyTask(task);
	const modelTelemetry = createModelCapabilityTelemetry(agent.state.model, classification);
	const state = orchestrationStateFrom(task, classification, modelTelemetry.strategy, modelTelemetry.profile);
	const runtime: Runtime = {
		state,
		startedAt: performance.now(),
		reviewRequested: false,
		lastToolNames: [],
		lastToolCount: 0,
		lastToolFailures: 0,
		removeHook: () => {},
		removeYieldHook: () => {},
		unsubscribe: () => {},
	};

	runtime.unsubscribe = agent.subscribe(event => {
		if (event.type === "turn_end") {
			const results = event.toolResults as Array<{ content: unknown; isError?: boolean }>;
			runtime.lastToolCount += results.length;
			runtime.lastToolFailures += results.filter(item => item.isError === true).length;
			runtime.lastToolNames = extractToolNames(agent);
			if (results.some(item => item.isError === true)) {
				runtime.state.failure.present = true;
				runtime.state.failure.repeatCount += 1;
				runtime.state.failure.summary = textOf(results.find(item => item.isError)?.content).slice(0, 500);
				runtime.state.failure.category = "tool_failure";
			}
			decideAndPublish(agent, runtime);
		}
		if (event.type === "agent_end") {
			decideAndPublish(agent, runtime);
		}
	});

	runtime.removeHook = agent.addBeforeModelCall(async context => {
		decideAndPublish(agent, runtime);
		// Keep orchestration directives cheap: one compact message, never transcript-sized state.
		if (runtime.lastDecision?.contextRequirements.length === 0 && runtime.lastDecision.action === "IMPLEMENT") return;
		void context;
	});

	runtime.removeYieldHook = addBeforeYieldHook(agent, () => {
		syncStateFromSubsystems(agent, runtime);
		const decisionResult = decideNextAction(runtime.state);
		if (
			decisionResult.action === "REVIEW" &&
			runtime.state.verification.state === "VERIFIED" &&
			!runtime.reviewRequested &&
			runtime.state.complexity !== "SIMPLE"
		) {
			runtime.reviewRequested = true;
			runtime.state.currentPhase = "REVIEW";
			runtime.state.currentObjective = "Review changed scope and regression risk before completion.";
			runtime.lastDecision = decisionResult;
			agent.followUp(reviewMessage());
		}
		(agent.state as OrchestrationAgentState).orchestration = runtime.state;
	});

	byAgent.set(agent, runtime);
	decideAndPublish(agent, runtime);
	return runtime;
}

function patch(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown };
	if (target[kPatched]) return;
	target[kPatched] = true;
	patchYieldComposition();
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(target as any).prompt = async function orchestratedPrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return original.apply(this, args);
		const task = taskFromInput(args[0]);
		if (!task) return original.apply(this, args);
		const runtime = await attach(this, task);
		try {
			return await original.apply(this, args);
		} finally {
			const elapsed = performance.now() - runtime.startedAt;
			(runtime.state as OrchestrationState & { durationMs?: number }).durationMs = elapsed;
			decideAndPublish(this, runtime);
			try { runtime.removeHook(); } catch {}
			try { runtime.removeYieldHook(); } catch {}
			runtime.unsubscribe();
			byAgent.delete(this);
		}
	};
}

patch();

export function getOrchestrationState(agent: Agent): OrchestrationState | undefined {
	return (agent.state as OrchestrationAgentState).orchestration;
}

export function getOrchestrationDecision(agent: Agent): OrchestrationDecision | undefined {
	const runtime = byAgent.get(agent);
	return runtime?.lastDecision;
}
