import type { InstructionLayer, InstructionState } from "./types";

export function recoveryInstructionLayer(state: InstructionState): InstructionLayer | undefined {
	const failure = state.failure;
	const verification = state.verification;
	const repeat = failure?.repeatCount ?? 0;
	if (failure?.present) {
		const lines = ["Previous attempt failed; use fresh evidence before changing strategy."];
		if (failure.category) lines.push(`Failure category: ${failure.category}.`);
		if (failure.check) lines.push(`Failed check: ${failure.check}.`);
		if (repeat > 0) lines.push(`Repeated failure count: ${repeat}.`);
		if (failure.summary) lines.push(`Current failure evidence: ${failure.summary.slice(0, 500)}.`);
		if (state.phase === "RECOVER") {
			if (state.lastAction === "REPAIR") lines.push("Make a targeted correction; do not restart the whole task.");
			else lines.push("Diagnose the likely root cause before repairing it.");
		}
		return { name: "recovery", priority: "critical", text: lines.join("\n") };
	}
	if (verification?.state === "BLOCKED") return { name: "recovery", priority: "critical", text: "Verification is blocked. Identify the external prerequisite before claiming completion." };
	if (verification?.state === "FAILED") return { name: "recovery", priority: "critical", text: "Verification failed. Use the reported evidence to diagnose and repair; do not declare success." };
	if (state.phase === "COMPLETE") return { name: "recovery", priority: "critical", text: "Completion is evidence-gated. Report only verified status and unresolved blockers." };
	return undefined;
}
