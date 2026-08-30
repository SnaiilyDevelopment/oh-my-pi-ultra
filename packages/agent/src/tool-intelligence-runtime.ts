/** Runtime bridge for deterministic tool-result projection before Context Intelligence. */
import { Agent } from "./agent";
import type { AgentMessage, AgentState } from "./types";
import { createToolIntelligenceTelemetry, projectToolResult, recordToolIntelligence, type ToolIntelligenceTelemetry } from "./tool-intelligence";

const kPatched = Symbol.for("oh-my-pi-ultra.tool-intelligence.patched");
const byAgent = new WeakMap<Agent, { remove: () => void; telemetry: ToolIntelligenceTelemetry }>();
interface RoutedState extends AgentState { toolIntelligence?: ToolIntelligenceTelemetry; }
function enabled(): boolean { return process.env.PI_TOOL_INTELLIGENCE !== "0"; }
function isToolResult(message: AgentMessage): boolean { return message.role === "toolResult"; }
function toolName(message: AgentMessage): string { return String((message as unknown as { toolName?: unknown }).toolName ?? "tool"); }
function taskFromArgs(args: unknown[]): string {
	const input = args[0];
	if (typeof input === "string") return input.trim();
	if (!Array.isArray(input)) return "";
	return input.filter(item => item && typeof item === "object" && (item as { role?: string }).role === "user").map(item => {
		const content = (item as { content?: unknown }).content;
		if (typeof content === "string") return content;
		return Array.isArray(content) ? content.map(block => block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : "").join(" ") : "";
	}).join(" ").trim();
}
function publish(agent: Agent, telemetry: ToolIntelligenceTelemetry): void {
	(agent.state as RoutedState).toolIntelligence = { ...telemetry, byTool: Object.fromEntries(Object.entries(telemetry.byTool).map(([name, value]) => [name, { ...value }])) };
}
function withArtifactReference(content: AgentMessage["content"], artifactId?: string): AgentMessage["content"] {
	if (!artifactId) return content;
	const text = content.filter((block): block is Extract<AgentMessage["content"][number], { type: "text" }> => block.type === "text").map(block => block.text).join("\n");
	if (/artifact:\/\//i.test(text)) return content;
	return [{ type: "text", text: `${text}\n\nfull output: artifact://${artifactId}`.trim() }];
}
async function attach(agent: Agent): Promise<void> {
	byAgent.get(agent)?.remove();
	const telemetry = createToolIntelligenceTelemetry();
	const remove = agent.addBeforeModelCall(async context => {
		const seen = new Set<string>();
		const messages: AgentMessage[] = [];
		for (const message of context.messages) {
			if (!isToolResult(message)) { messages.push(message); continue; }
			const name = toolName(message);
			const projection = projectToolResult(message, name, undefined, message);
			const key = `${name}|${JSON.stringify((message as unknown as { content?: unknown }).content ?? null)}`;
			const duplicate = seen.has(key) && projection.meta.state === "SUCCESS" && !["read", "browser", "computer", "lsp"].includes(name);
			if (duplicate) { projection.meta.duplicate = true; projection.content = [{ type: "text", text: "[unchanged since previous result]" }]; }
			const content = projection.projected ? withArtifactReference(projection.content, projection.meta.fullOutputArtifactId) : projection.content;
			recordToolIntelligence(telemetry, name, projection.meta, duplicate);
			const details = (message as unknown as { details?: unknown }).details;
			messages.push({ ...(message as object), content, details: { ...(details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : {}), toolIntelligence: projection.meta } } as AgentMessage);
			seen.add(key);
		}
		context.messages = messages;
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
		await attach(this);
		try { return await original.apply(this, args); }
		finally {
			const runtime = byAgent.get(this);
			if (runtime) { publish(this, runtime.telemetry); runtime.remove(); byAgent.delete(this); }
		}
	};
}
patch();
export function getToolIntelligence(agent: Agent): ToolIntelligenceTelemetry | undefined { return (agent.state as RoutedState).toolIntelligence; }
