import type { Agent, ModelCapabilities, OrchestrationState, TaskClassification } from "@oh-my-pi/pi-agent-core";
import { deriveModelCapabilities } from "@oh-my-pi/pi-agent-core";
import { researchDecision } from "../research/policy";
import type { InstructionModelState, InstructionState, ResearchInstructionDecision, SpecialistInstructionRole } from "./types";

const ROLES = ["EXPLORER", "ARCHITECT", "DEBUGGER", "TEST_ENGINEER", "REVIEWER", "SECURITY_REVIEWER", "RESEARCHER"] as const;

export function modelInstructionState(capabilities: ModelCapabilities | undefined): InstructionModelState | undefined {
	if (!capabilities) return undefined;
	const known = (value: boolean | undefined): "supported" | "unsupported" | "unknown" => value === undefined ? "unknown" : value ? "supported" : "unsupported";
	return {
		structuredOutput: known(capabilities.structuredOutput === "supported" ? true : capabilities.structuredOutput === "unsupported" ? false : undefined),
		toolCalling: known(capabilities.toolCalling === "supported" ? true : capabilities.toolCalling === "unsupported" ? false : undefined),
		parallelToolCalls: known(capabilities.parallelToolCalls === "supported" ? true : capabilities.parallelToolCalls === "unsupported" ? false : undefined),
		promptCaching: known(capabilities.promptCaching === "supported" ? true : capabilities.promptCaching === "unsupported" ? false : undefined),
	};
}

export function specialistRoleFromState(value: unknown): SpecialistInstructionRole | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.toUpperCase() as SpecialistInstructionRole;
	return ROLES.includes(normalized as (typeof ROLES)[number]) ? normalized : undefined;
}

function userTaskText(agent: Agent): string {
	return agent.state.messages
		.filter(message => message.role === "user")
		.map(message => typeof message.content === "string" ? message.content : "")
		.filter(Boolean)
		.join("\n");
}

export function instructionStateFromAgent(agent: Agent, classification?: TaskClassification): InstructionState {
	const state = agent.state as typeof agent.state & {
		orchestration?: OrchestrationState;
		specialistOrchestration?: { activeRoles?: unknown[] };
	};
	const orchestration = state.orchestration;
	const task = classification ? {
		complexity: classification.complexity,
		workflow: classification.workflow,
		kind: classification.signals.debugging ? ("debugging" as const) : classification.signals.architecture ? ("architecture" as const) : classification.signals.refactor ? ("refactoring" as const) : classification.complexity === "SIMPLE" ? ("simple" as const) : classification.complexity === "VERY_COMPLEX" ? ("complex" as const) : ("normal" as const),
	} : undefined;
	const taskText = orchestration?.task ?? userTaskText(agent);
	const research: ResearchInstructionDecision = taskText ? researchDecision(taskText, classification, undefined, orchestration) : "NO_RESEARCH";
	const untrustedContentPresent = agent.state.messages.some(message => typeof message.content === "string" && message.content.includes("[UNTRUSTED EXTERNAL CONTENT]"));
	return {
		task,
		phase: orchestration?.currentPhase,
		lastAction: orchestration?.lastAction,
		objective: orchestration?.currentObjective,
		failure: orchestration?.failure?.present ? { present: true, category: orchestration.failure.category, check: orchestration.failure.check, summary: orchestration.failure.summary, repeatCount: orchestration.failure.repeatCount } : undefined,
		verification: orchestration?.verification ? { state: orchestration.verification.state, failureCategory: orchestration.verification.failureCategory, checksSelected: orchestration.verification.checksSelected, checksPassed: orchestration.verification.checksPassed, checksFailed: orchestration.verification.checksFailed } : undefined,
		contextPressure: orchestration?.context?.pressure,
		model: modelInstructionState(orchestration?.modelCapabilities ?? deriveModelCapabilities(agent.state.model)),
		toolNames: agent.state.tools.map(tool => tool.name),
		specialistRole: specialistRoleFromState(state.specialistOrchestration?.activeRoles?.[0]),
		researchDecision: research,
		untrustedContentPresent,
	};
}
