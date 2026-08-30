import type { OrchestrationState, TaskClassification } from "@oh-my-pi/pi-agent-core";
import { classifyTask } from "@oh-my-pi/pi-agent-core";
import { buildResearchObjective, researchDecision } from "./policy";
import type { ResearchDecision, ResearchLocalEvidence, ResearchObjective } from "./types";

/** Task 08 adapter: decide whether the live orchestration state needs external evidence. */
export function researchDecisionForOrchestration(state: OrchestrationState, local?: ResearchLocalEvidence): ResearchDecision {
	const classification = classifyTask(state.task);
	return researchDecision(state.task, classification, local, state);
}

/** Build the bounded objective used when Task 08 escalates to external research. */
export function researchObjectiveForOrchestration(state: OrchestrationState, local?: ResearchLocalEvidence): ResearchObjective | undefined {
	const classification: TaskClassification = classifyTask(state.task);
	const decision = researchDecision(state.task, classification, local, state);
	return decision === "NO_RESEARCH" || decision === "BLOCKED" ? undefined : buildResearchObjective(state.task, decision, local);
}
