import type { SearchSource } from "../web/search/types";
import type { ResearchSource, ResearchSourceType } from "./types";

const OFFICIAL_DOC_HINTS = [/^docs\./i, /(^|\.)developer\./i, /(^|\.)typescriptlang\.org$/i, /(^|\.)react\.dev$/i, /(^|\.)nextjs\.org$/i, /(^|\.)bun\.sh$/i, /(^|\.)nodejs\.org$/i, /(^|\.)openai\.com$/i, /(^|\.)anthropic\.com$/i];
const OFFICIAL_REPO = /(^|\.)github\.com\//i;
const RELEASE = /releas|changelog|migration|upgrade/i;
const STANDARD = /(^|\.)ietf\.org$|(^|\.)w3\.org$|(^|\.)ecma-international\.org$|(^|\.)unicode\.org$/i;
const COMMUNITY = /stackoverflow|reddit|discussion|medium|dev\.to/i;

function host(url: string): string {
	try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function sourceType(url: string, title: string): ResearchSourceType {
	const h = host(url);
	if (STANDARD.test(h)) return "standard";
	if (OFFICIAL_REPO.test(h)) return RELEASE.test(title) ? "release-notes" : "official-repo";
	if (OFFICIAL_DOC_HINTS.some(re => re.test(h)) || /documentation|docs|api reference/i.test(title)) return RELEASE.test(title) ? "release-notes" : "official-docs";
	if (COMMUNITY.test(h)) return "community";
	if (/release|changelog|migration/i.test(title)) return "release-notes";
	return "general-web";
}

function versionScore(text: string, version?: string): number {
	if (!version) return 0.5;
	const major = version.match(/\d+(?:\.\d+){0,2}/)?.[0];
	if (!major) return 0.5;
	return text.includes(major) ? 1 : 0.25;
}

export function rankSearchSources(sources: readonly SearchSource[], options: { version?: string; preferredHosts?: string[]; requiredTerms?: string[] } = {}): ResearchSource[] {
	const preferred = new Set((options.preferredHosts ?? []).map(value => value.toLowerCase()));
	const seen = new Set<string>();
	return sources.map(source => {
		const url = source.url.trim();
		const title = source.title.trim();
		const h = host(url);
		const type = sourceType(url, title);
		const authority = preferred.has(h) ? 1 : type === "official-docs" || type === "official-repo" ? 0.95 : type === "release-notes" || type === "standard" ? 0.9 : type === "maintainer" ? 0.8 : type === "technical-reference" ? 0.65 : type === "community" ? 0.35 : 0.2;
		const terms = (options.requiredTerms ?? []).filter(term => term && `${title} ${source.snippet ?? ""} ${url}`.toLowerCase().includes(term.toLowerCase()));
		const relevance = options.requiredTerms?.length ? terms.length / options.requiredTerms.length : 0.7;
		const versionMatch = versionScore(`${title} ${source.snippet ?? ""}`, options.version);
		const recency = source.ageSeconds == null ? 0.5 : Math.max(0, Math.min(1, 1 - source.ageSeconds / (365 * 24 * 3600)));
		const specificity = Math.min(1, 0.4 + title.length / 160);
		const duplicate = seen.has(url.split(/[?#]/)[0].replace(/\/$/, ""));
		seen.add(url.split(/[?#]/)[0].replace(/\/$/, ""));
		const score = authority * 0.30 + relevance * 0.28 + versionMatch * 0.18 + recency * 0.08 + specificity * 0.16 - (duplicate ? 0.5 : 0);
		return { title, url, sourceType: type, score, relevance, authority, versionMatch, recency, specificity, duplicate, published: source.publishedDate, snippet: source.snippet };
	}).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}
