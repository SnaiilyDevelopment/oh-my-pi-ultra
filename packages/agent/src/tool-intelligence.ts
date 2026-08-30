/** Deterministic high-signal projection for tool results. No execution, policy, or LLM summarization. */
import type { AgentMessage } from "./types";

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
export interface ToolResultProjection { content: AgentMessage["content"]; meta: ToolResultIntelligenceMeta; projected: boolean; }
export interface ToolIntelligenceTelemetry {
	calls: number;
	rawOutputBytes: number;
	modelFacingBytes: number;
	projectedCalls: number;
	projectionLatencyMs: number;
	duplicatesSuppressed: number;
	cacheHits: number;
	cacheMisses: number;
	fullOutputReferences: number;
	byTool: Record<string, { calls: number; rawOutputBytes: number; modelFacingBytes: number; projectedCalls: number; duplicatesSuppressed: number }>;
}

interface ResultLike { content: AgentMessage["content"]; details?: unknown; isError?: boolean; }
const cache = new WeakMap<object, { input: string; projection: ToolResultProjection }>();
const MEDIUM = 12 * 1024;
const LARGE = 32 * 1024;
const HUGE = 128 * 1024;
const EXCERPTS = 8;
const textOf = (r: ResultLike) => r.content.filter((x): x is Extract<AgentMessage["content"][number], { type: "text" }> => x.type === "text").map(x => x.text).join("\n");
const rec = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const details = (r: ResultLike) => rec(r.details);
const meta = (r: ResultLike) => rec(details(r).meta);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const command = (params: unknown) => params && typeof params === "object" && typeof (params as Record<string, unknown>).command === "string" ? String((params as Record<string, unknown>).command) : undefined;
const envInt = (name: string, fallback: number) => { const n = Number.parseInt(process.env[name] ?? "", 10); return Number.isFinite(n) && n > 0 ? n : fallback; };

