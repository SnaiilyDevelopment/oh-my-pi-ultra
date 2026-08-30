import type { InstructionLayer, InstructionPhase, InstructionState } from "./types";

const PHASE_TEXT: Record<InstructionPhase, string> = {
	UNDERSTAND: ["Identify the task and the minimum relevant evidence.", "Do not modify code merely to explore."].join("\n"),
	PLAN: ["Define the implementation approach and key risks.", "Keep the plan proportional to task complexity."].join("\n"),
	IMPLEMENT: ["Modify only relevant code.", "Follow existing patterns and avoid unrelated cleanup."].join("\n"),
	VERIFY: ["Treat verification evidence as authoritative.", "Do not claim success without a meaningful check."].join("\n"),
	RECOVER: ["Use the failure evidence and previous attempts.", "Choose the next action from new evidence, not repetition."].join("\n"),
	REVIEW: ["Check requirements, changed scope, and verification evidence.", "Look for regressions and unintended changes."].join("\n"),
	COMPLETE: ["Report only the status supported by evidence.", "State unresolved blockers explicitly; do not fabricate validation."].join("\n"),
	BLOCKED: ["State the missing external prerequisite precisely.", "Finish reachable work and do not pretend the task is verified."].join("\n"),
};

export function phaseInstructionLayer(state: InstructionState): InstructionLayer | undefined {
	if (!state.phase) return undefined;
	const objective = state.objective?.trim();
	const text = objective ? `${PHASE_TEXT[state.phase]}\nObjective: ${objective}` : PHASE_TEXT[state.phase];
	return { name: "phase", priority: "core", text };
}
