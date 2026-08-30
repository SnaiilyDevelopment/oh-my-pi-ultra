/**
 * Deterministic model-facing tool-result intelligence.
 *
 * This module never executes tools, never changes tool schemas, and never asks
 * a model to summarize output. It parses result text/details at the existing
 * tool-result boundary and returns either the original content or a compact
 * high-signal projection. Full-output recovery remains owned by the existing
 * artifact:// mechanism in output-meta.ts.
 */
import { createHash } from "node:crypto";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

export type ToolResultImportance = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ToolResultState = "SUCCESS" | "WARNING" | "FAILURE" | "TIMEOUT" | "INTERRUPTED" | "BLOCKED" | "NO_OUTPUT" | "UNKNOWN";
export type ToolProjectionKind = "none" | "shell" | "test" | "compiler" | "git" | "search" | "glob";

export interface ToolResultIntelligenceMeta {
	importance: ToolResultImportance;
	state: ToolResultState;
	projection: ToolProjectionKind;
	rawBytes: number;
	projectedBytes: number;
	compressionRatio: number;
	projectionLatencyMs: number;
	duplicate: boolean;
	fullOutputAvailable: boolean;
	fullOutputArtifactId?: string;
}

export interface ToolResultProjection {
	content: Array<TextContent | ImageContent>;
	meta: ToolResultIntelligenceMeta;
	projected: boolean;
}

export interface ToolIntelligenceTelemetry {
	calls: number;
	rawOutputBytes: number;
	modelFacingBytes: number;
	projectedCalls: number;
	projectionLatencyMs: number;
	duplicatesSuppressed: number;
	cacheHits: number;
	cacheMisses: number;
	fullOutputRetrievals: number;
	byTool: Record<string, {
		calls: number;
		rawOutputBytes: number;
		modelFacingBytes: number;
		projectedCalls: number;
		duplicatesSuppressed: number;
	}>;
}

interface ResultLike {
	content: Array<TextContent | ImageContent>;
	details?: unknown;
	isError?: boolean;
}

interface ProjectionCacheEntry {
	inputHash: string;
	projection: ToolResultProjection;
}

interface DuplicateState {
	lastHash?: string;
	lastProjection?: ToolResultProjection;
}

const cache = new WeakMap<object, ProjectionCacheEntry>();
const duplicateState = new WeakMap<object, DuplicateState>();
const telemetryByTool = new WeakMap<object, ToolIntelligenceTelemetry>();

const DEFAULT_MEDIUM_BYTES = 12 * 1024;
const DEFAULT_LARGE_BYTES = 32 * 1024;
const DEFAULT_HUGE_BYTES = 128 * 1024;
const MAX_EXCERPTS = 8;
const MAX_SEARCH_MATCHES = 10;

function envPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function threshold(kind: "medium" | "large" | "huge"): number {
	switch (kind) {
		case "medium": return envPositiveInt("PI_TOOL_INTELLIGENCE_MEDIUM_BYTES", DEFAULT_MEDIUM_BYTES);
		case "large": return envPositiveInt("PI_TOOL_INTELLIGENCE_LARGE_BYTES", DEFAULT_LARGE_BYTES);
		case "huge": return envPositiveInt("PI_TOOL_INTELLIGENCE_HUGE_BYTES", DEFAULT_HUGE_BYTES);
	}
}

function textContent(result: ResultLike): string {
	return result.content.filter((item): item is TextContent => item.type === "text").map(item => item.text).join("\n");
}

function detailsRecord(result: ResultLike): Record<string, unknown> {
	return result.details && typeof result.details === "object" && !Array.isArray(result.details)
		? result.details as Record<string, unknown>
		: {};
}

