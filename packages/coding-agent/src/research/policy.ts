import type { OrchestrationState, TaskClassification } from "@oh-my-pi/pi-agent-core";
import type { ResearchDecision, ResearchLocalEvidence, ResearchObjective, ResearchState } from "./types";

const SECURITY = /\b(cve|vulnerability|security advisory|exploit|credential|authentication|authorization|sandbox|code execution|permission)\b/i;
const EXTERNAL = /\b(latest|current|official docs?|documentation|migration|release|upstream|external api|provider docs?|research|look ?up|compare|specification|standard)\b/i;
const UNFAMILIAR = /\b(unfamiliar|unknown|new framework|new library|new api|undocumented|not sure|unclear|what changed|breaking change)\b/i;
const LOCAL_ONLY = /\b(local only|repository only|no web|without research|offline)\b/i;

function rank(decision: ResearchDecision): number {
	return decision === "NO_RESEARCH" ? 0 : decision === "TARGETED_RESEARCH" ? 1 : decision === "DEEP_RESEARCH" ? 2 : 3;
}

export function researchDecision(task: string, classification?: TaskClassification, local?: ResearchLocalEvidence, orchestration?: OrchestrationState): ResearchDecision {
	const value = task.trim();
	if (!value || LOCAL_ONLY.test(value)) return "NO_RESEARCH";
	if (local?.repositorySufficient && local.memorySufficient && !EXTERNAL.test(value)) return "NO_RESEARCH";
	if (local?.repositorySufficient && local.memorySufficient && !local.unresolvedFacts.length && !EXTERNAL.test(value)) return "NO_RESEARCH";
	if (orchestration?.failure.present && orchestration.failure.category === "NETWORK_FAILURE") return "BLOCKED";
	const explicitExternal = EXTERNAL.test(value) || Boolean(classification?.signals.externalResearch);
	const security = SECURITY.test(value);
	const unfamiliar = UNFAMILIAR.test(value) || Boolean(classification?.signals.uncertain);
	const complex = classification?.complexity === "COMPLEX" || classification?.complexity === "VERY_COMPLEX";
	if (security && (!local?.repositorySufficient || !local.memorySufficient)) return "DEEP_RESEARCH";
	if (complex && unfamiliar) return "DEEP_RESEARCH";
	if (explicitExternal || unfamiliar || (classification?.complexity === "NORMAL" && !local?.repositorySufficient)) return "TARGETED_RESEARCH";
	return "NO_RESEARCH";
}

export function buildResearchObjective(task: string, decision: ResearchDecision, local?: ResearchLocalEvidence): ResearchObjective {
	const sanitized = task.replace(/\s+/g, " ").trim().slice(0, 500);
	const facts = local?.unresolvedFacts?.filter(Boolean).slice(0, 5) ?? [];
	const question = facts.length > 0 ? facts.join("; ") : sanitized;
	const deep = decision === "DEEP_RESEARCH";
	return {
		question,
		whyNeeded: deep ? "Local repository and durable memory do not contain enough trustworthy evidence for this higher-risk decision." : "A specific external fact is missing from local evidence and can affect the coding decision.",
		requiredEvidence: facts.length ? facts : ["authoritative statement answering the exact question"],
		preferredSources: security ? ["security advisory", "official documentation", "official repository", "release notes"] : ["official documentation", "official repository", "release notes", "standards/specifications"],
		maxSources: deep ? 6 : 3,
		maxSearchDepth: deep ? 2 : 1,
		maxQueries: deep ? 3 : 2,
		maxPages: deep ? 5 : 2,
		maxTotalTokens: deep ? 6000 : 2500,
		maxElapsedTimeMs: deep ? 25_000 : 12_000,
	};
}

export function initialResearchState(task: string, classification?: TaskClassification, local?: ResearchLocalEvidence, orchestration?: OrchestrationState): ResearchState {
	const decision = researchDecision(task, classification, local, orchestration);
	return {
		classification,
		objective: decision === "NO_RESEARCH" || decision === "BLOCKED" ? undefined : buildResearchObjective(task, decision, local),
		decision,
		attempts: 0,
		queryFingerprints: [],
		cacheHits: 0,
	};
}

export function shouldEscalateResearch(state: ResearchState, insufficientEvidence: boolean, conflictingSources: boolean): boolean {
	if (state.decision === "BLOCKED" || state.decision === "NO_RESEARCH") return false;
	if (state.attempts >= (state.objective?.maxQueries ?? 0)) return false;
	if (!insufficientEvidence && !conflictingSources) return false;
	if (state.decision === "TARGETED_RESEARCH" && (insufficientEvidence || conflictingSources)) {
		state.decision = "DEEP_RESEARCH";
		state.objective = { ...state.objective!, maxSources: 6, maxSearchDepth: 2, maxQueries: 3, maxPages: 5, maxTotalTokens: 6000, maxElapsedTimeMs: 25_000 };
		return true;
	}
	return true;
}

export function researchDecisionRank(value: ResearchDecision): number { return rank(value); }
