/** Runtime integration for the adaptive router and context intelligence. */
import type { Effort } from "@oh-my-pi/pi-ai";
import { Agent } from "./agent";
import type { AgentState } from "./types";
import {
	assembleContext,
	contextBudgetForComplexity,
	type ContextIntelligenceTelemetry,
} from "./context-intelligence";
import {
	classifyTask,
	inferEscalationTrigger,
	isTaskFailureMessage,
	TaskRouteTracker,
	type TaskClassification,
	type TaskComplexity,
	type TaskRoutingTelemetry,
} from "./task-router";

const kPatched = Symbol.for("oh-my-pi-ultra.task-router.patched");
const byAgent = new WeakMap<Agent, RuntimeRoute>();
type RoutedState = AgentState & {
	taskRouting?: TaskRoutingTelemetry;
	initialTaskClassification?: TaskClassification;
	contextIntelligence?: ContextIntelligenceTelemetry;
};
interface RuntimeRoute {
	tracker: TaskRouteTracker;
	previousThinking: Effort | undefined;
	autoThinking: boolean;
	unsubscribe: () => void;
	removeContextHook: () => void;
	failures: number;
}

function enabled(): boolean {
	return Bun.env.PI_TASK_ROUTER !== "0";
}

function contextEnabled(): boolean {
	return Bun.env.PI_CONTEXT_INTELLIGENCE !== "0";
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(x => (x && typeof x === "object" && "text" in x ? String((x as { text?: unknown }).text ?? "") : ""))
		.join(" ");
}

function promptText(input: unknown): string | undefined {
	if (typeof input === "string") return input.trim() || undefined;
	if (Array.isArray(input)) {
		return (
			input
				.filter(x => x && typeof x === "object" && (x as { role?: string }).role === "user")
				.map(x => textOf((x as { content?: unknown }).content))
				.join(" ")
				.trim() || undefined
		);
	}
	if (input && typeof input === "object" && (input as { role?: string }).role === "user") {
		return textOf((input as { content?: unknown }).content).trim() || undefined;
	}
	return undefined;
}

function effort(c: TaskComplexity): Effort {
	return c === "SIMPLE" ? ("minimal" as Effort) : c === "NORMAL" ? ("low" as Effort) : c === "COMPLEX" ? ("high" as Effort) : ("max" as Effort);
}

function publish(agent: Agent, route: RuntimeRoute): void {
	const state = agent.state as RoutedState;
	state.initialTaskClassification = route.tracker.initial;
	state.taskRouting = route.tracker.telemetry;
}

function adaptThinking(agent: Agent, route: RuntimeRoute): void {
	if (agent.state.thinkingLevel !== undefined || route.autoThinking) return;
	route.autoThinking = true;
	agent.setThinkingLevel(effort(route.tracker.current.complexity));
}

function attachContextIntelligence(agent: Agent, route: RuntimeRoute, task: string): void {
	if (!contextEnabled()) return;
	route.removeContextHook = agent.addBeforeModelCall(async context => {
		if (context.messages.length === 0) return;
		const model = agent.state.model as typeof agent.state.model & { contextWindow?: number };
		const contextWindowTokens = typeof model.contextWindow === "number" ? model.contextWindow : undefined;
		const explicitBudget = parsePositiveInteger(Bun.env.PI_CONTEXT_BUDGET);
		const budgetTokens = explicitBudget ?? contextBudgetForComplexity(route.tracker.current.complexity, contextWindowTokens);
		const assembled = assembleContext(task, context.messages, agent.tokenizer, {
			complexity: route.tracker.current.complexity,
			budgetTokens,
			recentMessageCount: parsePositiveInteger(Bun.env.PI_CONTEXT_RECENT_MESSAGES),
			contextWindowTokens,
		});
		context.messages = assembled.messages;
		const state = agent.state as RoutedState;
		state.contextIntelligence = assembled.telemetry;
		publish(agent, route);
	});
}

function inspectTurn(agent: Agent, route: RuntimeRoute, resultText: string, toolFailed: boolean): void {
	const text = resultText.slice(0, 12000);
	if (!toolFailed && !isTaskFailureMessage(text)) {
		route.failures = 0;
		return;
	}
	route.failures++;
	const trigger = inferEscalationTrigger(text) ?? "repair_failure";
	const escalation = route.tracker.observe(trigger, `execution evidence: ${text.slice(0, 220)}`);
	if (escalation) adaptThinking(agent, route);
	publish(agent, route);
}

function attach(agent: Agent, task: string): RuntimeRoute {
	byAgent.get(agent)?.unsubscribe();
	byAgent.get(agent)?.removeContextHook();
	const route: RuntimeRoute = {
		tracker: new TaskRouteTracker(classifyTask(task)),
		previousThinking: agent.state.thinkingLevel,
		autoThinking: false,
		unsubscribe: () => {},
		removeContextHook: () => {},
		failures: 0,
	};
	route.unsubscribe = agent.subscribe(event => {
		if (event.type === "turn_end") {
			const results = event.toolResults as Array<{ content: unknown; isError?: boolean }>;
			inspectTurn(agent, route, results.map(x => textOf(x.content)).join(" "), results.some(x => x.isError === true));
		} else if (event.type === "agent_end") {
			publish(agent, route);
		}
	});
	byAgent.set(agent, route);
	publish(agent, route);
	adaptThinking(agent, route);
	attachContextIntelligence(agent, route, task);
	return route;
}

function patch(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown };
	if (target[kPatched]) return;
	target[kPatched] = true;
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(target as any).prompt = async function routedPrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return original.apply(this, args);
		const task = promptText(args[0]);
		if (!task) return original.apply(this, args);
		const route = attach(this, task);
		try {
			return await original.apply(this, args);
		} finally {
			publish(this, route);
			route.unsubscribe();
			route.removeContextHook();
			if (route.previousThinking !== undefined) this.setThinkingLevel(route.previousThinking);
			else if (route.autoThinking) this.setThinkingLevel(undefined);
			byAgent.delete(this);
		}
	};
}

patch();

export function getTaskRouting(agent: Agent): TaskRoutingTelemetry | undefined {
	return (agent.state as RoutedState).taskRouting;
}

export function getContextIntelligence(agent: Agent): ContextIntelligenceTelemetry | undefined {
	return (agent.state as RoutedState).contextIntelligence;
}
