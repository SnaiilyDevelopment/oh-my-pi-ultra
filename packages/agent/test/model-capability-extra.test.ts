import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createStrategyProfile, deriveModelCapabilities, invalidateModelCapabilities, createModelCapabilityTelemetry, recordCapabilityEvidence } from "../src/model-capability";

const model = (extra: Partial<Model> = {}) => ({
	id: "cap-test", name: "cap-test", provider: "cap", api: "openai-completions", baseUrl: "https://cap.invalid", identity: {} as Model["identity"],
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 8000,
	compat: {} as Model["compat"], ...extra,
}) as Model;
const task = { complexity: "COMPLEX", confidence: 0.9, reasons: [], workflow: "deep" } as const;

describe("model capability edge cases", () => {
	test("unknown remains unknown", () => {
		invalidateModelCapabilities(); const p = deriveModelCapabilities(model({ reasoning: undefined, supportsTools: undefined }));
		expect(p.reasoning).toBe("unknown"); expect(p.toolCalling).toBe("unknown"); expect(p.parallelToolCalls).toBe("unknown");
	});
	test("unsupported reasoning does not create a fake effort mode", () => {
		const p = deriveModelCapabilities(model({ reasoning: false })); const s = createStrategyProfile(task, p);
		expect(s.reasoningMode).toBe("default"); expect(s.verificationDepth).toBe("deep");
	});
	test("three repeated capability failures can invalidate the cached profile", () => {
		invalidateModelCapabilities(); const m = model(); deriveModelCapabilities(m); const t = createModelCapabilityTelemetry(m, task);
		recordCapabilityEvidence(t, "providerErrors", m); recordCapabilityEvidence(t, "providerErrors", m); recordCapabilityEvidence(t, "providerErrors", m);
		const refreshed = deriveModelCapabilities(m); expect(refreshed).not.toBe(t.profile);
	});
});
