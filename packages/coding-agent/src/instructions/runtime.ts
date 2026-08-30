import { mkdir } from "node:fs/promises";
import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { classifyTask } from "@oh-my-pi/pi-agent-core";
import { composeInstructions } from "./compose";
import { instructionStateFromAgent, specialistRoleFromState } from "./state";
import type { InstructionState, InstructionTelemetry } from "./types";

const PATCHED = Symbol.for("oh-my-pi-ultra.dynamic-instructions.patched");
const telemetryByAgent = new WeakMap<Agent, InstructionTelemetry>();

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "").join(" ");
}

function taskText(agent: Agent): string {
	const user = agent.state.messages.find(message => message.role === "user");
	return textOf(user ?? ({} as AgentMessage));
}

function stripLegacyWorkflow(prompt: string): string {
	if (!prompt.includes("Helpful, trusted assistant for load-bearing changes in Oh My Pi coding harness.")) return prompt.trim();
	return prompt.replace(/\n§ Workflow[\s\S]*?(?=\n§ Delivery|\n§ Critical|$)/g, "").replace(/\n§ Delivery[\s\S]*?(?=\n§ Critical|$)/g, "").replace(/\n§ Critical[\s\S]*$/g, "").trim();
}

async function persistBenchmarkInstructionTelemetry(telemetry: InstructionTelemetry): Promise<void> {
	const evidenceFile = process.env.OMP_BENCH_EVIDENCE_FILE;
	if (!evidenceFile) return;
	try {
		const sidecar = `${evidenceFile}.instructions.json`;
		await mkdir(new URL("./", `file://${sidecar}`).pathname.replace(/\/[^/]*$/, ""), { recursive: true }).catch(() => undefined);
		await Bun.write(sidecar, JSON.stringify({ instructions: telemetry }, null, 2));
	} catch {
		// Benchmark sidecar collection is observational and must never affect an agent run.
	}
}

function refresh(agent: Agent): void {
	const task = taskText(agent);
	const classification = task ? classifyTask(task) : undefined;
	const state = instructionStateFromAgent(agent, classification);
	const configured = Number.parseInt(process.env.PI_INSTRUCTION_BUDGET_TOKENS ?? "320", 10);
	const safeBudget = Number.isFinite(configured) && configured > 0 ? configured : 320;
	const maxTokens = Math.max(96, state.contextPressure !== undefined && state.contextPressure >= 0.9 ? Math.floor(safeBudget * 0.7) : safeBudget);
	const composed = composeInstructions(state, { maxTokens, countTokens: text => agent.tokenizer.countTokens(text, "approximate") });
	const marker = "[OMP Ultra Dynamic Instructions]";
	const base = agent.state.systemPrompt.flatMap(block => {
		if (block.startsWith(marker)) return [];
		const stripped = stripLegacyWorkflow(block);
		return stripped ? [stripped] : [];
	});
	agent.state.systemPrompt = [...base, `${marker}\n${composed.text}`];
	telemetryByAgent.set(agent, composed.telemetry);
	void persistBenchmarkInstructionTelemetry(composed.telemetry);
}

function patch(): void {
	const prototype = Agent.prototype as unknown as { [key: symbol]: unknown };
	if (prototype[PATCHED]) return;
	prototype[PATCHED] = true;
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(Agent.prototype as unknown as { prompt: (...args: unknown[]) => Promise<unknown> }).prompt = async function dynamicInstructionPrompt(this: Agent, ...args: unknown[]) {
		if (process.env.PI_DYNAMIC_INSTRUCTIONS === "0") return original.apply(this, args);
		const removeHook = this.addBeforeModelCall(() => refresh(this));
		try {
			return await original.apply(this, args);
		} finally {
			removeHook();
		}
	};
}

patch();

export function getInstructionTelemetry(agent: Agent): InstructionTelemetry | undefined {
	return telemetryByAgent.get(agent);
}

export function activeSpecialistRole(agent: Agent): string | undefined {
	const state = agent.state as typeof agent.state & { specialistOrchestration?: { activeRoles?: unknown[] } };
	return specialistRoleFromState(state.specialistOrchestration?.activeRoles?.[0]);
}

export function refreshDynamicInstructions(agent: Agent): void {
	if (process.env.PI_DYNAMIC_INSTRUCTIONS === "0") return;
	refresh(agent);
}
