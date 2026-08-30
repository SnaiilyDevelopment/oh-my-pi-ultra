import { projectToolResult, createToolIntelligenceTelemetry, recordToolIntelligence } from "../src/tool-intelligence";
import type { AgentMessage } from "../src/types";

function result(toolName: string, text: string, details: Record<string, unknown> = {}, isError = false): AgentMessage {
	return { role: "toolResult", toolCallId: `${toolName}-1`, toolName, content: [{ type: "text", text }], details, isError } as AgentMessage;
}

function body(message: AgentMessage): string {
	const content = (message as unknown as { content?: unknown }).content;
	return Array.isArray(content) ? content.filter(block => block && typeof block === "object" && (block as { type?: string }).type === "text").map(block => String((block as { text?: unknown }).text ?? "")).join("\n") : "";
}

export interface ToolIntelligenceBenchmarkRow {
	name: string;
	rawBytes: number;
	modelFacingBytes: number;
	compressionRatio: number;
	projectionLatencyMs: number;
	informationRetained: boolean;
}

export function runToolIntelligenceBenchmark(): ToolIntelligenceBenchmarkRow[] {
	const samples: Array<[string, AgentMessage, unknown]> = [
		["shell", result("bash", `${"build noise\\n".repeat(8000)}error: src/auth/session.ts:143 timeout`, { exitCode: 1, wallTimeMs: 412.3 }, true), { command: "bun run build" }],
		["test", result("bash", `${"pass\\n".repeat(4000)}18 passed, 1 failed, 2 skipped\\nFAIL src/auth/session.test.ts:143 expected 401 received 200`, {}, true), { command: "bun test" }],
		["search", result("grep", Array.from({ length: 600 }, (_, i) => `src/auth/session-${i}.ts: ${i % 3 === 0 ? "match" : "context"}`).join("\\n"), { matchCount: 200, fileCount: 60, fileMatches: [{ path: "src/auth/session.ts", count: 14 }] }), { pattern: "session" }],
		["read", result("read", `export function session() { return true; }\\n${"source detail\\n".repeat(2000)}`), { path: "src/auth/session.ts" }],
	];
	return samples.map(([name, sample, params]) => {
		const telemetry = createToolIntelligenceTelemetry();
		const projected = projectToolResult(sample, String(sample.toolName ?? name), params, sample);
		recordToolIntelligence(telemetry, name, projected.meta);
		const projectedMessage = { ...sample, content: projected.content } as AgentMessage;
		const rawBytes = projected.meta.rawBytes;
		const modelFacingBytes = Buffer.byteLength(body(projectedMessage), "utf8");
		const bodyText = body(projectedMessage);
		const informationRetained = name === "shell" ? bodyText.includes("src/auth/session.ts") && bodyText.includes("exit: 1") : name === "test" ? bodyText.includes("1 failed") && bodyText.includes("401") : name === "search" ? bodyText.includes("matches: 200") && bodyText.includes("src/auth/session.ts") : bodyText.includes("source detail");
		return { name, rawBytes, modelFacingBytes, compressionRatio: rawBytes ? modelFacingBytes / rawBytes : 1, projectionLatencyMs: projected.meta.projectionLatencyMs, informationRetained };
	});
}

if (import.meta.main) {
	console.log(JSON.stringify(runToolIntelligenceBenchmark(), null, 2));
}
