import type { OrchestrationState, TaskClassification } from "@oh-my-pi/pi-agent-core";
import { deriveModelCapabilities, type ModelCapabilities } from "@oh-my-pi/pi-agent-core";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { InstructionModelState, InstructionState, SpecialistInstructionRole } from "./types";

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
	return ["EXPLORER", "ARCHITECT", "DEBUGGER", "TEST_ENGINEER", "REVIEWER", "SECURITY_REVIEWER", "RESEARCHER"].includes(normalized) ? normalized : undefined;
}

export function instructionStateFromAgent(
	agent: Agent,
	classification: TaskClassification | undefined,
): InstructionState {
	const state = agent.state as typeof agent.state & { orchestration?: OrchestrationState; specialistRole?: unknown };
	const orchestration = state.orchestration;
	const failure = orchestration?.failureEvidence;
	const verification = orchestration?.verificationEvidence;
	const task = classification ? {
		complexity: classification.complexity,
		workflow: classification.workflow,
		kind: classification.signals.debugging ? "debugging" as const : classification.signals.architecture ? "architecture" as const : classification.signals.refactor ? "refactoring" as const : classification.complexity === "SIMPLE" ? "simple" as const : classification.complexity === "VERY_COMPLEX" ? "complex" as const : "normal" as const,
	} : undefined;
	return {
		task,
		phase: orchestration?.currentPhase as InstructionState["phase"],
		lastAction: orchestration?.lastAction,
		objective: orchestration?.currentObjective,
		failure: failure ? {
			present: true,
			category: failure.category,
			check: failure.check,
			summary: failure.summary,
			repeatCount: failure.repeatCount,
		} : undefined,
		verification: verification ? {
			state: verification.state,
			failureCategory: verification.failureCategory,
			checksSelected: verification.checksSelected,
			checksPassed: verification.checksPassed,
			checksFailed: verification.checksFailed,
		} : undefined,
		model: modelInstructionState(agent.state.model ? deriveModelCapabilities(agent.state.model) : undefined),
		toolNames: agent.state.tools.map(tool => tool.name),
		specialistRole: specialistRoleFromState(state.specialistRole),
	};
}
