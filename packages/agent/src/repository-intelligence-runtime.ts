import { AsyncLocalStorage } from "node:async_hooks";
import type { Effort } from "@oh-my-pi/pi-ai";
import { Agent } from "./agent";
import type { AgentMessage, AgentState } from "./types";
import {
	createRepositoryIntelligence,
	type RepositoryIntelligence,
	type RepositoryIntelligenceTelemetry,
	type RepositoryProfile,
} from "./repository-intelligence";
import { setRepositoryProfileForVerification } from "./verification";
import { classifyTask, withTaskRepositorySignals, type TaskClassification, type TaskRepositorySignals, type TaskComplexity } from "./task-router";

const kPromptPatched = Symbol.for("oh-my-pi-ultra.repository-intelligence.prompt-patched");
const kYieldPatched = Symbol.for("oh-my-pi-ultra.repository-intelligence.yield-patched");
const repositoryByAgent = new WeakMap<Agent, RepositoryRuntime>();
const yieldHooks = new WeakMap<Agent, { primary?: () => Promise<void> | void; extras: Set<() => Promise<void> | void> }>();
const signalStorage = new AsyncLocalStorage<TaskRepositorySignals>();

export interface RepositoryIntelligenceRuntimeState {
	profile?: RepositoryProfile;
	telemetry: RepositoryIntelligenceTelemetry;
	initialTaskClassification: TaskClassification;
	repositorySignals?: TaskRepositorySignals;
}

interface RoutedState extends AgentState {
	repositoryIntelligence?: RepositoryIntelligenceRuntimeState;
}

interface RepositoryRuntime {
	index: RepositoryIntelligence;
	initial: TaskClassification;
	profile?: RepositoryProfile;
	removeContextHook: () => void;
	removeVerificationProfile: () => void;
	removeYieldHook: () => void;
}

function enabled(): boolean {
	return Bun.env.PI_REPOSITORY_INTELLIGENCE !== "0";
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function complexityRank(complexity: TaskComplexity): number {
	return complexity === "SIMPLE" ? 0 : complexity === "NORMAL" ? 1 : complexity === "COMPLEX" ? 2 : 3;
}

function effort(complexity: TaskComplexity): Effort {
	return complexity === "SIMPLE" ? ("minimal" as Effort) : complexity === "NORMAL" ? ("low" as Effort) : complexity === "COMPLEX" ? ("high" as Effort) : ("max" as Effort);
}

function publish(agent: Agent, runtime: RepositoryRuntime, signals?: TaskRepositorySignals): void {
	const state = agent.state as RoutedState;
	state.repositoryIntelligence = {
		profile: runtime.profile,
		telemetry: runtime.index.telemetry,
		initialTaskClassification: runtime.initial,
		repositorySignals: signals,
	};
}

function patchYieldComposition(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown; setOnBeforeYield: (hook?: () => Promise<void> | void) => void };
	if (target[kYieldPatched]) return;
	target[kYieldPatched] = true;
	const original = target.setOnBeforeYield;
	target.setOnBeforeYield = function composedRepositoryYieldHook(this: Agent, primary?: () => Promise<void> | void): void {
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

function addBeforeYieldHook(agent: Agent, hook: () => Promise<void> | void): () => void {
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

function repositoryMessage(facts: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `[Repository Intelligence]\n${facts}` }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function shouldIndex(initial: TaskClassification): boolean {
	const confidenceThreshold = Number.parseFloat(Bun.env.PI_REPOSITORY_CONFIDENCE_THRESHOLD ?? "0.78");
	const threshold = Number.isFinite(confidenceThreshold) ? confidenceThreshold : 0.78;
	return complexityRank(initial.complexity) > 0 || initial.confidence < threshold;
}

async function attach(agent: Agent, task: string): Promise<RepositoryRuntime | undefined> {
	const initial = classifyTask(task);
	if (!shouldIndex(initial)) return undefined;

	const existing = repositoryByAgent.get(agent);
	existing?.removeContextHook();
	existing?.removeVerificationProfile();
	existing?.removeYieldHook();

	const index = createRepositoryIntelligence({
		root: process.cwd(),
		maxIndexedFiles: parsePositiveInteger(Bun.env.PI_REPOSITORY_MAX_FILES) ?? 20_000,
		cache: Bun.env.PI_REPOSITORY_CACHE !== "0",
	});
	const runtime: RepositoryRuntime = {
		index,
		initial,
		removeContextHook: () => {},
		removeVerificationProfile: () => {},
		removeYieldHook: () => {},
	};

	try {
		const profile = await index.refresh("auto");
		runtime.profile = profile;
	} catch (error) {
		const state = agent.state as RoutedState;
		state.repositoryIntelligence = {
			profile: undefined,
			telemetry: { ...index.telemetry, fallbacks: [...index.telemetry.fallbacks, error instanceof Error ? error.message : String(error)] },
			initialTaskClassification: initial,
		};
		repositoryByAgent.set(agent, runtime);
		return runtime;
	}

	const signals = index.getTaskRepositorySignals(task);
	runtime.removeVerificationProfile = setRepositoryProfileForVerification(process.cwd(), profile);
	runtime.removeContextHook = agent.addBeforeModelCall(async context => {
		const complexity = initial.complexity;
		const facts = index.getRelevantFacts(task, complexity);
		if (!facts) return;
		const marker = "[Repository Intelligence]";
		if (context.messages.some(message => {
			const value = (message as unknown as { content?: unknown }).content;
			return typeof value === "string" ? value.startsWith(marker) : Array.isArray(value) && value.some(block => block && typeof block === "object" && "text" in block && String((block as { text: unknown }).text).startsWith(marker));
		})) return;
		context.messages = [repositoryMessage(facts), ...context.messages];
	});

	if (complexityRank(initial.complexity) >= 2) {
		runtime.removeYieldHook = addBeforeYieldHook(agent, async () => {
			if (!runtime.profile) return;
			// Keep the cached map warm for long-running sessions without forcing a
			// full refresh on every turn. A subsequent dirty workspace is refreshed
			// by the next prompt's repository instance.
			publish(agent, runtime, signals);
		});
	}

	publish(agent, runtime, signals);
	repositoryByAgent.set(agent, runtime);
	return runtime;
}

function patch(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown };
	if (target[kPromptPatched]) return;
	target[kPromptPatched] = true;
	patchYieldComposition();
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(target as any).prompt = async function repositoryAwarePrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return original.apply(this, args);
		const task = typeof args[0] === "string" ? args[0].trim() : undefined;
		if (!task) return original.apply(this, args);
		const preliminary = classifyTask(task);
		if (!shouldIndex(preliminary)) return original.apply(this, args);
		const runtime = await attach(this, task);
		if (!runtime?.profile) return original.apply(this, args);
		const signals = runtime.index.getTaskRepositorySignals(task);
		this.setThinkingLevel(this.state.thinkingLevel === undefined ? effort(signals.crossesSubsystems ? "COMPLEX" : preliminary.complexity) : this.state.thinkingLevel);
		try {
			return await signalStorage.run(signals, () => original.apply(this, args));
		} finally {
			publish(this, runtime, signals);
			runtime.removeContextHook();
			runtime.removeVerificationProfile();
			runtime.removeYieldHook();
			repositoryByAgent.delete(this);
		}
	};
}

patch();

export function getTaskRepositorySignals(): TaskRepositorySignals | undefined {
	return signalStorage.getStore();
}

export function getRepositoryIntelligence(agent: Agent): RepositoryIntelligenceRuntimeState | undefined {
	return (agent.state as RoutedState).repositoryIntelligence;
}