function metaRecord(result: ResultLike): Record<string, unknown> {
	const meta = detailsRecord(result).meta;
	return meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function stableHash(toolName: string, params: unknown, text: string): string {
	return createHash("sha256").update(toolName).update("\n").update(JSON.stringify(params ?? null)).update("\n").update(text).digest("hex");
}

function commandFromParams(params: unknown): string | undefined {
	if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
	const command = (params as Record<string, unknown>).command;
	return typeof command === "string" ? command.trim() : undefined;
}

function classifyProjection(toolName: string, params: unknown): ToolProjectionKind {
	const name = toolName.toLowerCase();
	if (name === "grep" || name === "search") return "search";
	if (name === "glob") return "glob";
	if (name !== "bash" && name !== "shell") return "none";
	const command = commandFromParams(params)?.toLowerCase() ?? "";
	if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check:test|test:|vitest|jest)\b|\b(?:pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)\b/i.test(command)) return "test";
	if (/\b(?:tsc|tsgo|typecheck|check:types|cargo\s+(?:check|clippy)|go\s+(?:build|vet)|javac|kotlinc|rustc)\b/i.test(command)) return "compiler";
	if (/^(?:git\s+|.*\bgit\s+(?:status|diff|show|log|branch|rev-parse)\b)/i.test(command)) return "git";
	return "shell";
}

function extractLines(text: string, predicate: (line: string) => boolean, limit = MAX_EXCERPTS): string[] {
	const result: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || !predicate(trimmed)) continue;
		result.push(trimmed);
		if (result.length >= limit) break;
	}
	return result;
}