function kindFor(tool: string, params: unknown): ToolProjectionKind {
	const name = tool.toLowerCase();
	if (name === "grep" || name === "search") return "search";
	if (name === "glob") return "glob";
	if (name !== "bash" && name !== "shell") return "none";
	const c = command(params) ?? "";
	if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|jest)\b|\b(?:pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)\b/i.test(c)) return "test";
	if (/\b(?:tsc|tsgo|typecheck|check:types|cargo\s+(?:check|clippy)|go\s+(?:build|vet)|javac|kotlinc|rustc)\b/i.test(c)) return "compiler";
	if (/\bgit\s+(?:status|diff|show|log|branch|rev-parse)\b/i.test(c)) return "git";
	return "shell";
}
function stateFor(r: ResultLike, kind: ToolProjectionKind): ToolResultState {
	const d = details(r), text = textOf(r);
	if (d.timedOut === true) return "TIMEOUT";
	if (d.blocked === true) return "BLOCKED";
	if (d.cancelled === true || d.interrupted === true) return "INTERRUPTED";
	if (r.isError === true) return "FAILURE";
	if (kind === "test" && /\b\d+\s+failed\b|\bFAIL(?:ED|URE)\b/i.test(text)) return "FAILURE";
	if (kind === "compiler" && /\b(?:error\s*(?:TS\d+|E\d+)?|type error|compilation failed)\b/i.test(text)) return "FAILURE";
	if (/\bwarning\b|\bWARN(?:ING)?:/i.test(text)) return "WARNING";
	if (!text.trim() && r.content.every(x => x.type !== "text")) return "NO_OUTPUT";
	return "SUCCESS";
}
function paths(text: string): string[] {
	return [...new Set((text.match(/(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|\b(?:src|test|tests|packages|apps|lib|server|client|api|config)\/)[^\s:'"`()[\],]+/g) ?? []).map(x => x.replace(/[),.;]+$/u, "")))].slice(0, EXCERPTS);
}
function lines(text: string, predicate: (line: string) => boolean, limit = EXCERPTS): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) { const value = line.trim(); if (value && predicate(value)) out.push(value); if (out.length >= limit) break; }
	return out;
}
function count(text: string, word: string): number | undefined {
	const match = text.match(new RegExp(`(?:^|\\b)(\\d+)\\s+${word}\\b`, "i")) ?? text.match(new RegExp(`${word}[^\\d]{0,20}(\\d+)`, "i"));
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}
function artifactId(r: ResultLike): string | undefined { const value = meta(r).truncation; const id = rec(value).artifactId; return typeof id === "string" ? id : undefined; }
function isFailureState(state: ToolResultState): boolean { return ["FAILURE", "TIMEOUT", "BLOCKED"].includes(state); }
function projectShell(text: string, state: ToolResultState, r: ResultLike, params: unknown): string {
	if (bytes(text) < envInt("PI_TOOL_INTELLIGENCE_LARGE_BYTES", LARGE) && state === "SUCCESS") return text;
	const errorLines = lines(text, x => /\b(?:error|failed|failure|exception|fatal|panic|traceback)\b/i.test(x));
	const warnings = lines(text, x => /\b(?:warning|warn(?:ing)?:)\b/i.test(x));
	const recent = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(-EXCERPTS);
	return [`COMMAND ${state}`, command(params) ? `command: ${command(params)}` : undefined, typeof details(r).exitCode === "number" ? `exit: ${details(r).exitCode}` : undefined, typeof details(r).wallTimeMs === "number" ? `duration: ${Number(details(r).wallTimeMs).toFixed(1)}ms` : undefined, errorLines.length ? `errors:\n${errorLines.join("\n")}` : undefined, warnings.length ? `warnings:\n${warnings.join("\n")}` : undefined, paths([...errorLines, ...warnings].join("\n")).length ? `paths: ${paths([...errorLines, ...warnings].join("\n")).join(", ")}` : undefined, recent.length ? `recent output:\n${recent.join("\n")}` : undefined].filter(Boolean).join("\n");
}
function projectTest(text: string, state: ToolResultState, r: ResultLike, params: unknown): string {
	const passed = count(text, "passed"), failed = count(text, "failed"), skipped = count(text, "skipped");
	const failures = lines(text, x => /(?:^|\s)(?:FAIL|FAILED|ERROR|✕|×)\b|\bexpected\b.*\b(?:received|actual)\b/i.test(x));
	return [`TEST ${state}`, command(params) ? `command: ${command(params)}` : undefined, [passed !== undefined ? `${passed} passed` : undefined, failed !== undefined ? `${failed} failed` : undefined, skipped !== undefined ? `${skipped} skipped` : undefined].filter(Boolean).join(", ") || undefined, failures.length ? `primary failures:\n${failures.join("\n")}` : undefined, paths(failures.join("\n")).length ? `locations: ${paths(failures.join("\n")).join(", ")}` : undefined].filter(Boolean).join("\n");
}
function projectCompiler(text: string, state: ToolResultState): string {
	const diagnostics = lines(text, x => /\bTS\d{3,5}\b|\berror(?:\[[A-Z]\d+\])?:|\bwarning(?:\[[A-Z]\d+\])?:|\btype .* is not assignable\b/i.test(x));
	const codes = [...new Set(text.match(/\bTS\d{3,5}\b|\b[A-Z]\d{3,5}\b/g) ?? [])].slice(0, EXCERPTS);
	return [`COMPILER ${state}`, `errors: ${diagnostics.filter(x => /\berror\b|TS\d+/i.test(x)).length}`, codes.length ? `codes: ${codes.join(", ")}` : undefined, diagnostics.length ? `diagnostics:\n${diagnostics.join("\n")}` : undefined, paths(diagnostics.join("\n")).length ? `locations: ${paths(diagnostics.join("\n")).join(", ")}` : undefined].filter(Boolean).join("\n");
}
function projectGit(text: string, state: ToolResultState): string {
	const all = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
	const branch = all.find(x => /^##\s+/.test(x))?.replace(/^##\s+/, "");
	const conflicts = all.filter(x => /^(?:UU|AA|DD|AU|UA)\s|\bCONFLICT\b/i.test(x)).slice(0, EXCERPTS);
	const changed = all.filter(x => /^(?:[ MADRCU?]{1,2})\s+/.test(x)).slice(0, EXCERPTS);
	return [`GIT ${state}`, branch ? `branch: ${branch}` : undefined, conflicts.length ? `conflicts:\n${conflicts.join("\n")}` : undefined, changed.length ? `changed files:\n${changed.join("\n")}` : undefined].filter(Boolean).join("\n");
}
function projectSearch(text: string, r: ResultLike): string {
	const d = details(r); const matchCount = typeof d.matchCount === "number" ? d.matchCount : undefined; const fileCount = typeof d.fileCount === "number" ? d.fileCount : undefined;
	const grouped = Array.isArray(d.fileMatches) ? d.fileMatches.slice(0, 10).map(item => { const v = rec(item); return `${String(v.path ?? "?")}: ${String(v.count ?? "?")}`; }) : [];
	const top = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 10);
	return [`SEARCH ${matchCount === 0 ? "EMPTY" : "RESULTS"}`, matchCount !== undefined ? `matches: ${matchCount}` : undefined, fileCount !== undefined ? `files: ${fileCount}` : undefined, grouped.length ? `grouped matches:\n${grouped.join("\n")}` : undefined, top.length ? `top matches:\n${top.join("\n")}` : undefined].filter(Boolean).join("\n");
}
function projectGlob(text: string): string {
	const values = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
	if (values.length <= 10 && bytes(text) < MEDIUM) return text;
	return [`GLOB ${values.length ? "RESULTS" : "EMPTY"}`, `matches: ${values.length}`, values.slice(0, 10).join("\n")].filter(Boolean).join("\n");
}
function importance(state: ToolResultState, kind: ToolProjectionKind, text: string, r: ResultLike): ToolResultImportance {
	if (isFailureState(state)) return "CRITICAL";
	if (kind === "test" || kind === "compiler") return "HIGH";
	if (kind === "search" && (typeof details(r).matchCount === "number" ? Number(details(r).matchCount) > 0 : false)) return "HIGH";
	if (kind === "git" && /\b(?:conflict|unmerged)\b/i.test(text)) return "CRITICAL";
	return bytes(text) >= envInt("PI_TOOL_INTELLIGENCE_HUGE_BYTES", HUGE) ? "LOW" : bytes(text) >= MEDIUM ? "MEDIUM" : "LOW";
}

export function projectToolResult(tool: object, toolName: string, params: unknown, result: AgentMessage): ToolResultProjection {
	const started = performance.now();
	const r = result as AgentMessage & ResultLike;
	const text = textOf(r); const kind = kindFor(toolName, params); const state = stateFor(r, kind);
	const input = `${toolName}\n${JSON.stringify(params ?? null)}\n${text}`;
	const previous = cache.get(tool);
	if (previous?.input === input) return previous.projection;
	const digest = artifactId(r);
	let projectedText = text; let projected = false;
	if (kind === "shell") { projectedText = projectShell(text, state, r, params); projected = projectedText !== text; }
	else if (kind === "test") { projectedText = isFailureState(state) || bytes(text) >= LARGE ? projectTest(text, state, r, params) : text; projected = projectedText !== text; }
	else if (kind === "compiler") { projectedText = projectCompiler(text, state); projected = isFailureState(state) || bytes(text) >= MEDIUM; }
	else if (kind === "git") { projectedText = bytes(text) >= MEDIUM || isFailureState(state) ? projectGit(text, state) : text; projected = projectedText !== text; }
	else if (kind === "search") { projectedText = bytes(text) >= MEDIUM ? projectSearch(text, r) : text; projected = projectedText !== text; }
	else if (kind === "glob") { projectedText = projectGlob(text); projected = projectedText !== text; }
	const meta: ToolResultIntelligenceMeta = { importance: importance(state, kind, text, r), state, projection: kind, rawBytes: bytes(text), projectedBytes: bytes(projectedText), compressionRatio: bytes(text) > 0 ? bytes(projectedText) / bytes(text) : 1, projectionLatencyMs: performance.now() - started, duplicate: false, fullOutputAvailable: Boolean(digest), fullOutputArtifactId: digest };
	const projection: ToolResultProjection = { content: projected ? [{ type: "text", text: projectedText }] : result.content, meta, projected };
	cache.set(tool, { input, projection });
	return projection;
}

export function createToolIntelligenceTelemetry(): ToolIntelligenceTelemetry { return { calls: 0, rawOutputBytes: 0, modelFacingBytes: 0, projectedCalls: 0, projectionLatencyMs: 0, duplicatesSuppressed: 0, cacheHits: 0, cacheMisses: 0, fullOutputReferences: 0, byTool: {} }; }
export function recordToolIntelligence(telemetry: ToolIntelligenceTelemetry, toolName: string, meta: ToolResultIntelligenceMeta, duplicate = false): void {
	const item = telemetry.byTool[toolName] ?? { calls: 0, rawOutputBytes: 0, modelFacingBytes: 0, projectedCalls: 0, duplicatesSuppressed: 0 };
	item.calls++; item.rawOutputBytes += meta.rawBytes; item.modelFacingBytes += duplicate ? 0 : meta.projectedBytes; item.projectedCalls += meta.compressionRatio < 0.999 || duplicate ? 1 : 0; item.duplicatesSuppressed += duplicate ? 1 : 0; telemetry.byTool[toolName] = item;
	telemetry.calls++; telemetry.rawOutputBytes += meta.rawBytes; telemetry.modelFacingBytes += duplicate ? 0 : meta.projectedBytes; telemetry.projectedCalls += meta.compressionRatio < 0.999 || duplicate ? 1 : 0; telemetry.duplicatesSuppressed += duplicate ? 1 : 0; telemetry.projectionLatencyMs += meta.projectionLatencyMs; if (meta.fullOutputAvailable) telemetry.fullOutputReferences++;
}
