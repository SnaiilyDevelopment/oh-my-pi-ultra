import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createStrategyProfile, deriveModelCapabilities, invalidateModelCapabilities } from "../src/model-capability";
import type { TaskClassification } from "../src/task-router";

function model(overrides: Partial<Model> = {}): Model {
	return {
		id: "test-model",
		name: "Test",
		provider: "test",
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		identity: { class: "openai", family: "test", revision: "1" } as Model["identity"],
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
		compat: { supportsToolChoice: true, supportsForcedToolChoice: true, supportsNamedToolChoice: true, supportsDeveloperRole: true } as Model["compat"],
		...overrides,
	} as Model;
}

const task: TaskClassification = {
	complexity: "COMPLEX",
	confidence: 0.92,
	reasons: ["cross-file refactor"],
	workflow: "deep",
};

describe("model capability", () => {
	test("preserves unknown capabilities instead of guessing", () => {
		invalidateModelCapabilities();
		const profile = deriveModelCapabilities(model({ supportsTools: undefined, input: ["text"] }));
		expect(profile.toolCalling).toBe("unknown");
		expect(profile.parallelToolCalls).toBe("unknown");
		expect(profile.structuredOutput).toBe("unknown");
		expect(profile.vision).toBe("unsupported");
	});

	test("uses explicit model metadata for reasoning, tools, vision and computer use", () => {
		invalidateModelCapabilities();
		const profile = deriveModelCapabilities(model({ reasoning: true, input: ["text", "image"], supportsTools: true, supportsComputerUse: true, thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high", "max"] } as Model["thinking"] }));
		expect(profile.reasoning).toBe("supported");
		expect(profile.reasoningLevels).toEqual(["minimal", "low", "medium", "high", "max"]);
		expect(profile.toolCalling).toBe("supported");
		expect(profile.vision).toBe("supported");
		expect(profile.computerUse).toBe("supported");
	});

	test("adapts strategy to task complexity and capability", () => {
		const strong = deriveModelCapabilities(model({ reasoning: true, supportsTools: true, compat: { supportsToolChoice: true, supportsForcedToolChoice: true, supportsNamedToolChoice: true, supportsParallelToolCalls: true } as Model["compat"], thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high", "max"] } as Model["thinking"] }));
		const strategy = createStrategyProfile(task, strong);
		expect(strategy.reasoningMode).toBe("max");
		expect(strategy.allowParallelTools).toBe(true);
		expect(strategy.contextBudget).toBeGreaterThan(0);
	});

	test("avoids invalid reasoning control when the model has no controllable reasoning surface", () => {
		const weak = deriveModelCapabilities(model({ reasoning: true, thinking: undefined }));
		const strategy = createStrategyProfile(task, weak);
		expect(strategy.reasoningMode).toBe("default");
		expect(strategy.reasons.some(reason => reason.includes("no controllable reasoning surface"))).toBe(true);
	});

	test("uses separate cache entries for materially different endpoints", () => {
		invalidateModelCapabilities();
		const a = deriveModelCapabilities(model({ baseUrl: "https://one.invalid" }));
		const b = deriveModelCapabilities(model({ baseUrl: "https://two.invalid" }));
		expect(a).not.toBe(b);
	});
});
