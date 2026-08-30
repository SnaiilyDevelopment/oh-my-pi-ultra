import type { InstructionLayer, InstructionTaskProfile } from "./types";

export function taskKindForProfile(profile: InstructionTaskProfile): Exclude<InstructionTaskProfile["kind"], undefined> {
	if (profile.kind) return profile.kind;
	if (profile.complexity === "SIMPLE") return "simple";
	if (profile.complexity === "VERY_COMPLEX") return "complex";
	return "normal";
}

export function taskInstructionLayer(profile: InstructionTaskProfile): InstructionLayer | undefined {
	const kind = taskKindForProfile(profile);
	const lines: string[] = [];
	switch (kind) {
		case "simple":
			lines.push("Make the requested change only.", "Avoid unrelated edits.", "Run the cheapest meaningful verification.");
			break;
		case "debugging":
			lines.push("Prioritize evidence.", "Do not repeat failed hypotheses without new evidence.", "Preserve reproducibility and verify the root cause.");
			break;
		case "architecture":
			lines.push("Identify constraints.", "Compare viable alternatives.", "Prefer minimal architectural disruption.");
			break;
		case "refactoring":
			lines.push("Preserve existing behavior.", "Verify affected contracts.", "Watch for unintended API changes.");
			break;
		case "complex":
			lines.push("Understand the relevant architecture before editing.", "Keep the implementation proportional to the task.", "Make verification depth match the risk.");
			break;
		case "normal":
		default:
			lines.push("Inspect relevant context before editing.", "Keep the plan proportional to the task.", "Verify affected behavior before completion.");
	}
	if (profile.workflow?.architecture && !lines.some(line => line.includes("architecture"))) lines.push("Respect existing architectural boundaries.");
	if (profile.workflow?.verification === "deep" || profile.workflow?.verification === "final") lines.push("Treat verification evidence as a completion gate.");
	return { name: "task", priority: "core", text: [...new Set(lines)].join("\n") };
}
