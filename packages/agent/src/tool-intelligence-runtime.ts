/**
 * Runtime bridge for deterministic tool-result projection.
 *
 * Tool execution stays owned by the existing coding-agent tool registry. This
 * hook only changes the per-model-call projection of already-produced
 * `toolResult` messages, so permissions, validation, providers, and execution
 * semantics remain untouched.
 */
import { createHash } from "node:crypto";
import { Agent } from "./agent";
import type { AgentMessage, AgentState } from "./types";
import {
	projectToolMessage,
	type ToolIntelligenceTelemetry,
	type ToolProjectionContext,
} from "./tool-intelligence";

const kPatched = Symbol.for("oh-my-pi-ultra.tool-intelligence.patched");
const byAgent = new WeakMap<Agent, { remove: () => void; telemetry: ToolIntelligenceTelemetry }>();

interface RoutedState extends AgentState {
	toolIntelligence?: ToolIntelligenceTelemetry;
}

function enabled(): boolean {
	return process.env.PI_TOOL_INTELLIGENCE !== "0";
}

function emptyTelemetry(): ToolIntelligenceTelemetry {
	return {
		calls: 0,
		rawOutputBytes: 0,
		modelFacingBytes: 0,
		projectedCalls: 0,
		projectionLatencyMs: 0,
		duplicatesSuppressed: 0,
		cacheHits: 0,
		cacheMisses: 0,
		fullOutputRetrievals: 0,
		byTool: {},
	};
}

function taskFromArgs(args: unknown[]): string {
	const input = args[0];
	if (typeof input === "string") return input.trim();
	if (!Array.isArray(input)) return "";
	return input
		.filter(item => item && typeof item === "object" && (item as { role?: string }).role === "user")
		.map(item => {
			const content = (item as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content.map(block => block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : "").join(" ");
		})
		.join(" ")
		.trim();
}

function textHash(message: AgentMessage): string {
	const content = (message as unknown as { content?: unknown }).content;
	return createHash("sha256").update(JSON.stringify(content ?? null)).digest("hex");
}

function mergeTelemetry(total: ToolIntelligenceTelemetry, next: ToolIntelligenceTelemetry): void {
	total.calls += next.calls;
	total.rawOutputBytes += next.rawOutputBytes;
	total.modelFacingBytes += next.modelFacingBytes;
	total.projectedCalls += next.projectedCalls;
	total.projectionLatencyMs += next.projectionLatencyMs;
	total.duplicatesSuppressed += next.duplicatesSuppressed;
	total.cacheHits += next.cacheHits;
	total.cacheMisses += next.cacheMisses;
	total.fullOutputRetrievals += next.fullOutputRetrievals;
	for (const [name, item] of Object.entries(next.byTool)) {
		const current = total.byTool[name] ?? { calls: 0, rawOutputBytes: 0, modelFacingBytes: 0, projectedCalls: 0, duplicatesSuppressed: 0 };
		current.calls += item.calls;
		current.rawOutputBytes += item.rawOutputBytes;
		current.modelFacingBytes += item.modelFacingBytes;
		current.projectedCalls += item.projectedCalls;
		current.duplicatesSuppressed += item.duplicatesSuppressed;
		total.byTool[name] = current;
	}
}

function publish(agent: Agent, telemetry: ToolIntelligenceTelemetry): void {
	(agent.state as RoutedState).toolIntelligence = {
		...telemetry,
		byTool: Object.fromEntries(Object.entries(telemetry.byTool).map(([name, value]) => [name, { ...value }])),
	};
}

function isToolResult(message: AgentMessage): boolean {
	return message.role === "toolResult";
}

async function attach(agent: Agent, task: string): Promise<void> {
	const previous = byAgent.get(agent);
	previous?.remove();
	const telemetry = emptyTelemetry();
	const remove = agent.addBeforeModelCall(async context => {
		const seen = new Map<string, AgentMessage>();
		const projectedMessages: AgentMessage[] = [];
		for (const message of context.messages) {
			if (!isToolResult(message)) {
				projectedMessages.push(message);
				continue;
			}
			const name = String((message as unknown as { toolName?: unknown }).toolName ?? "tool");
			const projectionContext: ToolProjectionContext = {
				task,
				previousMessage: seen.get(`${name}|${textHash(message)}`),
			};
			const projected = projectToolMessage(message, name, projectionContext);
			mergeTelemetry(telemetry, projected.telemetry);
			projectedMessages.push(projected.message);
			seen.set(`${name}|${textHash(message)}`, projected.message);
		}
		context.messages = projectedMessages;
		publish(agent, telemetry);
	});
	byAgent.set(agent, { remove, telemetry });
	publish(agent, telemetry);
}

function patch(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown };
	if (target[kPatched]) return;
	target[kPatched] = true;
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(target as any).prompt = async function toolIntelligencePrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return original.apply(this, args);
		const task = taskFromArgs(args);
		if (!task) return original.apply(this, args);
		await attach(this, task);
		try {
			return await original.apply(this, args);
		} finally {
			const runtime = byAgent.get(this);
			if (runtime) {
				publish(this, runtime.telemetry);
				runtime.remove();
				byAgent.delete(this);
			}
		}
	};
}

patch();

export function getToolIntelligence(agent: Agent): ToolIntelligenceTelemetry | undefined {
	return (agent.state as RoutedState).toolIntelligence;
}
