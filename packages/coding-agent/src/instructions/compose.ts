import { baseInstructionLayer } from "./base";
import { phaseInstructionLayer } from "./phase";
import { recoveryInstructionLayer } from "./recovery";
import { researchInstructionLayer } from "./research";
import { specialistInstructionLayer } from "./specialist";
import { taskInstructionLayer } from "./task";
import type { InstructionBudget, InstructionLayer, InstructionState, ComposedInstructions } from "./types";

const TOKEN_PER_CHAR = 4;
const approximateTokens = (text: string): number => Math.ceil(text.length / TOKEN_PER_CHAR);
const tokenCounter = (budget: InstructionBudget) => budget.countTokens ?? approximateTokens;
const semanticKey = (line: string): string => line.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function dedupeLayerText(layers: InstructionLayer[]): { layers: InstructionLayer[]; removed: number } {
	const seen = new Set<string>();
	let removed = 0;
	return {
		layers: layers.map(layer => {
			const kept: string[] = [];
			for (const line of layer.text.split(/\r?\n/)) {
				const key = semanticKey(line);
				if (!key || seen.has(key)) { if (key) removed += 1; continue; }
				seen.add(key);
				kept.push(line.trim());
			}
			return { ...layer, text: kept.join("\n") };
		}),
		removed,
	};
}

function trimToBudget(layers: InstructionLayer[], maxTokens: number | undefined, countTokens: (text: string) => number): { layers: InstructionLayer[]; omitted: number } {
	if (!maxTokens) return { layers, omitted: 0 };
	const critical = layers.filter(layer => layer.priority === "critical");
	const other = layers.filter(layer => layer.priority !== "critical");
	let used = countTokens(critical.map(layer => layer.text).filter(Boolean).join("\n"));
	if (used >= maxTokens) return { layers: critical, omitted: other.length };
	const kept = [...critical];
	for (const layer of other) {
		const cost = countTokens(layer.text);
		if (used + cost > maxTokens) continue;
		kept.push(layer);
		used += cost;
	}
	return { layers: kept, omitted: layers.length - kept.length };
}

function capabilityLayer(state: InstructionState): InstructionLayer | undefined {
	const lines: string[] = [];
	if (state.model?.structuredOutput === "supported" && state.specialistRole) lines.push("Use the structured response contract when available; keep findings machine-readable.");
	if (state.model?.toolCalling === "supported" && state.toolNames?.length) lines.push("Prefer direct tool use over speculative descriptions of actions.");
	if (state.model?.parallelToolCalls === "supported" && state.toolNames?.length) lines.push("Parallelize only independent tool calls; preserve dependency order.");
	if (state.model?.promptCaching === "supported") lines.push("Keep stable instructions stable; put changing state after them.");
	return lines.length ? { name: "capability", priority: "optional", text: lines.join("\n") } : undefined;
}

export function composeInstructions(state: InstructionState, budget: InstructionBudget = {}): ComposedInstructions {
	const started = performance.now();
	const countTokens = tokenCounter(budget);
	const candidate: InstructionLayer[] = [
		baseInstructionLayer(),
		taskInstructionLayer(state.task),
		phaseInstructionLayer(state),
		recoveryInstructionLayer(state),
		capabilityLayer(state),
		researchInstructionLayer(state),
		specialistInstructionLayer(state.specialistRole),
	].filter((layer): layer is InstructionLayer => layer !== undefined && layer.text.trim().length > 0);
	const deduped = dedupeLayerText(candidate);
	const budgeted = trimToBudget(deduped.layers, budget.maxTokens, countTokens);
	const ordered = [...budgeted.layers].sort((a, b) => {
		const rank = (value: InstructionLayer["priority"]): number => value === "critical" ? 0 : value === "core" ? 1 : 2;
		return rank(a.priority) - rank(b.priority) || a.name.localeCompare(b.name);
	});
	const baseTokens = countTokens(ordered.filter(layer => layer.name === "base").map(layer => layer.text).join("\n"));
	const phaseTokens = countTokens(ordered.filter(layer => layer.name === "phase").map(layer => layer.text).join("\n"));
	const specialistTokens = countTokens(ordered.filter(layer => layer.name === "specialist").map(layer => layer.text).join("\n"));
	const totalInstructionTokens = countTokens(ordered.map(layer => layer.text).join("\n"));
	return {
		text: ordered.map(layer => `[${layer.name}]\n${layer.text}`).join("\n\n"),
		layers: ordered,
		telemetry: {
			baseTokens,
			dynamicTokens: Math.max(0, totalInstructionTokens - baseTokens),
			phaseTokens,
			specialistTokens,
			totalInstructionTokens,
			duplicateInstructionsRemoved: deduped.removed,
			omittedOptionalInstructions: budgeted.omitted,
			compositionLatencyMs: performance.now() - started,
		},
	};
}
