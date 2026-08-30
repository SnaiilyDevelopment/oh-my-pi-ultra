/**
 * Runtime integration for the adaptive task router.
 *
 * It attaches to the existing Agent lifecycle; it does not create another loop.
 * Set PI_TASK_ROUTER=0 to preserve pre-router behavior completely.
 */
import type { Effort } from "@oh-my-pi/pi-ai";
import { Agent } from "./agent";
import type { AgentMessage, AgentState } from "./types";
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
const stateByAgent = new WeakMap<Agent, RoutingState>();

type RoutingAgentState = AgentState & {
	taskRouting?: TaskRoutingTelemetry;
	initialTaskClassification?: TaskClassification;
};

interface RoutingState {
	tracker: TaskRouteTracker;
	restoreThinking: Effort | undefined;
	adaptedThinking: boolean;
	unsubscribe: () => void;
	consecutiveFailures: number;
}

function enabled(): boolean {
	return Bun.env.PI_TASK_ROUTER !== "0";
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : ""))
		.join(" ");
}

function extractPromptText(input: unknown): string | undefined {
	if (typeof input === "string") return input.trim() || undefined;
	if (Array.isArray(input)) {
		const text = input
			.filter(message => message && typeof message === "object" && (message as { role?: string }).role === "user")
			.map(message => contentText((message as { content?: unknown }).content))
			.join(" ")
			.trim();
		return text || undefined;
	}
	if (input && typeof input === "object" && (input as { role?: string }).role === "user") {
		const text = contentText((input as { content?: unknown }).content).trim();
		return text || undefined;
	}
	return undefined;
}

function effortForComplexity(complexity: TaskComplexity): Effort {
	switch (complexity) {
		case "SIMPLE":
			return "minimal" as Effort;
		case "NORMAL":
			return "low" as Effort;
		case "COMPLEX":
			return "high" as Effort;
		case "VERY_COMPLEX":
			return "max" as Effort;
	}
}

function setRoutingState(agent: Agent, state: RoutingState): void {
	const agentState = agent.state as RoutingAgentState;
	agentState.initialTaskClassification = state.tracker.initial;
	agentState.taskRouting = state.tracker.telemetry;
}

function maybeAdaptThinking(agent: Agent, state: RoutingState): void {
	if (agent.state.thinkingLevel !== undefined || state.adaptedThinking) return;
	state.adaptedThinking = true;
	state.restoreThinking = undefined;
	agent.setThinkingLevel(effortForComplexity(state.tracker.current.complexity));
}

function handleTurnEnd(agent: Agent, state: RoutingState, text: string): void {
	const telemetryText = text.slice(0, 12000);
	const failure = state.consecutiveFailures > 0 || isTaskFailureMessage(telemetryText);
	if (!failure) {
		state.consecutiveFailures = 0;
		return;
	}
	state.consecutiveFailures++;

	const trigger = inferEscalationTrigger(telemetryText) ?? "repair_failure";
	const escalation = state.tracker.observe(trigger, `execution evidence: ${telemetryText.slice(0, 220)}`);
	if (escalation) maybeAdaptThinking(agent, state);
	setRoutingState(agent, state);
}

function attachRouting(agent: Agent, text: string): RoutingState {
	const previous = stateByAgent.get(agent);
	previous?.unsubscribe();

	const initial = classifyTask(text);
	const state: RoutingState = {
		tracker: new TaskRouteTracker(initial),
		restoreThinking: agent.state.thinkingLevel,
		adaptedThinking: false,
		unsubscribe: () => {},
		consecutiveFailures: 0,
	};

	const unsubscribe = agent.subscribe(event => {
		if (event.type === "turn_end") {
			const toolText = event.toolResults.map(result => contentText(result.content)).join(" ");
			if (event.toolResults.some(result => result.isError) || inferEscalationTrigger(toolText)) {
				handleTurnEnd(agent, state, toolText);
			}
		} else if (event.type === "agent_end") {
			setRoutingState(agent, state);
		}
	});
	state.unsubscribe = unsubscribe;
	stateByAgent.set(agent, state);
	setRoutingState(agent, state);
	maybeAdaptThinking(agent, state);
	return state;
}

function patch(): void {
	const target = Agent.prototype as Agent & { [kPatched]?: boolean };
	if (target[kPatched]) return;
	target[kPatched] = true;

	const originalPrompt = Agent.prototype.prompt;
	(target as any).prompt = async function patchedPrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return (originalPrompt as any).apply(this, args);
		const text = extractPromptText(args[0]);
		if (!text) return (originalPrompt as any).apply(this, args);

		const state = attachRouting(this, text);
		try {
			return await (originalPrompt as any).apply(this, args);
		} finally {
			setRoutingState(this, state);
			state.unsubscribe();
			// Only restore a value if it was explicitly present before routing.
			// Automatically selected reasoning is otherwise left out of the session
			// state, so the next prompt is classified independently.
			if (state.restoreThinking !== undefined) this.setThinkingLevel(state.restoreThinking);
			else if (state.adaptedThinking) this.setThinkingLevel(undefined);
			stateByAgent.delete(this);
		}
	};
}

patch();

export function getTaskRouting(agent: Agent): TaskRoutingTelemetry | undefined {
	return (agent.state as RoutingAgentState).taskRouting;
}
