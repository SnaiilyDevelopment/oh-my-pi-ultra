import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getMemoryRoot } from "./index";

export const MEMORY_CATEGORIES = [
	"ARCHITECTURE",
	"CONVENTION",
	"DECISION",
	"ENVIRONMENT",
	"KNOWN_FAILURE",
	"WORKFLOW",
	"TOOLING",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryScope = "PROJECT" | "WORKSPACE" | "SUBSYSTEM" | "SESSION";
export type MemoryTrust = "UNVERIFIED" | "OBSERVED" | "VERIFIED" | "CONFIRMED";
export type MemoryFreshness = "stable" | "recently_validated" | "aging" | "stale" | "invalid";
export type MemoryCandidateRejection =
	| "temporary"
	| "obvious"
	| "speculative"
	| "duplicate"
	| "stale"
	| "session_scope"
	| "sensitive"
	| "insufficient_trust"
	| "empty";

export interface MemoryItem {
	id: string;
	type: MemoryCategory;
	content: string;
	source: string;
	scope: Exclude<MemoryScope, "SESSION">;
	confidence: number;
	createdAt: number;
	updatedAt: number;
	lastValidatedAt: number;
	repositoryFingerprint: string;
	relevance: number;
	trust: MemoryTrust;
	canonicalKey: string;
	contradictionKey: string;
	evidenceCount: number;
	validatedCount: number;
	invalidatedAt?: number;
}

export interface MemoryCandidate {
	type: MemoryCategory;
	content: string;
	source: string;
	scope: MemoryScope;
	confidence: number;
	trust: MemoryTrust;
	relevance: number;
	repositoryFingerprint: string;
	verified?: boolean;
	confirmed?: boolean;
}

export interface MemoryStoreLimits {
	maxItems?: number;
	maxItemsPerCategory?: number;
	maxContentChars?: number;
}

export interface MemoryRetrievalOptions {
	limit?: number;
	budgetTokens?: number;
	includeObserved?: boolean;
}

export interface MemoryTelemetry {
	candidates: number;
	accepted: number;
	rejected: number;
	deduplicated: number;
	updated: number;
	invalidated: number;
	retrieved: number;
	notRetrieved: number;
	validationEvents: number;
	memoryContextTokens: number;
	lookupLatencyMs: number;
	storageLatencyMs: number;
	degraded: boolean;
	rejectionReasons: Record<string, number>;
}

export interface MemoryQueryResult {
	items: MemoryItem[];
	telemetry: Pick<MemoryTelemetry, "retrieved" | "notRetrieved" | "memoryContextTokens" | "lookupLatencyMs">;
}

interface MemoryDocument {
	version: 1;
	projectRoot: string;
	updatedAt: number;
	items: MemoryItem[];
}

const DEFAULT_MAX_ITEMS = 128;
const DEFAULT_MAX_ITEMS_PER_CATEGORY = 32;
const DEFAULT_MAX_CONTENT_CHARS = 1600;
const TRUST_RANK: Record<MemoryTrust, number> = { UNVERIFIED: 0, OBSERVED: 1, VERIFIED: 2, CONFIRMED: 3 };

const SECRET_RE = /(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY|password\s*[:=]|api[_ -]?key\s*[:=]|authorization\s*:\s*bearer)/i;
const TEMP_RE = /\b(?:this session|this task|for now|temporarily|temporary|currently editing|current scratch|one-off|just for this|today only)\b/i;
const SPECULATIVE_RE = /\b(?:maybe|might|possibly|probably|i think|i suspect|seems like|could be|likely)\b/i;
const OBVIOUS_RE = /^(?:the project|the repo|this project)\s+(?:has|uses)\s+(?:source code|files|a repository)$/i;
const NON_DURABLE_RE = /\b(?:TODO|FIXME|WIP|debug print|console\.log\(|temporary hack)\b/i;

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`*_>#:[\]{}(),.;!?]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenize(text: string): string[] {
	return normalize(text)
		.split(" ")
		.filter(token => token.length >= 3)
		.filter(token => !["the", "and", "for", "with", "from", "that", "this", "uses", "use", "project", "repo"].includes(token));
}

function canonicalFact(content: string, type: MemoryCategory): { canonicalKey: string; contradictionKey: string } {
	const value = normalize(content);
	let match = value.match(/\btests?\s+(?:use|run with)\s+([a-z0-9_.@/-]+)/i);
	if (match) return { canonicalKey: `testing-framework:${match[1]}`, contradictionKey: "testing-framework" };
	match = value.match(/\b(?:project|repo|repository)\s+uses\s+([a-z0-9_.@/-]+)/i);
	if (match) return { canonicalKey: `tooling:${match[1]}`, contradictionKey: "project-tooling" };
	match = value.match(/\b(?:use|prefer)\s+([a-z0-9_.@/-]+)\s+(?:not|instead of)\s+([a-z0-9_.@/-]+)/i);
	if (match) return { canonicalKey: `preference:${match[1]}`, contradictionKey: `preference:${match[1]}` };
	match = value.match(/\bnever\s+(?:edit|modify|change)\s+(.+)/i);
	if (match) return { canonicalKey: `instruction:never-edit:${normalize(match[1])}`, contradictionKey: `instruction:never-edit:${normalize(match[1])}` };
	match = value.match(/\b(?:database|db)\s*(?:is|=)\s*([a-z0-9_.@/-]+)/i);
	if (match) return { canonicalKey: `database:${match[1]}`, contradictionKey: "database" };
	const compact = tokenize(value).join(" ");
	return { canonicalKey: `${type.toLowerCase()}:${compact}`, contradictionKey: `${type.toLowerCase()}:${compact}` };
}

function safeContent(content: string, maxChars: number): string {
	return content.replace(/[\\u0000-\\u001f\\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function scoreTrust(trust: MemoryTrust): number { return TRUST_RANK[trust]; }

function freshness(item: MemoryItem, currentFingerprint: string, now: number): MemoryFreshness {
	if (item.invalidatedAt) return "invalid";
	if (item.repositoryFingerprint === currentFingerprint) {
		const ageDays = (now - item.lastValidatedAt) / 86_400_000;
		return ageDays <= 7 ? "recently_validated" : "stable";
	}
	if (item.type === "ENVIRONMENT" || item.type === "TOOLING" || item.type === "WORKFLOW") return "stale";
	const ageDays = (now - item.lastValidatedAt) / 86_400_000;
	return ageDays <= 45 ? "aging" : "stale";
}

function itemScore(item: MemoryItem, queryTerms: string[], currentFingerprint: string, scopeBonus: number, now: number): number {
	const text = `${item.content} ${item.type} ${item.scope}`.toLowerCase();
	let hits = 0;
	for (const term of queryTerms) if (text.includes(term)) hits += 1;
	const lexical = queryTerms.length ? Math.min(1, hits / Math.min(8, queryTerms.length)) : 0;
	const trust = scoreTrust(item.trust) / 3;
	const valid = freshness(item, currentFingerprint, now);
	const fresh = valid === "recently_validated" ? 1 : valid === "stable" ? 0.9 : valid === "aging" ? 0.6 : 0.2;
	const specificity = item.scope === "SUBSYSTEM" ? 0.25 : item.scope === "WORKSPACE" ? 0.15 : 0.08;
	return lexical * 5 + trust * 2.5 + fresh * 1.8 + item.relevance * 1.3 + specificity * scopeBonus;
}

function chooseEvictions(items: MemoryItem[], limits: Required<MemoryStoreLimits>): MemoryItem[] {
	const byCategory = new Map<MemoryCategory, MemoryItem[]>();
	for (const item of items) {
		const list = byCategory.get(item.type) ?? [];
		list.push(item);
		byCategory.set(item.type, list);
	}
	const kept: MemoryItem[] = [];
	for (const list of byCategory.values()) {
		list.sort((a, b) =>
			(scoreTrust(b.trust) - scoreTrust(a.trust)) ||
			(b.evidenceCount - a.evidenceCount) ||
			(b.relevance - a.relevance) ||
			(b.lastValidatedAt - a.lastValidatedAt) ||
			(b.updatedAt - a.updatedAt) ||
			a.id.localeCompare(b.id),
		);
		kept.push(...list.slice(0, limits.maxItemsPerCategory));
	}
	kept.sort((a, b) =>
		(scoreTrust(b.trust) - scoreTrust(a.trust)) ||
		(b.evidenceCount - a.evidenceCount) ||
		(b.relevance - a.relevance) ||
		(b.lastValidatedAt - a.lastValidatedAt) ||
		(b.updatedAt - a.updatedAt) ||
		a.id.localeCompare(b.id),
	);
	return kept.slice(0, limits.maxItems);
}

export function validateMemoryCandidate(candidate: MemoryCandidate, maxContentChars = DEFAULT_MAX_CONTENT_CHARS): { accepted: true; content: string } | { accepted: false; reason: MemoryCandidateRejection } {
	const content = safeContent(candidate.content, maxContentChars);
	if (!content) return { accepted: false, reason: "empty" };
	if (candidate.scope === "SESSION") return { accepted: false, reason: "session_scope" };
	if (SECRET_RE.test(content) || SECRET_RE.test(candidate.source)) return { accepted: false, reason: "sensitive" };
	if (TEMP_RE.test(content) || NON_DURABLE_RE.test(content)) return { accepted: false, reason: "temporary" };
	if (SPECULATIVE_RE.test(content)) return { accepted: false, reason: "speculative" };
	if (OBVIOUS_RE.test(content)) return { accepted: false, reason: "obvious" };
	if (candidate.trust === "UNVERIFIED" && !candidate.confirmed && !candidate.verified) return { accepted: false, reason: "insufficient_trust" };
	return { accepted: true, content };
}

export class ProjectMemoryStore {
	private readonly limits: Required<MemoryStoreLimits>;
	private document: MemoryDocument | undefined;
	private loaded = false;
	private readonly filePath: string;
	private readonly projectRoot: string;

	constructor(filePath: string, projectRoot: string, limits: MemoryStoreLimits = {}) {
		this.filePath = filePath;
		this.projectRoot = projectRoot;
		this.limits = {
			maxItems: limits.maxItems ?? DEFAULT_MAX_ITEMS,
			maxItemsPerCategory: limits.maxItemsPerCategory ?? DEFAULT_MAX_ITEMS_PER_CATEGORY,
			maxContentChars: limits.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS,
		};
	}

	private async load(): Promise<MemoryDocument> {
		if (this.loaded && this.document) return this.document;
		this.loaded = true;
		try {
			const raw = await fs.readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<MemoryDocument>;
			if (parsed.version !== 1 || !Array.isArray(parsed.items)) throw new Error("invalid memory document");
			this.document = { version: 1, projectRoot: this.projectRoot, updatedAt: Number(parsed.updatedAt ?? Date.now()), items: parsed.items as MemoryItem[] };
		} catch {
			this.document = { version: 1, projectRoot: this.projectRoot, updatedAt: Date.now(), items: [] };
		}
		return this.document;
	}

	private async persist(): Promise<number> {
		const started = performance.now();
		const document = await this.load();
		document.updatedAt = Date.now();
		document.items = chooseEvictions(document.items, this.limits);
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		await fs.writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
		await fs.rename(temp, this.filePath);
		return performance.now() - started;
	}

	async list(): Promise<MemoryItem[]> {
		const document = await this.load();
		return [...document.items];
	}

	async addCandidate(candidate: MemoryCandidate): Promise<{ accepted: boolean; action: "stored" | "updated" | "deduplicated" | "invalidated" | "rejected"; reason?: MemoryCandidateRejection; item?: MemoryItem; storageLatencyMs: number }> {
		const checked = validateMemoryCandidate(candidate, this.limits.maxContentChars);
		if (!checked.accepted) return { accepted: false, action: "rejected", reason: checked.reason, storageLatencyMs: 0 };
		const document = await this.load();
		const now = Date.now();
		const content = checked.content;
		const facts = canonicalFact(content, candidate.type);
		const existing = document.items.filter(item => !item.invalidatedAt && (item.canonicalKey === facts.canonicalKey || item.contradictionKey === facts.contradictionKey));
		const exact = existing.find(item => normalize(item.content) === normalize(content));
		if (exact) {
			exact.evidenceCount += 1;
			exact.updatedAt = now;
			exact.lastValidatedAt = TRUST_RANK[candidate.trust] >= TRUST_RANK.VERIFIED ? now : exact.lastValidatedAt;
			exact.validatedCount += TRUST_RANK[candidate.trust] >= TRUST_RANK.VERIFIED ? 1 : 0;
			if (TRUST_RANK[candidate.trust] > TRUST_RANK[exact.trust] || exact.evidenceCount >= 2) exact.trust = TRUST_RANK[candidate.trust] > TRUST_RANK[exact.trust] ? candidate.trust : "VERIFIED";
			exact.confidence = Math.max(exact.confidence, candidate.confidence);
			exact.relevance = Math.max(exact.relevance, candidate.relevance);
			const storageLatencyMs = await this.persist();
			return { accepted: true, action: "deduplicated", item: exact, storageLatencyMs };
		}
		let action: "stored" | "updated" | "invalidated" = "stored";
		for (const item of existing) {
			if (item.canonicalKey === facts.canonicalKey && normalize(item.content) !== normalize(content) && TRUST_RANK[candidate.trust] >= TRUST_RANK.VERIFIED) {
				item.invalidatedAt = now;
				action = "invalidated";
			}
		}
		const item: MemoryItem = {
			id: createHash("sha256").update(`${candidate.type}|${facts.canonicalKey}|${content}|${now}`).digest("hex").slice(0, 16),
			type: candidate.type,
			content,
			source: safeContent(candidate.source, 300),
			scope: candidate.scope as Exclude<MemoryScope, "SESSION">,
			confidence: Math.max(0, Math.min(1, candidate.confidence)),
			createdAt: now,
			updatedAt: now,
			lastValidatedAt: TRUST_RANK[candidate.trust] >= TRUST_RANK.VERIFIED ? now : 0,
			repositoryFingerprint: candidate.repositoryFingerprint,
			relevance: Math.max(0, Math.min(1, candidate.relevance)),
			trust: candidate.trust,
			canonicalKey: facts.canonicalKey,
			contradictionKey: facts.contradictionKey,
			evidenceCount: 1,
			validatedCount: TRUST_RANK[candidate.trust] >= TRUST_RANK.VERIFIED ? 1 : 0,
		};
		document.items.push(item);
		const storageLatencyMs = await this.persist();
		return { accepted: true, action: action === "stored" ? "stored" : action, item, storageLatencyMs };
	}

	async invalidateByCanonical(canonicalKey: string): Promise<number> {
		const document = await this.load();
		let count = 0;
		const now = Date.now();
		for (const item of document.items) if (!item.invalidatedAt && item.canonicalKey === canonicalKey) { item.invalidatedAt = now; count++; }
		if (count > 0) await this.persist();
		return count;
	}

	async reconcileRepositoryFacts(facts: MemoryCandidate[]): Promise<number> {
		let invalidated = 0;
		for (const fact of facts) {
			const checked = validateMemoryCandidate(fact, this.limits.maxContentChars);
			if (!checked.accepted) continue;
			const key = canonicalFact(checked.content, fact.type);
			invalidated += await this.invalidateByCanonical(key.contradictionKey);
			await this.addCandidate({ ...fact, content: checked.content, trust: "VERIFIED", verified: true });
		}
		return invalidated;
	}

	async query(task: string, currentFingerprint: string, options: MemoryRetrievalOptions = {}): Promise<MemoryQueryResult> {
		const started = performance.now();
		const document = await this.load();
		const limit = Math.max(0, options.limit ?? 6);
		const budgetTokens = Math.max(256, options.budgetTokens ?? 1200);
		const terms = tokenize(task);
		const now = Date.now();
		const candidates = document.items
			.filter(item => !item.invalidatedAt)
			.filter(item => options.includeObserved ? TRUST_RANK[item.trust] >= TRUST_RANK.OBSERVED : TRUST_RANK[item.trust] >= TRUST_RANK.VERIFIED)
			.filter(item => freshness(item, currentFingerprint, now) !== "invalid")
			.map(item => ({ item, score: itemScore(item, terms, currentFingerprint, 1, now) }))
			.filter(row => row.score > 0.4 || terms.length === 0)
			.sort((a, b) => b.score - a.score || b.item.lastValidatedAt - a.item.lastValidatedAt || a.item.id.localeCompare(b.item.id));
		const selected: MemoryItem[] = [];
		let chars = 0;
		for (const row of candidates) {
			if (selected.length >= limit) break;
			const next = chars + row.item.content.length + 80;
			if (Math.ceil(next / 4) > budgetTokens) continue;
			selected.push(row.item);
			chars = next;
		}
		const memoryContextTokens = Math.ceil(chars / 4);
		return {
			items: selected,
			telemetry: {
				retrieved: selected.length,
				notRetrieved: Math.max(0, candidates.length - selected.length),
				memoryContextTokens,
				lookupLatencyMs: performance.now() - started,
			},
		};
	}

	async inspect(currentFingerprint: string): Promise<Array<MemoryItem & { freshness: MemoryFreshness }>> {
		const now = Date.now();
		return (await this.list()).map(item => ({ ...item, freshness: freshness(item, currentFingerprint, now) }));
	}
}

export function projectMemoryFilePath(agentDir: string, cwd: string): string {
	return path.join(getMemoryRoot(agentDir, cwd), "project-memory.json");
}

export async function projectFingerprint(cwd: string): Promise<string> {
	const root = path.resolve(cwd);
	let head = "nogit";
	try {
		const git = Bun.spawnSync(["git", "-C", root, "rev-parse", "--verify", "HEAD"]);
		if (git.exitCode === 0) head = new TextDecoder().decode(git.stdout).trim() || head;
	} catch {}
	return createHash("sha256").update(`${root}\0${head}`).digest("hex").slice(0, 24);
}

export function renderProjectMemory(items: readonly MemoryItem[]): string {
	if (items.length === 0) return "";
	const labels: Record<MemoryTrust, string> = {
		UNVERIFIED: "unverified",
		OBSERVED: "observed",
		VERIFIED: "verified",
		CONFIRMED: "confirmed",
	};
	const grouped = new Map<MemoryCategory, MemoryItem[]>();
	for (const item of items) (grouped.get(item.type) ?? (grouped.set(item.type, []), grouped.get(item.type)!)).push(item);
	const lines = ["[Project Memory]"];
	for (const category of MEMORY_CATEGORIES) {
		const categoryItems = grouped.get(category);
		if (!categoryItems?.length) continue;
		lines.push(`${category}:`);
		for (const item of categoryItems) lines.push(`- ${item.content} [${labels[item.trust]}]`);
	}
	return lines.join("\n");
}
