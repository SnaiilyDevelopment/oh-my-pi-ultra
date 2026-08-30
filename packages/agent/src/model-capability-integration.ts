import type { Agent } from "./agent";
import type { ModelCapabilityTelemetry, StrategyProfile } from "./model-capability";
import type { AgentState } from "./types";

export interface ModelCapabilityState extends AgentState {
	modelCapabilities?: ModelCapabilityTelemetry;
}

export function publishModelCapability(agent: Agent, telemetry: ModelCapabilityTelemetry): void {
	(agent.state as ModelCapabilityState).modelCapabilities = {
		...telemetry,
		profile: { ...telemetry.profile, reasoningLevels: [...telemetry.profile.reasoningLevels] },
		strategy: { ...telemetry.strategy, reasons: [...telemetry.strategy.reasons] },
		evidence: { ...telemetry.evidence },
	};
}

export function getModelCapabilities(agent: Agent): ModelCapabilityTelemetry | undefined {
	return (agent.state as ModelCapabilityState).modelCapabilities;
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
