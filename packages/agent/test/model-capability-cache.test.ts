import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createModelCapabilityTelemetry, deriveModelCapabilities, getModelCapabilityCacheSize, invalidateModelCapabilities, recordCapabilityEvidence } from "../src/model-capability";

const base = {
	id: "cache-model",
	name: "Cache",
	provider: "cache",
	api: "openai-completions",
	baseUrl: "https://cache.invalid",
	identity: {} as Model["identity"],
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64000,
	maxTokens: 8000,
	compat: {} as Model["compat"],
} as Model;

const task = { complexity: "NORMAL", confidence: 0.9, reasons: [], workflow: "standard" } as const;

describe("capability cache", () => {
	test("reuses stable profile without re-deriving", () => {
		invalidateModelCapabilities();
		const first = deriveModelCapabilities(base);
		const second = deriveModelCapabilities(base);
		expect(first).toBe(second);
		expect(getModelCapabilityCacheSize()).toBe(1);
	});

	test("repeated runtime evidence can invalidate only with the real model key", () => {
		invalidateModelCapabilities();
		deriveModelCapabilities(base);
		const telemetry = createModelCapabilityTelemetry(base, task);
		recordCapabilityEvidence(telemetry, "providerErrors", base);
		recordCapabilityEvidence(telemetry, "providerErrors", base);
		expect(getModelCapabilityCacheSize()).toBe(1);
		recordCapabilityEvidence(telemetry, "providerErrors", base);
		expect(getModelCapabilityCacheSize()).toBe(0);
	});
});
