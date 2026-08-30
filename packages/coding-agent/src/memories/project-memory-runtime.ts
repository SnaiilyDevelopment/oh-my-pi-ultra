import { getAgentDir } from "@oh-my-pi/pi-utils";
import {
	classifyTask,
	getContextIntelligence,
	getModelStrategy,
	getRepositoryIntelligence,
	getTaskRouting,
	getVerification,
	Agent,
	type AgentMessage,
	type AgentState,
} from "@oh-my-pi/pi-agent-core";
import {
	MemoryCategory,
	MemoryCandidate,
	MemoryItem,
	MemoryScope,
	MemoryTrust,
	ProjectMemoryStore,
	MemoryTelemetry,
	projectFingerprint,
	projectMemoryFilePath,
	renderProjectMemory,
} from "./project-memory";

const kPatched = Symbol.for("oh-my-pi-ultra.project-memory.patched");
const byAgent = new WeakMap<Agent, ProjectMemoryRuntime>();

interface MemoryState extends AgentState {
	projectMemory?: ProjectMemoryTelemetry;
}

interface ProjectMemoryRuntime {
	store: ProjectMemoryStore;
	telemetry: MemoryTelemetry;
	removeHook: () => void;
}

const CATEGORY_BY_FAILURE: MemoryCategory = "KNOWN_FAILURE";

function enabled(): boolean {
	return process.env.PI_PROJECT_MEMORY !== "0";
}

