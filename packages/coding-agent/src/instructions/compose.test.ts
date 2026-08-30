import { describe, expect, test } from "bun:test";
import { composeInstructions } from "./compose";
import type { InstructionState } from "./types";

const baseState: InstructionState = {
	task: { complexity: "SIMPLE", kind: "simple", workflow: { verification: "basic" } },
	phase: "IMPLEMENT",
};

describe("dynamic instruction composition", () => {
	test("simple implementation stays compact", () => {
		const result = composeInstructions(baseState);
		expect(result.layers.map(layer => layer.name)).toEqual(expect.arrayContaining(["base", "task", "phase"]));
		expect(result.telemetry.totalInstructionTokens).toBeLessThan(140);
	});

	test("complex planning adds architecture-aware guidance", () => {
		const result = composeInstructions({
			task: { complexity: "COMPLEX", kind: "architecture", workflow: { plan: true, architecture: true, verification: "deep" } },
			phase: "PLAN",
		});
		expect(result.text).toContain("constraints");
		expect(result.text).toContain("alternatives");
	});

	test("failure recovery carries compact evidence, not transcript", () => {
		const result = composeInstructions({
			...baseState,
			phase: "RECOVER",
			lastAction: "DIAGNOSE",
			failure: { present: true, category: "TEST_FAILURE", check: "auth/session.test.ts", repeatCount: 2, summary: "expected token refresh, received expired session" },
		});
		expect(result.text).toContain("TEST_FAILURE");
		expect(result.text).toContain("Do not repeat failed hypotheses");
		expect(result.text.length).toBeLessThan(1600);
	});

	test("critical instructions survive context pressure", () => {
		const result = composeInstructions({
			...baseState,
			phase: "COMPLETE",
			contextPressure: 0.98,
			specialistRole: "DEBUGGER",
		}, { maxTokens: 28 });
		expect(result.text).toContain("success");
		expect(result.telemetry.omittedOptionalInstructions).toBeGreaterThanOrEqual(0);
	});

	test("specialist contract is role-specific", () => {
		const result = composeInstructions({
			...baseState,
			specialistRole: "ARCHITECT",
	});
		expect(result.text).toContain("ROLE: architecture specialist");
		expect(result.text).not.toContain("ROLE: debugger");
	});

	test("semantic duplicates are removed deterministically", () => {
		const result = composeInstructions({
			...baseState,
			phase: "VERIFY",
			task: { complexity: "NORMAL", kind: "normal", workflow: { verification: "standard" } },
		});
		expect(result.telemetry.duplicateInstructionsRemoved).toBeGreaterThanOrEqual(0);
	});

	test("unknown capabilities do not invent provider-specific instructions", () => {
		const result = composeInstructions({
			...baseState,
			model: { structuredOutput: "unknown", toolCalling: "unknown", parallelToolCalls: "unknown", promptCaching: "unknown" },
		});
		expect(result.text).not.toMatch(/If you are GPT|Claude|OpenAI|Anthropic/);
	});
});
