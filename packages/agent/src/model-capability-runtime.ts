import { Agent } from "./agent";
import type { AgentState } from "./types";
import { classifyTask } from "./task-router";
import {
	createModelCapabilityTelemetry,
	createStrategyProfile,
	deriveModelCapabilities,
	type ModelCapabilityTelemetry,
	type StrategyProfile,
} from "./model-capability";

const kPatched = Symbol.for("oh-my-pi-ultra.model-capability.patched");
const byAgent = new WeakMap<Agent, { telemetry: ModelCapabilityTelemetry; previousThinking: AgentState["thinkingLevel"]; autoThinking: boolean }>();

interface CapabilityState extends AgentState {
	modelCapabilities?: ModelCapabilityTelemetry;
}

function enabled(): boolean {
	return process.env.PI_MODEL_CAPABILITIES !== "0";
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

function selectReasoningLevel(strategy: StrategyProfile): AgentState["thinkingLevel"] {
	return strategy.reasoningMode === "off" || strategy.reasoningMode === "default" ? undefined : strategy.reasoningMode;
}

function publish(agent: Agent, telemetry: ModelCapabilityTelemetry): void {
	(agent.state as CapabilityState).modelCapabilities = {
		...telemetry,
		profile: { ...telemetry.profile, reasoningLevels: [...telemetry.profile.reasoningLevels] },
		strategy: { ...telemetry.strategy, reasons: [...telemetry.strategy.reasons] },
		evidence: { ...telemetry.evidence },
	};
}

function patch(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown };
	if (target[kPatched]) return;
	target[kPatched] = true;
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(target as any).prompt = async function capabilityAwarePrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return original.apply(this, args);
		const task = taskFromInput(args[0]);
		if (!task) return original.apply(this, args);

		const classification = classifyTask(task);
		const before = this.state.thinkingLevel;
		const telemetry = createModelCapabilityTelemetry(this.state.model, classification);
		const desired = selectReasoningLevel(telemetry.strategy);
		const autoThinking = before === undefined && desired !== undefined;

		byAgent.set(this, { telemetry, previousThinking: before, autoThinking });
		publish(this, telemetry);
		if (autoThinking) this.setThinkingLevel(desired);

		try {
			return await original.apply(this, args);
		} finally {
			const runtime = byAgent.get(this);
			if (runtime) {
				publish(this, runtime.telemetry);
				if (runtime.autoThinking) this.setThinkingLevel(runtime.previousThinking);
				byAgent.delete(this);
			}
		}
	};
}

patch();

export function getModelCapabilities(agent: Agent): ModelCapabilityTelemetry | undefined {
	return (agent.state as CapabilityState).modelCapabilities;
}

export function getModelStrategy(agent: Agent): StrategyProfile | undefined {
	return getModelCapabilities(agent)?.strategy;
}

export function shouldUseParallelTools(agent: Agent): boolean {
	return getModelStrategy(agent)?.allowParallelTools === true;
}

export function effectiveVerificationDepth(agent: Agent): "standard" | "deep" | undefined {
	return getModelStrategy(agent)?.verificationDepth;
}

export function currentCapabilityProfile(agent: Agent) {
	return getModelCapabilities(agent)?.profile;
}

// Eagerly exercise the pure derivation path for tooling that imports this module
// without constructing an Agent. It is intentionally side-effect free and uses only
// the already-resolved Model object when called by consumers.
export { deriveModelCapabilities, createStrategyProfile };
