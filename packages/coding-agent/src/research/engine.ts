import { fetchReadUrl } from "../tools/fetch";
import type { ToolSession } from "../tools";
import { runSearchQuery, type SearchQueryParams } from "../web/search";
import type { SearchResponse } from "../web/search/types";
import { readResearchCache, writeResearchCache } from "./cache";
import { crossCheckEvidence, compactResearchResult, extractEvidence } from "./extract";
import { buildResearchQueries } from "./query";
import { rankSearchSources } from "./sources";
import { sanitizeExternalText, sanitizeResearchQuery } from "./security";
import type { ResearchLocalEvidence, ResearchObjective, ResearchResult, ResearchSource, ResearchTelemetry, ResearchDecision } from "./types";

interface SearchDetails { response?: SearchResponse; }

function cacheKey(objective: ResearchObjective, query: string): string {
	return JSON.stringify({ question: objective.question, version: objective.question.match(/\b\d+(?:\.\d+){0,2}\b/)?.[0] ?? null, query });
}

function mapResponseSources(response: SearchResponse, objective: ResearchObjective, local?: ResearchLocalEvidence): ResearchSource[] {
	const requiredTerms = objective.question.split(/[^a-z0-9.+_-]+/i).filter(value => value.length > 2).slice(0, 10);
	return rankSearchSources(response.sources, { version: local?.version, requiredTerms });
}

function finalConfidence(result: ResearchResult): ResearchTelemetry["finalConfidence"] {
	if (result.conflicts.length > 0) return "medium";
	if (result.evidence.some(item => item.confidence === "high")) return "high";
	if (result.evidence.some(item => item.confidence === "medium")) return "medium";
	return "low";
}

