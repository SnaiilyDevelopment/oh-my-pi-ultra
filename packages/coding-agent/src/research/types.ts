import type { TaskClassification } from "@oh-my-pi/pi-agent-core";

export type ResearchDecision = "NO_RESEARCH" | "TARGETED_RESEARCH" | "DEEP_RESEARCH" | "BLOCKED";
export type ResearchConfidence = "low" | "medium" | "high";
export type ResearchSourceType = "official-docs" | "official-repo" | "release-notes" | "standard" | "maintainer" | "technical-reference" | "community" | "general-web";
export type ResearchFailure = "NETWORK_FAILURE" | "SOURCE_UNAVAILABLE" | "RATE_LIMIT" | "NO_RESULTS" | "CONFLICTING_SOURCES" | "VERSION_MISMATCH" | "TOOL_FAILURE";

export interface ResearchObjective {
	question: string;
	whyNeeded: string;
	requiredEvidence: string[];
	preferredSources: string[];
	maxSources: number;
	maxSearchDepth: number;
	maxQueries: number;
	maxPages: number;
	maxTotalTokens: number;
	maxElapsedTimeMs: number;
}

export interface ResearchLocalEvidence {
	repositorySufficient: boolean;
	memorySufficient: boolean;
	unresolvedFacts: string[];
	framework?: string;
	packageName?: string;
	version?: string;
	api?: string;
	error?: string;
}

export interface ResearchSource {
	title: string;
	url: string;
	sourceType: ResearchSourceType;
	score: number;
	relevance: number;
	authority: number;
	versionMatch: number;
	recency: number;	specificity: number;
	duplicate: boolean;
	published?: string;
	snippet?: string;
}

export interface ResearchEvidence {
	claim: string;
	evidence: string;
	source: ResearchSource;
	relevantSection?: string;
	version?: string;
	published?: string;
	confidence: ResearchConfidence;
	repositoryImplication?: string;
}

export interface ResearchConflict {
	topic: string;
	claims: Array<{ claim: string; source: ResearchSource }>;
}

export interface ResearchResult {
	decision: ResearchDecision;
	objective: ResearchObjective;
	query: string;
	evidence: ResearchEvidence[];
	sources: ResearchSource[];
	conflicts: ResearchConflict[];
	compact: string;
	fullSourceRefs: string[];
	failure?: ResearchFailure;
}

export interface ResearchBudget {
	maxQueries: number;
	maxSources: number;
	maxPages: number;
	maxDepth: number;
	maxTotalTokens: number;
	maxElapsedTimeMs: number;
}

export interface ResearchTelemetry {
	decision: ResearchDecision;
	requested: boolean;
	reason: string;
	queries: number;
	sources: number;
	pagesRead: number;
	researchTokens: number;
	latencyMs: number;
	cacheHits: number;
	retries: number;
	conflicts: number;
	finalConfidence: ResearchConfidence;
	changedStrategy: boolean;
	preventedError: boolean;
	unnecessaryCost: boolean;
}

export interface ResearchState {
	classification?: TaskClassification;
	objective?: ResearchObjective;
	decision: ResearchDecision;
	attempts: number;
	queryFingerprints: string[];
	cacheHits: number;
	lastResult?: ResearchResult;
}
