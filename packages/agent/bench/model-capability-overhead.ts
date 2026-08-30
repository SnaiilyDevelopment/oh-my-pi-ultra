import type { Model } from "@oh-my-pi/pi-ai";
import { createStrategyProfile, deriveModelCapabilities } from "../src/model-capability";
import { classifyTask } from "../src/task-router";

const model = {
	id: "bench", name: "bench", provider: "bench", api: "openai-completions", baseUrl: "https://example.invalid", identity: {} as Model["identity"],
	reasoning: true, thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high", "max"] }, input: ["text"], supportsTools: true,
	contextWindow: 128000, maxTokens: 16000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsParallelToolCalls: true, supportsToolChoice: true, supportsForcedToolChoice: true, supportsNamedToolChoice: true },
} as Model;
const task = classifyTask("Refactor authentication across the API and frontend");
const start = performance.now();
for (let i = 0; i < 10000; i++) createStrategyProfile(task, deriveModelCapabilities(model));
const elapsedMs = performance.now() - start;
console.log(JSON.stringify({ iterations: 10000, elapsedMs, averageMicroseconds: elapsedMs * 100, strategy: createStrategyProfile(task, deriveModelCapabilities(model)) }, null, 2));
