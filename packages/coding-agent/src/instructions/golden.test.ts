import { describe, expect, test } from "bun:test";
import { composeInstructions } from "./compose";

function render(state: Parameters<typeof composeInstructions>[0]): string {
	return composeInstructions(state, { countTokens: text => Math.ceil(text.length / 4) }).text;
}

describe("golden dynamic instruction contracts", () => {
	test("SIMPLE + IMPLEMENT", () => {
		const text = render({ task: { complexity: "SIMPLE", kind: "simple" }, phase: "IMPLEMENT" });
		expect(text).toContain("[base]");
		expect(text).toContain("[task]");
		expect(text).toContain("[phase]");
		expect(text).toContain("Avoid unrelated edits.");
		expect(text).not.toContain("Compare viable alternatives.");
	});

	test("NORMAL + IMPLEMENT", () => {
		const text = render({ task: { complexity: "NORMAL", kind: "normal" }, phase: "IMPLEMENT" });
		expect(text).toContain("Inspect relevant context before editing.");
		expect(text).toContain("Follow existing patterns");
	});

	test("COMPLEX + PLAN", () => {
		const text = render({ task: { complexity: "COMPLEX", kind: "architecture", workflow: { plan: true, architecture: true } }, phase: "PLAN" });
		expect(text).toContain("Identify constraints.");
		expect(text).toContain("Compare viable alternatives.");
		expect(text).toContain("Define the implementation approach and key risks.");
	});

	test("COMPLEX + VERIFY", () => {
		const text = render({ task: { complexity: "COMPLEX", kind: "normal", workflow: { verification: "deep" } }, phase: "VERIFY", verification: { state: "PENDING" } });
		expect(text).toContain("Treat verification evidence as authoritative.");
		expect(text).toContain("verification gate");
	});

	test("FAILED + DIAGNOSE", () => {
		const text = render({
			task: { complexity: "NORMAL", kind: "debugging" },
			phase: "RECOVER",
			lastAction: "DIAGNOSE",
			failure: { present: true, category: "TEST_FAILURE", check: "auth/session.test.ts", repeatCount: 1, summary: "expected refresh, received expired session" },
		});
		expect(text).toContain("Failure category: TEST_FAILURE.");
		expect(text).toContain("Diagnose the likely root cause before repairing it.");
	});

	test("FAILED + REPAIR", () => {
		const text = render({
			task: { complexity: "COMPLEX", kind: "debugging" },
			phase: "RECOVER",
			lastAction: "REPAIR",
			failure: { present: true, category: "TYPE_ERROR", repeatCount: 1, summary: "property token is missing" },
		});
		expect(text).toContain("Make a targeted correction; do not restart the whole task.");
	});

	test("VERY_COMPLEX + REVIEW", () => {
		const text = render({ task: { complexity: "VERY_COMPLEX", kind: "complex" }, phase: "REVIEW" });
		expect(text).toContain("Check requirements, changed scope, and verification evidence.");
		expect(text).toContain("Look for regressions");
	});

	test("SPECIALIST + DEBUGGER", () => {
		const text = render({ task: { complexity: "NORMAL", kind: "debugging" }, phase: "RECOVER", specialistRole: "DEBUGGER" });
		expect(text).toContain("ROLE: debugger");
		expect(text).toContain("ROOT-CAUSE");
		expect(text).not.toContain("ROLE: architecture specialist");
	});

	test("SPECIALIST + ARCHITECT", () => {
		const text = render({ task: { complexity: "COMPLEX", kind: "architecture" }, phase: "PLAN", specialistRole: "ARCHITECT" });
		expect(text).toContain("ROLE: architecture specialist");
		expect(text).toContain("OPTIONS");
	});
});