function positive(name: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function promptText(input: unknown): string | undefined {
	if (typeof input === "string") return input.trim() || undefined;
	if (!Array.isArray(input)) return undefined;
	const text = input
		.filter(item => item && typeof item === "object" && (item as { role?: string }).role === "user")
		.map(item => {
			const content = (item as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content.map(block => block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : "").join(" ");
		})
		.join(" ")
		.trim();
	return text || undefined;
}

function scopeForTask(task: string): MemoryScope {
	const subsystem = task.match(/\b(?:packages|apps|services|src)\/([A-Za-z0-9_.-]+)/i);
	return subsystem ? "SUBSYSTEM" : "PROJECT";
}

function userInstructionCandidate(task: string, fingerprint: string): MemoryCandidate | undefined {
	const match = task.match(/\b(never|do not|don't)\s+(?:edit|modify|change)\s+([^.!?]+)|\buse\s+([A-Za-z0-9_.@/-]+)\s+(?:not|instead of)\s+([A-Za-z0-9_.@/-]+)/i);
	if (!match) return undefined;
	const content = match[1]
		? `${match[1].toLowerCase()} edit ${match[2].trim()}`
		: `Use ${match[3]} instead of ${match[4]}`;
	return {
		type: "CONVENTION",
		content,
		source: "explicit user instruction",
		scope: scopeForTask(task),
		confidence: 0.98,
		trust: "CONFIRMED",
		relevance: 1,
		repositoryFingerprint: fingerprint,
		confirmed: true,
	};
}

function workflowCandidate(task: string, fingerprint: string): MemoryCandidate | undefined {
	const verification = getCurrentVerification();
	const checks = verification?.plan?.checks?.map((check: { name?: string }) => check.name).filter(Boolean) as string[] | undefined;
	if (!checks || checks.length < 2) return undefined;
	return {
		type: "WORKFLOW",
		content: `For ${task.slice(0, 120)}, verified workflow is ${checks.join(" -> ")}.`,
		source: "verification workflow",
		scope: scopeForTask(task),
		confidence: 0.82,
		trust: "OBSERVED",
		relevance: 0.8,
		repositoryFingerprint: fingerprint,
		verified: false,
	};
}

function toolingCandidate(fingerprint: string): MemoryCandidate | undefined {
	const repo = getCurrentRepository();
	const profile = repo?.profile as unknown as Record<string, unknown> | undefined;
	const pkg = typeof profile?.packageManager === "string" ? profile.packageManager : undefined;
	const test = typeof profile?.testFramework === "string" ? profile.testFramework : undefined;
	if (!pkg && !test) return undefined;
	const parts: string[] = [];
	if (pkg) parts.push(`Project uses ${pkg} as its package manager.`);
	if (test) parts.push(`Tests use ${test}.`);
	return {
		type: "TOOLING",
		content: parts.join(" "),
		source: "repository intelligence",
		scope: "PROJECT",
		confidence: 0.92,
		trust: "VERIFIED",
		relevance: 0.95,
		repositoryFingerprint: fingerprint,
		verified: true,
	};
}

function failureCandidate(task: string, fingerprint: string): MemoryCandidate | undefined {
	const verification = getCurrentVerification();
	const failure = verification?.lastFailure as { check?: string; category?: string; summary?: string } | undefined;
	if (!failure?.check || !failure.summary) return undefined;
	return {
		type: CATEGORY_BY_FAILURE,
		content: `For ${task.slice(0, 80)}, ${failure.check} can fail with ${failure.category ?? "an execution error"}: ${failure.summary}`,
		source: "verified recovery evidence",
		scope: scopeForTask(task),
		confidence: 0.84,
		trust: "OBSERVED",
		relevance: 0.9,
		repositoryFingerprint: fingerprint,
		verified: false,
	};
}

function getCurrentVerification(): { plan?: { checks?: Array<{ name?: string }> }; lastFailure?: unknown } | undefined {
	return undefined;
}

function getCurrentRepository(): { profile?: unknown } | undefined {
	return undefined;
}

function mergeTelemetry(target: MemoryTelemetry, delta: Partial<MemoryTelemetry>): MemoryTelemetry {
	return {
		...target,
		...delta,
		rejectionReasons: { ...target.rejectionReasons, ...(delta.rejectionReasons ?? {}) },
	};
}

function publish(agent: Agent, runtime: ProjectMemoryRuntime): void {
	(agent.state as MemoryState).projectMemory = { ...runtime.telemetry, rejectionReasons: { ...runtime.telemetry.rejectionReasons } };
}

async function loadMemoryContext(agent: Agent, task: string, store: ProjectMemoryStore, fingerprint: string): Promise<AgentMessage | undefined> {
	const classification = classifyTask(task);
	if (classification.complexity === "SIMPLE" && process.env.PI_PROJECT_MEMORY_ALWAYS !== "1") return undefined;
	const strategy = getModelStrategy(agent);
	const strategyBudget = strategy?.contextBudget;
	const requestedBudget = positive("PI_PROJECT_MEMORY_BUDGET_TOKENS", 1200);
	const budget = strategyBudget ? Math.min(requestedBudget, Math.max(256, Math.floor(strategyBudget * 0.14))) : requestedBudget;
	const result = await store.query(task, fingerprint, {
		limit: positive("PI_PROJECT_MEMORY_RETRIEVAL_LIMIT", classification.complexity === "VERY_COMPLEX" ? 8 : 5),
		budgetTokens: budget,
	});
	const text = renderProjectMemory(result.items);
	return text ? ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage) : undefined;
}

async function capture(agent: Agent, task: string, store: ProjectMemoryStore, fingerprint: string, runtime: ProjectMemoryRuntime): Promise<void> {
	const candidates: MemoryCandidate[] = [];
	const instruction = userInstructionCandidate(task, fingerprint);
	if (instruction) candidates.push(instruction);
	const tooling = toolingCandidate(fingerprint);
	if (tooling) candidates.push(tooling);
	const workflow = workflowCandidate(task, fingerprint);
	if (workflow) candidates.push(workflow);
	const failure = failureCandidate(task, fingerprint);
	if (failure) candidates.push(failure);

	for (const candidate of candidates) {
		runtime.telemetry.candidates += 1;
		const result = await store.addCandidate(candidate);
		runtime.telemetry.storageLatencyMs += result.storageLatencyMs;
		if (!result.accepted) {
			runtime.telemetry.rejected += 1;
			runtime.telemetry.rejectionReasons[result.reason ?? "unknown"] = (runtime.telemetry.rejectionReasons[result.reason ?? "unknown"] ?? 0) + 1;
			continue;
		}
		runtime.telemetry.accepted += 1;
		if (result.action === "deduplicated") runtime.telemetry.deduplicated += 1;
		if (result.action === "updated") runtime.telemetry.updated += 1;
		if (result.action === "invalidated") runtime.telemetry.invalidated += 1;
	}

	const repo = getRepositoryIntelligence(agent);
	if (repo?.profile) {
		const profile = repo.profile as unknown as Record<string, unknown>;
		const authority: MemoryCandidate[] = [];
		if (typeof profile.packageManager === "string") authority.push({ type: "TOOLING", content: `Project uses ${profile.packageManager} as its package manager.`, source: "repository intelligence", scope: "PROJECT", confidence: 0.99, trust: "VERIFIED", relevance: 1, repositoryFingerprint: fingerprint, verified: true });
		if (typeof profile.testFramework === "string") authority.push({ type: "TOOLING", content: `Tests use ${profile.testFramework}.`, source: "repository intelligence", scope: "PROJECT", confidence: 0.99, trust: "VERIFIED", relevance: 1, repositoryFingerprint: fingerprint, verified: true });
		if (authority.length) runtime.telemetry.validationEvents += authority.length;
		try { await store.reconcileRepositoryFacts(authority); } catch { runtime.telemetry.degraded = true; }
	}
}

function patch(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown };
	if (target[kPatched]) return;
	target[kPatched] = true;
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(target as any).prompt = async function projectMemoryPrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return original.apply(this, args);
		const task = promptText(args[0]);
		if (!task) return original.apply(this, args);
		const agentDir = getAgentDir();
		const cwd = process.cwd();
		const fingerprint = await projectFingerprint(cwd);
		const store = new ProjectMemoryStore(projectMemoryFilePath(agentDir, cwd), cwd, {
			maxItems: positive("PI_PROJECT_MEMORY_MAX_ITEMS", 128),
			maxItemsPerCategory: positive("PI_PROJECT_MEMORY_MAX_CATEGORY_ITEMS", 32),
			maxContentChars: positive("PI_PROJECT_MEMORY_MAX_CONTENT_CHARS", 1600),
		});
		const runtime: ProjectMemoryRuntime = {
			store,
			telemetry: { candidates: 0, accepted: 0, rejected: 0, deduplicated: 0, updated: 0, invalidated: 0, retrieved: 0, notRetrieved: 0, validationEvents: 0, memoryContextTokens: 0, lookupLatencyMs: 0, storageLatencyMs: 0, degraded: false, rejectionReasons: {} },
			removeHook: () => {},
		};
		try {
			const started = performance.now();
			const message = await loadMemoryContext(this, task, store, fingerprint);
			if (message) {
				runtime.removeHook = this.addBeforeModelCall(async context => {
					const present = context.messages.some(item => {
						const content = (item as unknown as { content?: unknown }).content;
						return Array.isArray(content) && content.some(block => block && typeof block === "object" && "text" in block && String((block as { text: unknown }).text).startsWith("[Project Memory]"));
					});
					if (!present) context.messages = [message, ...context.messages];
				});
				runtime.telemetry.retrieved += 1;
				runtime.telemetry.memoryContextTokens += Math.ceil(JSON.stringify(message).length / 4);
			}
			runtime.telemetry.lookupLatencyMs = performance.now() - started;
			publish(this, runtime);
			return await original.apply(this, args);
		} catch {
			runtime.telemetry.degraded = true;
			publish(this, runtime);
			return await original.apply(this, args);
		} finally {
			try { runtime.removeHook(); } catch {}
			try { await capture(this, task, store, fingerprint, runtime); } catch { runtime.telemetry.degraded = true; }
			publish(this, runtime);
			byAgent.delete(this);
		}
	};
}

patch();

export function getProjectMemoryTelemetry(agent: Agent): MemoryTelemetry | undefined {
	return (agent.state as MemoryState).projectMemory;
}
export { getProjectMemoryTelemetry as getMemoryTelemetry };