function pathsFrom(text: string, limit = MAX_EXCERPTS): string[] {
	const matches = text.match(/(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|\b(?:src|test|tests|packages|apps|lib|server|client|api|config)\/)[^\s:'"`()[\],]+/g) ?? [];
	return [...new Set(matches.map(value => value.replace(/[),.;]+$/u, "")))].slice(0, limit);
}

function stateFor(result: ResultLike, projection: ToolProjectionKind): ToolResultState {
	const details = detailsRecord(result);
	if (details.timedOut === true) return "TIMEOUT";
	if (details.blocked === true) return "BLOCKED";
	if (details.cancelled === true || details.interrupted === true) return "INTERRUPTED";
	if (result.isError === true) return "FAILURE";
	if (projection === "test" && /\b\d+\s+failed\b|\bFAIL(?:ED|URE)\b/i.test(textContent(result))) return "FAILURE";
	if (projection === "compiler" && /\b(?:error\s*(?:TS\d+|E\d+)?|type error|compilation failed)\b/i.test(textContent(result))) return "FAILURE";
	if (/\b(?:warning|warn(?:ing)?:)\b/i.test(textContent(result))) return "WARNING";
	if (!textContent(result).trim() && result.content.every(item => item.type !== "text")) return "NO_OUTPUT";
	return "SUCCESS";
}

function importanceFor(state: ToolResultState, projection: ToolProjectionKind, params: unknown, text: string, result: ResultLike): ToolResultImportance {
	if (state === "FAILURE" || state === "TIMEOUT" || state === "BLOCKED") return "CRITICAL";
	if (projection === "test" || projection === "compiler") return "HIGH";
	if (projection === "git" && /\b(?:conflict|unmerged|UU|AA|DD)\b/i.test(text)) return "CRITICAL";
	if (projection === "search" && (detailsRecord(result).matchCount as number | undefined ?? 0) > 0) return "HIGH";
	if (commandFromParams(params)?.trim().toLowerCase() === "git status") return "MEDIUM";
	if (text.length >= threshold("huge")) return "LOW";
	return text.length >= threshold("medium") ? "MEDIUM" : "LOW";
}

function exitCode(result: ResultLike): number | undefined {
	const raw = detailsRecord(result).exitCode;
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function durationMs(result: ResultLike): number | undefined {
	const raw = detailsRecord(result).wallTimeMs;
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function artifactId(result: ResultLike): string | undefined {
	const truncation = metaRecord(result).truncation;
	if (!truncation || typeof truncation !== "object" || Array.isArray(truncation)) return undefined;
	const raw = (truncation as Record<string, unknown>).artifactId;
	return typeof raw === "string" ? raw : undefined;
}

function projectionResult(text: string, state: ToolResultState, projection: ToolProjectionKind, result: ResultLike, params: unknown): string {
	if (projection === "none") return text;
	if (projection === "shell") return shellProjection(text, state, result, params);
	if (projection === "test") return testProjection(text, state, result, params);
	if (projection === "compiler") return compilerProjection(text, state, result);
	if (projection === "git") return gitProjection(text, state, result);
	if (projection === "search") return searchProjection(text, result);
	return globProjection(text, result);
}

function shellProjection(text: string, state: ToolResultState, result: ResultLike, params: unknown): string {
	if (text.length < threshold("medium") && state === "SUCCESS") return text;
	const command = commandFromParams(params);
	const exit = exitCode(result);
	const duration = durationMs(result);
	const errors = extractLines(text, line => /\b(?:error|failed|failure|exception|fatal|panic|traceback)\b/i.test(line));
	const warnings = extractLines(text, line => /\b(?:warning|warn(?:ing)?:)\b/i.test(line));
	const paths = pathsFrom(`${errors.join("\n")}\n${warnings.join("\n")}`);
	const recent = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-MAX_EXCERPTS);
	const lines = [
		`COMMAND ${state}`,
		command ? `command: ${command}` : undefined,
		exit === undefined ? undefined : `exit: ${exit}`,
		duration === undefined ? undefined : `duration: ${duration.toFixed(1)}ms`,
		errors.length ? `errors: ${errors.join(" | ")}` : undefined,
		warnings.length ? `warnings: ${warnings.join(" | ")}` : undefined,
		paths.length ? `paths: ${paths.join(", ")}` : undefined,
		recent.length ? `recent output:\n${recent.join("\n")}` : undefined,
	].filter((line): line is string => Boolean(line));
	return lines.join("\n");
}

function parseCounts(text: string, word: string): number | undefined {
	const patterns = [
		new RegExp(`(?:^|\\b)(\\d+)\\s+${word}\\b`, "i"),
		new RegExp(`${word}[^\\d]{0,24}(\\d+)`, "i"),
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match) return Number.parseInt(match[1]!, 10);
	}
	return undefined;
}

function testProjection(text: string, state: ToolResultState, result: ResultLike, params: unknown): string {
	const passed = parseCounts(text, "passed");
	const failed = parseCounts(text, "failed");
	const skipped = parseCounts(text, "skipped");
	const failures = extractLines(text, line => /(?:^|\s)(?:FAIL|FAILED|ERROR|✕|×)\b|\bexpected\b.*\b(received|actual)\b/i.test(line));
	const locations = pathsFrom(failures.join("\n"));
	const lines = [
		`TEST ${state}`,
		commandFromParams(params) ? `command: ${commandFromParams(params)}` : undefined,
		[passed !== undefined ? `${passed} passed` : undefined, failed !== undefined ? `${failed} failed` : undefined, skipped !== undefined ? `${skipped} skipped` : undefined].filter(Boolean).join(", ") || undefined,
		failures.length ? `primary failures:\n${failures.join("\n")}` : undefined,
		locations.length ? `locations: ${locations.join(", ")}` : undefined,
	].filter((line): line is string => Boolean(line));
	return lines.join("\n");
}

function compilerProjection(text: string, state: ToolResultState, result: ResultLike): string {
	const diagnostics = extractLines(text, line => /\bTS\d{3,5}\b|\berror(?:\[[A-Z]\d+\])?:\b|\bwarning(?:\[[A-Z]\d+\])?:\b|\btype .* is not assignable\b/i.test(line));
	const codes = [...new Set((text.match(/\bTS\d{3,5}\b|\b[A-Z]\d{3,5}\b/g) ?? []))].slice(0, MAX_EXCERPTS);
	const locations = pathsFrom(diagnostics.join("\n"));
	return [
		`COMPILER ${state}`,
		`errors: ${diagnostics.filter(line => /\berror\b|TS\d+/i.test(line)).length}`,
		codes.length ? `codes: ${codes.join(", ")}` : undefined,
		diagnostics.length ? `diagnostics:\n${diagnostics.join("\n")}` : undefined,
		locations.length ? `locations: ${locations.join(", ")}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n");
}

function gitProjection(text: string, state: ToolResultState, result: ResultLike): string {
	const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	const branch = lines.find(line => /^##\s+/.test(line))?.replace(/^##\s+/, "");
	const conflicts = lines.filter(line => /^UU\s|^AA\s|^DD\s|^AU\s|^UA\s|CONFLICT\b/i.test(line));
	const changes = lines.filter(line => /^(?:[ MADRCU?]{1,2})\s+/.test(line) || /^(?:M|A|D|R|C)\s+/.test(line)).slice(0, MAX_EXCERPTS);
	const diffMeta = extractLines(text, line => /^(?:diff --git|@@|\+\+\+|---)/.test(line), 4);
	return [
		`GIT ${state}`,
		branch ? `branch: ${branch}` : undefined,
		conflicts.length ? `conflicts: ${conflicts.join(" | ")}` : undefined,
		changes.length ? `changed files:\n${changes.join("\n")}` : undefined,
		diffMeta.length ? `diff metadata:\n${diffMeta.join("\n")}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n");
}

function searchProjection(text: string, result: ResultLike): string {
	const details = detailsRecord(result);
	const matchCount = typeof details.matchCount === "number" ? details.matchCount : undefined;
	const fileCount = typeof details.fileCount === "number" ? details.fileCount : undefined;
	const fileMatches = Array.isArray(details.fileMatches)
		? details.fileMatches.filter(item => item && typeof item === "object").slice(0, MAX_SEARCH_MATCHES).map(item => {
			const value = item as Record<string, unknown>;
			return `${String(value.path ?? "?")}: ${String(value.count ?? "?")}`;
		})
		: [];
	const excerpts = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, MAX_SEARCH_MATCHES);
	return [
		`SEARCH ${matchCount === 0 ? "EMPTY" : "RESULTS"}`,
		matchCount === undefined ? undefined : `matches: ${matchCount}`,
		fileCount === undefined ? undefined : `files: ${fileCount}`,
		fileMatches.length ? `grouped matches:\n${fileMatches.join("\n")}` : undefined,
		excerpts.length ? `top matches:\n${excerpts.join("\n")}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n");
}

function globProjection(text: string, result: ResultLike): string {
	const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	if (lines.length <= MAX_SEARCH_MATCHES && byteLength(text) < threshold("medium")) return text;
	const files = [...new Set(lines)].slice(0, MAX_SEARCH_MATCHES);
	return [`GLOB ${lines.length === 0 ? "EMPTY" : "RESULTS"}`, `matches: ${lines.length}`, files.length ? files.join("\n") : undefined].filter((line): line is string => Boolean(line)).join("\n");
}

function shouldProject(kind: ToolProjectionKind, state: ToolResultState, text: string, result: ResultLike): boolean {
	if (kind === "none") return false;
	if (kind === "search" || kind === "glob") return byteLength(text) >= threshold("medium");
	if (state === "FAILURE" || state === "TIMEOUT" || state === "BLOCKED") return true;
	return byteLength(text) >= threshold("large") || (kind === "compiler" && /\bTS\d{3,5}\b|\berror:/i.test(text));
}

function duplicateSuppressionEnabled(): boolean {
	return process.env.PI_TOOL_INTELLIGENCE_DUPLICATE_SUPPRESSION !== "0";
}

function isSafeDuplicateTool(toolName: string, params: unknown, projection: ToolProjectionKind, state: ToolResultState): boolean {
	if (!duplicateSuppressionEnabled() || state !== "SUCCESS") return false;
	if (projection === "search" || projection === "glob") return true;
	if (projection === "git") return /\bgit\s+(?:status|branch|rev-parse)\b/i.test(commandFromParams(params) ?? "");
	return false;
}

function emptyTelemetry(): ToolIntelligenceTelemetry {
	return { calls: 0, rawOutputBytes: 0, modelFacingBytes: 0, projectedCalls: 0, projectionLatencyMs: 0, duplicatesSuppressed: 0, cacheHits: 0, cacheMisses: 0, fullOutputRetrievals: 0, byTool: {} };
}

function telemetryFor(tool: object, name: string): ToolIntelligenceTelemetry {
	let telemetry = telemetryByTool.get(tool);
	if (!telemetry) { telemetry = emptyTelemetry(); telemetryByTool.set(tool, telemetry); }
	if (!telemetry.byTool[name]) telemetry.byTool[name] = { calls: 0, rawOutputBytes: 0, modelFacingBytes: 0, projectedCalls: 0, duplicatesSuppressed: 0 };
	return telemetry;
}

function applyTelemetry(telemetry: ToolIntelligenceTelemetry, toolName: string, rawBytes: number, projectedBytes: number, projected: boolean, duplicate: boolean, latency: number): void {
	const item = telemetry.byTool[toolName]!;
	telemetry.calls++;
	telemetry.rawOutputBytes += rawBytes;
	telemetry.modelFacingBytes += projectedBytes;
	telemetry.projectionLatencyMs += latency;
	if (projected) telemetry.projectedCalls++;
	if (duplicate) { telemetry.duplicatesSuppressed++; item.duplicatesSuppressed++; }
	item.calls++;
	item.rawOutputBytes += rawBytes;
	item.modelFacingBytes += projectedBytes;
	if (projected) item.projectedCalls++;
}

export function projectToolResult(tool: object, toolName: string, params: unknown, result: AgentToolResult): ToolResultProjection {
	const started = performance.now();
	const input = result as AgentToolResult & ResultLike;
	const text = textContent(input);
	const rawBytes = byteLength(text);
	const kind = classifyProjection(toolName, params);
	const state = stateFor(input, kind);
	const originalHash = stableHash(toolName, params, text);
	const fullArtifact = artifactId(input);
	const cached = cache.get(tool);
	if (cached?.inputHash === originalHash) {
		const projection = cached.projection;
		const telemetry = telemetryFor(tool, toolName);
		telemetry.cacheHits++;
		applyTelemetry(telemetry, toolName, rawBytes, byteLength(projection.content.filter(item => item.type === "text").map(item => item.text).join("\n")), projection.projected, projection.meta.duplicate, performance.now() - started);
		return projection;
	}
	const telemetry = telemetryFor(tool, toolName);
	telemetry.cacheMisses++;

	const previous = duplicateState.get(tool) ?? {};
	const duplicate = previous.lastHash === originalHash && isSafeDuplicateTool(toolName, params, kind, state);
	const should = shouldProject(kind, state, text, input);
	let projectedText = should ? projectionResult(text, state, kind, input, params) : text;
	if (duplicate) projectedText = state === "SUCCESS" ? "[unchanged since previous result]" : projectedText;
	const projectedBytes = byteLength(projectedText);
	const meta: ToolResultIntelligenceMeta = {
		importance: importanceFor(state, kind, params, text, input),
		state,
		projection: kind,
		rawBytes,
		projectedBytes,
		compressionRatio: rawBytes > 0 ? projectedBytes / rawBytes : 1,
		projectionLatencyMs: performance.now() - started,
		duplicate,
		fullOutputAvailable: Boolean(fullArtifact),
		fullOutputArtifactId: fullArtifact,
	};
	const projection: ToolResultProjection = {
		content: should || duplicate ? [{ type: "text", text: projectedText }] : input.content,
		meta,
		projected: should || duplicate,
	};
	cache.set(tool, { inputHash: originalHash, projection });
	duplicateState.set(tool, { lastHash: originalHash, lastProjection: projection });
	applyTelemetry(telemetry, toolName, rawBytes, projectedBytes, projection.projected, duplicate, performance.now() - started);
	return projection;
}

export function getToolIntelligenceTelemetry(tool: object): ToolIntelligenceTelemetry {
	const telemetry = telemetryByTool.get(tool);
	if (!telemetry) return emptyTelemetry();
	return {
		...telemetry,
		byTool: Object.fromEntries(Object.entries(telemetry.byTool).map(([name, value]) => [name, { ...value }])),
	};
}

export function resetToolIntelligenceTelemetry(tool: object): void {
	telemetryByTool.set(tool, emptyTelemetry());
}
