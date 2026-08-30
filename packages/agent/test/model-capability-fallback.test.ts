import { describe, expect, test } from "bun:test";
import { createStrategyProfile, type ModelCapabilities } from "../src/model-capability";

const complex = { complexity: "COMPLEX", confidence: 0.9, reasons: ["cross-file"], workflow: "deep" } as const;
const base: ModelCapabilities = {
	contextWindow: 32000,
	maxOutputTokens: 8000,
	reasoning: "unknown",
	reasoningLevels: [],
	toolCalling: "supported",
	parallelToolCalls: "unknown",
	structuredOutput: "unknown",
	vision: "unknown",
	computerUse: "unknown",
	streaming: "supported",
	promptCaching: "unknown",
	supportsToolChoice: "unknown",
	supportsForcedToolChoice: "unknown",
	supportsNamedToolChoice: "unknown",
	supportsDeveloperMessages: "unknown",
	supportsSystemMessages: "unknown",
};

describe("model capability fallback policy", () => {
	test("unknown capability does not force capability fallback", () => {
		const strategy = createStrategyProfile(complex, base);
		expect(strategy.fallbackPolicy).toBe("capability");
	});

	test("explicitly unsupported parallel tools select stronger fallback policy", () => {
		const strategy = createStrategyProfile(complex, { ...base, parallelToolCalls: "unsupported" });
		expect(strategy.allowParallelTools).toBe(false);
		expect(strategy.fallbackPolicy).toBe("capability-and-health");
	});

	test("unsupported reasoning stays on workflow/context/verification adaptation", () => {
		const strategy = createStrategyProfile(complex, { ...base, reasoning: "unsupported" });
		expect(strategy.reasoningMode).toBe("default");
		expect(strategy.verificationDepth).toBe("deep");
	});
});
