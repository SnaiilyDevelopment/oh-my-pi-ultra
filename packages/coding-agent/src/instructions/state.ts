import type { Agent, ModelCapabilities, OrchestrationState, TaskClassification } from "@oh-my-pi/pi-agent-core";
import { deriveModelCapabilities } from "@oh-my-pi/pi-agent-core";
import type { InstructionModelState, InstructionState, SpecialistInstructionRole } from "./types";

const ROLES = ["EXPLORER", "ARCHITECT", "DEBUGGER", "TEST_ENGINEER", "REVIEWER", "SECURITY_REVIEWER", "RESEARCHER"] as const;

export function modelInstructionState(capabilities: ModelCapabilities | undefined): InstructionModelState | undefined {
	if (!capabilities) return undefined;
	const known = (value: boolean | undefined): "supported" | "unsupported" | "unknown" => value === undefined ? "unknown" : value ? "supported" : "unsupported";
	return {
		structuredOutput: known(capabilities.structuredOutput),
		toolCalling: known(capabilities.toolCalling),
		parallelToolCalls: known(capabilities.parallelToolCalls),
		promptCaching: known(capabilities.promptCaching),
	};
}

export function specialistRoleFromState(value: unknown): SpecialistInstructionRole | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.toUpperCase() as SpecialistInstructionRole;
	return ROLES.includes(normalized as (typeof ROLES)[number]) ? normalized : undefined;
}

export function instructionStateFromAgent(agent: Agent, classification?: TaskClassification): InstructionState {
	const state = agent.state as typeof agent.state & { orchestration?: OrchestrationState; specialistRole?: unknown };
	const orchestration = state.orchestration;
	const task = classification ? {
		complexity: classification.complexity,
		workflow: classification.workflow,
		kind: classification.signals.debugging ? ("debugging" as const) : classification.signals.architecture ? ("architecture" as const) : classification.signals.refactor ? ("refactoring" as const) : classification.complexity === "SIMPLE" ? ("simple" as const) : classification.complexity === "VERY_COMPLEX" ? ("complex" as const) : ("normal" as const),
	} : undefined;
	return {
		task,
		phase: orchestration?.currentPhase,
		lastAction: orchestration?.lastAction,
		objective: orchestration?.currentObjective,
		failure: orchestration?.failure?.present ? {
			present: true,
			category: orchestration.failure.category,
			check: orchestration.failure.check,
			summary: orchestration.failure.summary,
			repeatCount: orchestration.failure.repeatCount,
		} : undefined,
		verification: orchestration?.verification ? {
			state: orchestration.verification.state,
			failureCategory: orchestration.verification.failureCategory,
			checksSelected: orchestration.verification.checksSelected,
			checksPassed: orchestration.verification.checksPassed,
			checksFailed: orchestration.verification.checksFailed,
		} : undefined,
		contextPressure: orchestration?.context?.pressure,
		model: modelInstructionState(orchestration?.modelCapabilities ?? deriveModelCapabilities(agent.state.model)),
		toolNames: agent.state.tools.map(tool => tool.name),
		specialistRole: specialistRoleFromState(state.specialistRole),
	};
}