export async function runAutonomousResearch(session: ToolSession, objective: ResearchObjective, local?: ResearchLocalEvidence, decision: ResearchDecision = objective.maxQueries > 2 ? "DEEP_RESEARCH" : "TARGETED_RESEARCH"): Promise<{ result: ResearchResult; telemetry: ResearchTelemetry }> {
	const started = performance.now();
	const queries = buildResearchQueries(objective, local).slice(0, objective.maxQueries);
	if (queries.length === 0) {
		const result: ResearchResult = { decision: "BLOCKED", objective, query: "", evidence: [], sources: [], conflicts: [], compact: "Research blocked: no safe external query could be constructed.", fullSourceRefs: [], failure: "TOOL_FAILURE" };
		return { result, telemetry: { decision: "BLOCKED", requested: true, reason: "query sanitization produced no usable query", queries: 0, sources: 0, pagesRead: 0, researchTokens: 0, latencyMs: performance.now() - started, cacheHits: 0, retries: 0, conflicts: 0, finalConfidence: "low", changedStrategy: false, preventedError: false, unnecessaryCost: false } };
	}
	let cacheHits = 0, retries = 0, pagesRead = 0, researchTokens = 0;
	let sources: ResearchSource[] = [];
	let evidence: ReturnType<typeof extractEvidence>[] = [];
	const fullSourceRefs: string[] = [];
	let usedQuery = "";
	for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
		if (performance.now() - started > objective.maxElapsedTimeMs) break;
		const query = sanitizeResearchQuery(queries[queryIndex]!);
		if (!query || query === usedQuery) continue;
		usedQuery = query;
		const cached = await readResearchCache(cacheKey(objective, query));
		if (cached) {
			cacheHits += 1;
			return { result: cached, telemetry: { decision: cached.decision, requested: true, reason: "fresh research cache hit", queries: queryIndex + 1, sources: cached.sources.length, pagesRead: 0, researchTokens: 0, latencyMs: performance.now() - started, cacheHits, retries, conflicts: cached.conflicts.length, finalConfidence: finalConfidence(cached), changedStrategy: false, preventedError: false, unnecessaryCost: false } };
		}
		try {
			const params: SearchQueryParams = { query, limit: Math.min(objective.maxSources * 2, 12), num_search_results: Math.min(objective.maxSources * 2, 12), max_tokens: Math.min(objective.maxTotalTokens, 3000) };
			const search = await runSearchQuery(params, { authStorage: session.authStorage, modelRegistry: session.modelRegistry, sessionId: session.getSessionId?.() ?? undefined });
			const response = (search.details as SearchDetails | undefined)?.response;
			if (!response || response.sources.length === 0) continue;
			researchTokens += response.usage?.totalTokens ?? response.usage?.outputTokens ?? response.usage?.inputTokens ?? 0;
			sources = [...sources, ...mapResponseSources(response, objective, local)].filter((source, index, all) => all.findIndex(item => item.url === source.url) === index).slice(0, objective.maxSources);
		} catch {
			retries += 1;
		}
	}
	if (sources.length === 0) {
		const result: ResearchResult = { decision: "BLOCKED", objective, query: sanitizeResearchQuery(objective.question), evidence: [], sources: [], conflicts: [], compact: "Research could not retrieve trustworthy external evidence within the configured budget.", fullSourceRefs, failure: retries > 0 ? "TOOL_FAILURE" : "NO_RESULTS" };
		return { result, telemetry: { decision: "BLOCKED", requested: true, reason: "no usable external search results within budget", queries: queries.length, sources: 0, pagesRead, researchTokens, latencyMs: performance.now() - started, cacheHits, retries, conflicts: 0, finalConfidence: "low", changedStrategy: false, preventedError: false, unnecessaryCost: false } };
	}
	for (const source of sources.slice(0, objective.maxPages)) {
		if (pagesRead >= objective.maxPages || performance.now() - started > objective.maxElapsedTimeMs) break;
		try {
			const remaining = Math.max(1000, objective.maxElapsedTimeMs - Math.floor(performance.now() - started));
			const page = await fetchReadUrl(session, { path: source.url }, AbortSignal.timeout(remaining), { ensureArtifact: true });
			pagesRead += 1;
			if (page.artifactPath) fullSourceRefs.push(page.artifactPath);
			evidence.push(extractEvidence(objective.question, source, page.content, local?.version));
		} catch {
			evidence.push(extractEvidence(objective.question, source, source.snippet ?? "", local?.version));
		}
	}
	const checked = crossCheckEvidence(evidence);
	if (checked.verified.length === 0) {
		const result: ResearchResult = { decision: "BLOCKED", objective, query: sanitizeResearchQuery(usedQuery || objective.question), evidence: [], sources, conflicts: checked.conflicts, compact: "Research retrieved sources but no usable evidence could be extracted.", fullSourceRefs, failure: "SOURCE_UNAVAILABLE" };
		return { result, telemetry: { decision: "BLOCKED", requested: true, reason: "source extraction produced no evidence", queries: queries.length, sources: sources.length, pagesRead, researchTokens, latencyMs: performance.now() - started, cacheHits, retries, conflicts: checked.conflicts.length, finalConfidence: "low", changedStrategy: false, preventedError: false, unnecessaryCost: false } };
	}
	const boundedEvidence = checked.verified.slice(0, objective.maxSources).map(item => ({ ...item, repositoryImplication: "Use this external evidence only for the unresolved fact; current repository tests and implementation remain authoritative for local behavior." }));
	const result: ResearchResult = { decision, objective, query: sanitizeExternalText(usedQuery || objective.question, 500), evidence: boundedEvidence, sources: sources.slice(0, objective.maxSources), conflicts: checked.conflicts, compact: compactResearchResult(objective.question, boundedEvidence, checked.conflicts), fullSourceRefs };
	await writeResearchCache(cacheKey(objective, usedQuery || objective.question), result).catch(() => undefined);
	return { result, telemetry: { decision: result.decision, requested: true, reason: "external evidence required by deterministic policy", queries: queries.length, sources: result.sources.length, pagesRead, researchTokens, latencyMs: performance.now() - started, cacheHits, retries, conflicts: result.conflicts.length, finalConfidence: finalConfidence(result), changedStrategy: result.conflicts.length > 0, preventedError: false, unnecessaryCost: false } };
}
