import { describe, expect, test } from "bun:test";
import { projectToolResult } from "../src/tool-intelligence";
import type { AgentMessage } from "../src/types";

function result(text: string, details: Record<string, unknown> = {}, isError = false): AgentMessage {
	return { role: "toolResult", toolCallId: "tc", toolName: "test", content: [{ type: "text", text }], details, isError } as AgentMessage;
}

function text(message: AgentMessage): string {
	return ((message as unknown as { content: Array<{ type?: string; text?: string }> }).content ?? []).filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

const tool = {};

describe("tool intelligence", () => {
	test("small shell output remains essentially unchanged", () => {
		const source = result("hello\nworld");
		const projected = projectToolResult(tool, "bash", { command: "printf hello" }, source);
		expect(projected.projected).toBe(false);
		expect(text({ ...source, content: projected.content } as AgentMessage)).toBe("hello\nworld");
	});

	test("large shell output keeps exit/errors/paths while projecting", () => {
		const large = `${"noise\\n".repeat(7000)}error: src/auth/session.ts:143 unexpected status\nwarning: src/auth/config.ts deprecated\nfinal line`;
		const projected = projectToolResult(tool, "bash", { command: "npm run build" }, result(large, { exitCode: 1, wallTimeMs: 123.4 }, true));
		const body = text({ role: "toolResult", content: projected.content } as AgentMessage);
		expect(projected.projected).toBe(true);
		expect(projected.meta.state).toBe("FAILURE");
		expect(projected.meta.importance).toBe("CRITICAL");
		expect(body).toContain("exit: 1");
		expect(body).toContain("src/auth/session.ts");
		expect(body).toContain("errors:");
	});

	test("test failure extracts counts and primary failure location", () => {
		const source = result("18 passed, 1 failed, 2 skipped\nFAIL src/auth/session.test.ts:143 expected 401 received 200\nstack noise" , {}, true);
		const projected = projectToolResult(tool, "bash", { command: "bun test" }, source);
		const body = text({ role: "toolResult", content: projected.content } as AgentMessage);
		expect(projected.meta.projection).toBe("test");
		expect(projected.meta.state).toBe("FAILURE");
		expect(body).toContain("18 passed");
		expect(body).toContain("1 failed");
		expect(body).toContain("src/auth/session.test.ts");
		expect(body).toContain("expected 401 received 200");
	});

	test("compiler output retains codes, diagnostics, and locations", () => {
		const source = result("src/auth/session.ts:87 - error TS2322: Type string is not assignable to type number\nsrc/auth/session.ts:91 - error TS2339: Property token does not exist", {}, true);
		const projected = projectToolResult(tool, "bash", { command: "tsgo --noEmit" }, source);
		const body = text({ role: "toolResult", content: projected.content } as AgentMessage);
		expect(projected.meta.projection).toBe("compiler");
		expect(body).toContain("TS2322");
		expect(body).toContain("TS2339");
		expect(body).toContain("src/auth/session.ts");
	});

	test("git projection keeps branch and conflict state", () => {
		const source = result("## feature/auth\nUU packages/auth/src/session.ts\nM packages/web/src/app.ts\n");
		const projected = projectToolResult(tool, "bash", { command: "git status --short --branch" }, source);
		const body = text({ role: "toolResult", content: projected.content } as AgentMessage);
		expect(projected.meta.projection).toBe("git");
		expect(body).toContain("feature/auth");
		expect(body).toContain("UU packages/auth/src/session.ts");
	});

	test("search projection uses existing structured match details", () => {
		const source = result("src/auth/session.ts:143: expected\nsrc/auth/session.test.ts:55: expected", { matchCount: 24, fileCount: 3, fileMatches: [{ path: "src/auth/session.ts", count: 14 }, { path: "src/auth/session.test.ts", count: 8 }, { path: "src/other.ts", count: 2 }] });
		const projected = projectToolResult(tool, "grep", { pattern: "expected", path: "src" }, source);
		const body = text({ role: "toolResult", content: projected.content } as AgentMessage);
		expect(projected.meta.projection).toBe("search");
		expect(body).toContain("matches: 24");
		expect(body).toContain("src/auth/session.ts: 14");
	});

	test("large glob output surfaces count and useful paths", () => {
		const source = result(Array.from({ length: 200 }, (_, i) => `packages/pkg-${i}/src/index.ts`).join("\n"));
		const projected = projectToolResult(tool, "glob", { pattern: "packages/*/src/*.ts" }, source);
		const body = text({ role: "toolResult", content: projected.content } as AgentMessage);
		expect(projected.projected).toBe(true);
		expect(body).toContain("matches: 200");
		expect(body).toContain("packages/pkg-0/src/index.ts");
	});

	test("file-read-like results are not silently summarized", () => {
		const source = result("line 1\nline 2\n" + "source code ".repeat(4000));
		const projected = projectToolResult(tool, "read", { path: "src/auth/session.ts" }, source);
		expect(projected.projected).toBe(false);
		expect(text({ role: "toolResult", content: projected.content } as AgentMessage)).toBe(text(source));
	});

	test("artifact reference remains visible when existing spill metadata provides recovery", () => {
		const source = result("large output", { meta: { truncation: { artifactId: "42" } } });
		const projected = projectToolResult(tool, "bash", { command: "cat log" }, source);
		expect(projected.meta.fullOutputAvailable).toBe(true);
		expect(projected.meta.fullOutputArtifactId).toBe("42");
	});

	test("different output is never treated as unchanged", () => {
		const first = result("git status clean");
		const second = result("git status\nM src/auth/session.ts");
		const firstProjection = projectToolResult(tool, "bash", { command: "git status" }, first);
		const secondProjection = projectToolResult(tool, "bash", { command: "git status" }, second);
		expect(firstProjection.meta.duplicate).toBe(false);
		expect(secondProjection.meta.duplicate).toBe(false);
		expect(text({ role: "toolResult", content: secondProjection.content } as AgentMessage)).toContain("src/auth/session.ts");
	});
});
