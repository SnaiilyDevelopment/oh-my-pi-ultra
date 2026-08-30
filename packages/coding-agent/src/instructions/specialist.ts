import type { InstructionLayer, SpecialistInstructionRole } from "./types";

const ROLE_TEXT: Record<SpecialistInstructionRole, string> = {
	EXPLORER: "ROLE: repository explorer\nOBJECTIVE: identify relevant structure, dependencies, and unknowns without editing.",
	ARCHITECT: "ROLE: architecture specialist\nOBJECTIVE: compare viable design paths, constraints, tradeoffs, and risks without editing.",
	DEBUGGER: "ROLE: debugger\nOBJECTIVE: determine the evidence-backed root cause and recommended repair without editing.",
	TEST_ENGINEER: "ROLE: test engineer\nOBJECTIVE: identify the highest-value verification surface and missing coverage without editing.",
	REVIEWER: "ROLE: reviewer\nOBJECTIVE: identify correctness, scope, and regression risks without editing.",
	SECURITY_REVIEWER: "ROLE: security reviewer\nOBJECTIVE: identify concrete security risks, affected locations, and mitigations without editing.",
	RESEARCHER: "ROLE: researcher\nOBJECTIVE: answer only the named external question and distinguish evidence from uncertainty.",
};

export function specialistInstructionLayer(role?: SpecialistInstructionRole): InstructionLayer | undefined {
	if (!role) return undefined;
	return {
		name: "specialist",
		priority: "core",
		text: `${ROLE_TEXT[role]}\nRETURN: concise findings, evidence, confidence, and the recommended next action.`,
	};
}
