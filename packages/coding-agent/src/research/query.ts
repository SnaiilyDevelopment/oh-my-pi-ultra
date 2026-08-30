import type { ResearchLocalEvidence, ResearchObjective } from "./types";
import { sanitizeResearchQuery } from "./security";

function sourceQualifier(preferred: string[]): string {
	const value = preferred.find(item => item && !/security advisory/i.test(item));
	if (!value) return "";
	return /official|documentation|docs/i.test(value) ? "official" : value;
}

export function buildResearchQueries(objective: ResearchObjective, local?: ResearchLocalEvidence): string[] {
	const parts = [objective.question, local?.framework, local?.packageName, local?.version, local?.api, local?.error]
		.filter(Boolean)
		.map(value => sanitizeResearchQuery(String(value)));
	const primary = sanitizeResearchQuery(parts.filter(Boolean).slice(0, 5).join(" "));
	if (!primary) return [];
	const queries = [primary];
	const qualifier = sourceQualifier(objective.preferredSources);
	if (qualifier) queries.push(sanitizeResearchQuery(`${primary} ${qualifier}`));
	return [...new Set(queries)].slice(0, objective.maxQueries);
}
