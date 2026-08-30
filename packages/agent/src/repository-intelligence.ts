import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import type { TaskComplexity, TaskRepositorySignals } from "./task-router";

export const REPOSITORY_INTELLIGENCE_SCHEMA_VERSION = 1;
export const REPOSITORY_INTELLIGENCE_CACHE_ENV = "PI_REPOSITORY_CACHE";

export type RepositoryDirectoryKind =
	| "SOURCE"
	| "TEST"
	| "CONFIG"
	| "GENERATED"
	| "DEPENDENCY"
	| "DOCUMENTATION"
	| "BUILD_ARTIFACT"
	| "IGNORED"
	| "UNKNOWN";

export interface RepositoryEntryPoint {
	path: string;
	confidence: number;
	evidence: string;
}

export interface RepositoryWorkspacePackage {
	name: string;
	root: string;
	manifest?: string;
	packageManager?: string;
	scripts: Record<string, string>;
	dependencies: string[];
	devDependencies: string[];
}

export interface RepositoryGitState {
	branch?: string;
	dirty: boolean;
	changedFiles: string[];
	stagedFiles: string[];
	unstagedFiles: string[];
	untrackedFiles: string[];
	mergeRebaseState?: "MERGING" | "REBASING" | "CHERRY_PICKING" | "REVERTING" | "UNKNOWN";
}

export interface RepositoryFileRecord {
	path: string;
	kind: RepositoryDirectoryKind;
	extension?: string;
	size: number;
	mtimeMs: number;
	hash?: string;
}

export interface RepositoryDependencyEdge {
	from: string;
	to: string;
	kind: "import" | "require" | "dependency";
}

export interface RepositorySymbolRecord {
	name: string;
	path: string;
	line: number;
	kind: "function" | "class" | "interface" | "type" | "export" | "method" | "component" | "variable" | "unknown";
	source: "lsp" | "text";
}

export interface RepositorySymbolProvider {
	findSymbolDefinition?: (symbol: string) => Promise<RepositorySymbolRecord[]>;
	findSymbolReferences?: (symbol: string) => Promise<RepositorySymbolRecord[]>;
	indexFileSymbols?: (file: string) => Promise<RepositorySymbolRecord[]>;
}

export interface RepositoryProfile {
	identity: { root: string; name?: string; confidence: number; evidence: string[] };
	languages: string[];
	frameworks: string[];
	packageManager?: string;
	buildSystem: string[];
	testFramework: string[];
	entryPoints: RepositoryEntryPoint[];
	sourceRoots: string[];
	testRoots: string[];
	configFiles: string[];
	generatedDirectories: string[];
	ignoredDirectories: string[];
	importantDirectories: string[];
	workspacePackages: RepositoryWorkspacePackage[];
	gitState: RepositoryGitState;
	lastIndexedState: {
		indexedAt: number;
		headRevision?: string;
		structuralFingerprint: string;
		fileCount: number;
		cacheHit: boolean;
		invalidations: string[];
	};
}

export interface RepositoryQueryResult {
	facts: string[];
	files: string[];
	workspaces: string[];
	symbols: RepositorySymbolRecord[];
	confidence: number;
}

export interface RepositoryIntelligenceTelemetry {
	cacheHit: boolean;
	cacheMissReason?: string;
	initialIndexingTimeMs: number;
	incrementalIndexingTimeMs: number;
	filesIndexed: number;
	symbolsIndexed: number;
	dependencyEdges: number;
	invalidations: string[];
	fallbacks: string[];
	queries: number;
	queryLatencyMs: number;
	indexMode: "cache" | "incremental" | "full" | "fallback";
}

export interface RepositorySnapshot {
	root: string;
	files: string[];
	rootFiles: string[];
	packageManifests: Array<{ path: string; json: Record<string, unknown> }>;
	lockfiles: string[];
	configFiles: string[];
	branch?: string;
	git: RepositoryGitState;
	headRevision?: string;
}

export interface RepositoryIntelligenceOptions {
	root?: string;
	cache?: boolean;
	maxIndexedFiles?: number;
	symbolProvider?: RepositorySymbolProvider;
}

interface CachePayload {
	schemaVersion: number;
	profile: RepositoryProfile;
	files: RepositoryFileRecord[];
	dependencies: RepositoryDependencyEdge[];
	symbols: RepositorySymbolRecord[];
	structuralInputs: string[];
}

interface RepoCommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

const SOURCE_DIR_NAMES = new Set(["src", "app", "lib", "cmd", "server", "client", "api", "services"]);
const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const GENERATED_DIR_NAMES = new Set(["generated", "gen", ".next", ".nuxt", ".svelte-kit", "storybook-static", "codegen"]);
const BUILD_DIR_NAMES = new Set(["dist", "build", "out", "target", ".turbo", ".cache", "coverage", ".pytest_cache"]);
const DEPENDENCY_DIR_NAMES = new Set(["node_modules", "vendor", ".venv", "venv", ".tox"]);
const DOCUMENTATION_DIR_NAMES = new Set(["docs", "documentation"]);
const IMPORTANT_NAMES = /^(auth|authentication|database|db|payments?|billing|api|server|worker|queue|config|configuration|cli|commands?|middleware|storage|models?|routes?|services?|core|domain|infra|infrastructure|adapters?|plugins?|extensions?)$/i;
const IGNORE_DIR_NAMES = new Set([".git", ".idea", ".vscode", ".cache", ".turbo", ".worktrees", ".worktree", ".wt"]);

function normalizedRoot(root?: string): string {
	return path.resolve(root ?? process.cwd());
}

function normalizeRepoPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\"|\"$/g, "");
}

function extensionOf(file: string): string {
	return path.extname(file).toLowerCase();
}

function languageFor(file: string): string | undefined {
	const extension = extensionOf(file);
	const map: Record<string, string> = {
		".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
		".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
		".rs": "Rust", ".py": "Python", ".go": "Go", ".java": "Java", ".kt": "Kotlin",
		".cs": "C#", ".cpp": "C++", ".cc": "C++", ".c": "C", ".h": "C/C++",
		".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".dart": "Dart",
	};
	return map[extension];
}

function isCode(file: string): boolean {
	return Boolean(languageFor(file));
}

function basenameDirectoryParts(file: string): string[] {
	const parts = normalizeRepoPath(file).split("/");
	return parts.slice(0, -1);
}

function classifyPath(file: string): RepositoryDirectoryKind {
	const normalized = normalizeRepoPath(file);
	const parts = normalized.split("/");
	for (const part of parts) {
		if (IGNORE_DIR_NAMES.has(part)) return "IGNORED";
		if (DEPENDENCY_DIR_NAMES.has(part)) return "DEPENDENCY";
		if (BUILD_DIR_NAMES.has(part)) return "BUILD_ARTIFACT";
		if (GENERATED_DIR_NAMES.has(part)) return "GENERATED";
		if (TEST_DIR_NAMES.has(part)) return "TEST";
		if (DOCUMENTATION_DIR_NAMES.has(part)) return "DOCUMENTATION";
	}
	const base = parts.at(-1)?.toLowerCase() ?? "";
	if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|poetry\.lock|uv\.lock|go\.sum)$/.test(base)) return "CONFIG";
	if (/^(package\.json|tsconfig(?:\..*)?\.json|vite\.config\..*|next\.config\..*|astro\.config\..*|svelte\.config\..*|cargo\.toml|pyproject\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|webpack\.config\..*|rollup\.config\..*|biome\.json(?:c)?|eslint(?:\.config)?\..*|\.env(?:\..*)?)$/.test(base)) return "CONFIG";
	if (SOURCE_DIR_NAMES.has(parts.at(-2) ?? "")) return "SOURCE";
	if (isCode(normalized)) return "SOURCE";
	return "UNKNOWN";
}

function workspacePackageName(json: Record<string, unknown>, manifest: string): string {
	return typeof json.name === "string" && json.name.length > 0 ? json.name : normalizeRepoPath(path.dirname(manifest));
}

function stringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function packageManagerFromLockfiles(files: readonly string[]): string | undefined {
	const names = new Set(files.map(file => path.basename(file)));
	if (names.has("bun.lock") || names.has("bun.lockb")) return "Bun";
	if (names.has("pnpm-lock.yaml")) return "pnpm";
	if (names.has("yarn.lock")) return "Yarn";
	if (names.has("package-lock.json")) return "npm";
	if (names.has("Cargo.lock")) return "Cargo";
	if (names.has("poetry.lock")) return "Poetry";
	if (names.has("uv.lock")) return "uv";
	if (names.has("go.mod")) return "Go modules";
	return undefined;
}

function frameworkEvidence(manifest: Record<string, unknown>): { framework: string; evidence: string }[] {
	const deps = {
		...stringRecord(manifest.dependencies),
		...stringRecord(manifest.devDependencies),
	};
	const checks: Array<[string, string, string[]]> = [
		["Next.js", "next", ["next.config.js", "next.config.mjs", "next.config.ts"]],
		["React", "react", []],
		["Vue", "vue", ["vue.config.js", "vite.config.ts"]],
		["Svelte", "svelte", ["svelte.config.js", "svelte.config.ts"]],
		["Astro", "astro", ["astro.config.mjs", "astro.config.ts"]],
		["Django", "django", ["manage.py"]],
		["FastAPI", "fastapi", []],
		["Rails", "rails", ["config/application.rb"]],
	];
	const out: { framework: string; evidence: string }[] = [];
	for (const [framework, dependency, configs] of checks) {
		if (deps[dependency]) out.push({ framework, evidence: `dependency ${dependency}` });
		else if (configs.some(config => deps[config])) out.push({ framework, evidence: `configuration ${config}` });
	}
	return out;
}

function testFrameworkEvidence(manifest: Record<string, unknown>): string[] {
	const deps = {
		...stringRecord(manifest.dependencies),
		...stringRecord(manifest.devDependencies),
	};
	const result: string[] = [];
	if (deps.vitest) result.push("Vitest");
	if (deps.jest) result.push("Jest");
	if (deps.mocha) result.push("Mocha");
	if (deps.ava) result.push("AVA");
	if (deps["@playwright/test"]) result.push("Playwright Test");
	return result;
}

function buildSystems(snapshot: RepositorySnapshot): string[] {
	const systems = new Set<string>();
	if (snapshot.rootFiles.some(file => /(^|\/)BUILD\.bazel$/.test(file))) systems.add("Bazel");
	if (snapshot.rootFiles.some(file => /(^|\/)Makefile$/.test(file))) systems.add("Make");
	if (snapshot.rootFiles.some(file => /(^|\/)justfile$/i.test(file))) systems.add("Just");
	if (snapshot.lockfiles.some(file => path.basename(file) === "Cargo.lock")) systems.add("Cargo");
	if (snapshot.lockfiles.some(file => path.basename(file) === "go.mod")) systems.add("Go modules");
	for (const manifest of snapshot.packageManifests) {
		const scripts = stringRecord(manifest.json.scripts);
		if (scripts.build) systems.add("package-script build");
	}
	if (snapshot.rootFiles.some(file => /(^|\/)tsconfig[^/]*\.json$/.test(file))) systems.add("TypeScript");
	return [...systems].sort();
}

function detectSourceRoots(files: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const file of files) {
		const parts = normalizeRepoPath(file).split("/");
		if (parts.length < 2) continue;
		if (SOURCE_DIR_NAMES.has(parts[0])) roots.add(parts[0]);
		if (parts.length >= 3 && (parts[0] === "packages" || parts[0] === "apps" || parts[0] === "services")) {
			if (SOURCE_DIR_NAMES.has(parts[2])) roots.add(`${parts[0]}/${parts[1]}/${parts[2]}`);
		}
	}
	return [...roots].sort();
}

function detectTestRoots(files: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const file of files) {
		const parts = normalizeRepoPath(file).split("/");
		for (let i = 0; i < parts.length - 1; i++) {
			if (TEST_DIR_NAMES.has(parts[i])) roots.add(parts.slice(0, i + 1).join("/"));
		}
		if (/(^|\/)([^/]+)[._-](test|spec)\./i.test(file)) {
			roots.add(path.posix.dirname(normalizeRepoPath(file)));
		}
	}
	return [...roots].sort();
}

function detectImportantDirectories(files: readonly string[]): string[] {
	const candidates = new Set<string>();
	for (const file of files) {
		const dirs = basenameDirectoryParts(file);
		for (let i = 0; i < dirs.length; i++) {
			if (IMPORTANT_NAMES.test(dirs[i])) candidates.add(dirs.slice(0, i + 1).join("/"));
		}
	}
	return [...candidates].sort().slice(0, 32);
}

function detectEntryPoints(snapshot: RepositorySnapshot): RepositoryEntryPoint[] {
	const entries: RepositoryEntryPoint[] = [];
	for (const manifest of snapshot.packageManifests) {
		const base = path.posix.dirname(normalizeRepoPath(manifest.path));
		const add = (value: unknown, evidence: string, confidence: number) => {
			if (typeof value !== "string") return;
			const target = normalizeRepoPath(path.posix.join(base, value));
			if (snapshot.files.includes(target)) entries.push({ path: target, evidence, confidence });
		};
		add(manifest.json.main, "package.json main", 0.96);
		add(manifest.json.module, "package.json module", 0.95);
		if (typeof manifest.json.exports === "string") add(manifest.json.exports, "package.json exports", 0.93);
		const exports = manifest.json.exports;
		if (exports && typeof exports === "object" && !Array.isArray(exports)) {
			const rootExport = (exports as Record<string, unknown>)["."];
			if (typeof rootExport === "string") add(rootExport, "package.json exports[.]", 0.93);
			else if (rootExport && typeof rootExport === "object") {
				for (const key of ["import", "require", "default", "node"]) add((rootExport as Record<string, unknown>)[key], `package.json exports[.].${key}`, 0.9);
			}
		}
		const bin = manifest.json.bin;
		if (typeof bin === "string") add(bin, "package.json bin", 0.94);
		else if (bin && typeof bin === "object") for (const value of Object.values(bin as Record<string, unknown>)) add(value, "package.json bin", 0.94);
		const scripts = stringRecord(manifest.json.scripts);
		for (const [name, script] of Object.entries(scripts)) {
			if (!/^(start|serve|dev)$/.test(name)) continue;
			const match = script.match(/(?:node|tsx|ts-node|bun|deno|python|ruby)\s+([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb))/);
			if (match) add(match[1], `package.json scripts.${name}`, 0.88);
		}
	}
	const conventions: Array<[string, number, string]> = [
		["src/main.ts", 0.72, "common TypeScript entrypoint convention"],
		["src/index.ts", 0.7, "common TypeScript entrypoint convention"],
		["src/app.ts", 0.68, "common TypeScript application convention"],
		["main.py", 0.72, "common Python entrypoint convention"],
		["src/main.rs", 0.76, "Cargo binary entrypoint convention"],
	];
	for (const [candidate, confidence, evidence] of conventions) if (snapshot.files.includes(candidate)) entries.push({ path: candidate, confidence, evidence });
	return entries.filter((item, index, all) => all.findIndex(other => other.path === item.path) === index).sort((a, b) => b.confidence - a.confidence);
}

function repoName(root: string, snapshot: RepositorySnapshot): { name?: string; confidence: number; evidence: string[] } {
	const manifest = snapshot.packageManifests.find(item => normalizeRepoPath(item.path) === "package.json");
	if (manifest && typeof manifest.json.name === "string") return { name: manifest.json.name, confidence: 0.99, evidence: ["package.json name"] };
	return { name: path.basename(root), confidence: 0.65, evidence: ["directory basename"] };
}

function extractDependencyEdges(file: string, content: string, knownFiles: ReadonlySet<string>): RepositoryDependencyEdge[] {
	const edges: RepositoryDependencyEdge[] = [];
	const normalizedFile = normalizeRepoPath(file);
	const dir = path.posix.dirname(normalizedFile);
	const addSpecifier = (specifier: string, kind: "import" | "require") => {
		if (!specifier.startsWith(".") && !specifier.startsWith("/")) return;
		const base = normalizeRepoPath(path.posix.normalize(path.posix.join(dir, specifier)));
		const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.js`];
		const target = candidates.find(candidate => knownFiles.has(candidate));
		if (target && target !== normalizedFile) edges.push({ from: normalizedFile, to: target, kind });
	};
	for (const match of content.matchAll(/\bimport\s+(?:type\s+)?(?:[^"']+from\s+)?["']([^"']+)["']/g)) addSpecifier(match[1], "import");
	for (const match of content.matchAll(/\bexport\s+[^"']*?from\s+["']([^"']+)["']/g)) addSpecifier(match[1], "import");
	for (const match of content.matchAll(/\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)) addSpecifier(match[1], "require");
	for (const match of content.matchAll(/\b(?:from|import)\s+['"]\.?\/?([^'"\n]+)['"]/g)) {
		const raw = match[1];
		if (raw.startsWith("@") || !raw.includes("/")) continue;
	}
	return edges.filter((edge, index, all) => all.findIndex(other => other.from === edge.from && other.to === edge.to && other.kind === edge.kind) === index);
}

function fallbackSymbols(file: string, content: string): RepositorySymbolRecord[] {
	const symbols: RepositorySymbolRecord[] = [];
	const patterns: Array<[RegExp, RepositorySymbolRecord["kind"]]> = [
		[/\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g, "class"],
		[/\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g, "interface"],
		[/\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/g, "type"],
		[/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, "function"],
		[/\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g, "function"],
		[/\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g, "variable"],
	];
	for (const [pattern, kind] of patterns) {
		for (const match of content.matchAll(pattern)) {
			const index = match.index ?? 0;
			symbols.push({ name: match[1], path: normalizeRepoPath(file), line: content.slice(0, index).split("\n").length, kind, source: "text" });
		}
	}
	const exported = [...content.matchAll(/\bexport\s+\{([^}]+)\}/g)];
	for (const match of exported) {
		for (const name of match[1].split(",").map(value => value.trim().split(/\s+as\s+/i)[0]).filter(Boolean)) {
			symbols.push({ name, path: normalizeRepoPath(file), line: content.slice(0, match.index ?? 0).split("\n").length, kind: "export", source: "text" });
		}
	}
	return symbols.filter((item, index, all) => all.findIndex(other => other.name === item.name && other.path === item.path && other.line === item.line) === index);
}

function serializeCachePath(root: string): string {
	const digest = crypto.createHash("sha256").update(root).digest("hex").slice(0, 24);
	const base = process.env.XDG_CACHE_HOME || process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache");
	return path.join(base, "omp-ultra", "repositories", digest, "repository-index.json");
}

async function readJsonFile(file: string): Promise<Record<string, unknown> | undefined> {
	try {
		const text = await fs.readFile(file, "utf8");
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

async function readTextFile(root: string, file: string): Promise<string | undefined> {
	try {
		const absolute = path.resolve(root, file);
		const stat = await fs.stat(absolute);
		if (!stat.isFile() || stat.size > 1_000_000) return undefined;
		return await fs.readFile(absolute, "utf8");
	} catch {
		return undefined;
	}
}

async function command(root: string, args: string[]): Promise<RepoCommandResult> {
	try {
		const result = await ptree.exec(["git", ...args], { cwd: root, allowNonZero: true, allowAbort: true, stderr: "full" });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.exitCode ?? 0 };
	} catch (error) {
		return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1 };
	}
}

function parseGitStatus(text: string): RepositoryGitState {
	const changedFiles = new Set<string>();
	const stagedFiles = new Set<string>();
	const unstagedFiles = new Set<string>();
	const untrackedFiles = new Set<string>();
	let branch: string | undefined;
	let dirty = false;
	let mergeRebaseState: RepositoryGitState["mergeRebaseState"];
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("## ")) {
			const match = line.match(/^##\s+([^\.\s]+|HEAD detached at [^\.\s]+)/);
			branch = match?.[1]?.replace(/^HEAD detached at /, "HEAD");
			continue;
		}
		if (line.length < 3) continue;
		const code = line.slice(0, 2);
		const rawPath = line.slice(3);
		const paths = rawPath.split(/\s+->\s+/);
		const file = normalizeRepoPath(paths.at(-1) ?? rawPath);
		if (!file) continue;
		dirty = true;
		changedFiles.add(file);
		if (code[0] && code[0] !== " ") stagedFiles.add(file);
		if (code[1] && code[1] !== " ") unstagedFiles.add(file);
		if (code === "??") untrackedFiles.add(file);
	}
	return { branch, dirty, changedFiles: [...changedFiles].sort(), stagedFiles: [...stagedFiles].sort(), unstagedFiles: [...unstagedFiles].sort(), untrackedFiles: [...untrackedFiles].sort(), mergeRebaseState };
}

function classifyGitOperation(root: string): Promise<RepositoryGitState["mergeRebaseState"]> {
	return Promise.all([
		fs.stat(path.join(root, ".git", "MERGE_HEAD")).then(() => "MERGING" as const).catch(() => undefined),
		fs.stat(path.join(root, ".git", "CHERRY_PICK_HEAD")).then(() => "CHERRY_PICKING" as const).catch(() => undefined),
		fs.stat(path.join(root, ".git", "REVERT_HEAD")).then(() => "REVERTING" as const).catch(() => undefined),
		fs.stat(path.join(root, ".git", "rebase-merge")).then(() => "REBASING" as const).catch(() => undefined),
		fs.stat(path.join(root, ".git", "rebase-apply")).then(() => "REBASING" as const).catch(() => undefined),
	]).then(values => values.find(Boolean));
}

export function buildRepositoryProfile(snapshot: RepositorySnapshot): { profile: RepositoryProfile; files: RepositoryFileRecord[] } {
	const languages = new Set<string>();
	const configFiles = new Set(snapshot.configFiles.map(normalizeRepoPath));
	const generatedDirectories = new Set<string>();
	const ignoredDirectories = new Set<string>();
	const directoryKinds = new Map<string, RepositoryDirectoryKind>();
	for (const file of snapshot.files) {
		const normalized = normalizeRepoPath(file);
		const kind = classifyPath(normalized);
		directoryKinds.set(normalized, kind);
		const language = languageFor(normalized);
		if (language) languages.add(language);
		for (const part of basenameDirectoryParts(normalized)) {
			if (GENERATED_DIR_NAMES.has(part)) generatedDirectories.add(part);
			if (IGNORE_DIR_NAMES.has(part)) ignoredDirectories.add(part);
		}
	}
	const frameworks: string[] = [];
	const testFramework = new Set<string>();
	for (const manifest of snapshot.packageManifests) {
		for (const item of frameworkEvidence(manifest.json)) if (!frameworks.includes(item.framework)) frameworks.push(item.framework);
		for (const item of testFrameworkEvidence(manifest.json)) testFramework.add(item);
	}
	const roots = repoName(snapshot.root, snapshot);
	const files: RepositoryFileRecord[] = snapshot.files.map(file => ({ path: normalizeRepoPath(file), kind: directoryKinds.get(normalizeRepoPath(file)) ?? "UNKNOWN", extension: extensionOf(file) || undefined, size: 0, mtimeMs: 0 }));
	const profile: RepositoryProfile = {
		identity: { root: snapshot.root, name: roots.name, confidence: roots.confidence, evidence: roots.evidence },
		languages: [...languages].sort(),
		frameworks: frameworks.sort(),
		packageManager: packageManagerFromLockfiles(snapshot.lockfiles),
		buildSystem: buildSystems(snapshot),
		testFramework: [...testFramework].sort(),
		entryPoints: detectEntryPoints(snapshot),
		sourceRoots: detectSourceRoots(snapshot.files),
		testRoots: detectTestRoots(snapshot.files),
		configFiles: [...configFiles].sort(),
		generatedDirectories: [...generatedDirectories].sort(),
		ignoredDirectories: [...ignoredDirectories].sort(),
		importantDirectories: detectImportantDirectories(snapshot.files),
		workspacePackages: snapshot.packageManifests.map(manifest => ({
			name: workspacePackageName(manifest.json, manifest.path),
			root: normalizeRepoPath(path.posix.dirname(manifest.path)),
			manifest: normalizeRepoPath(manifest.path),
			packageManager: packageManagerFromLockfiles(snapshot.lockfiles.filter(file => normalizeRepoPath(file).startsWith(`${normalizeRepoPath(path.posix.dirname(manifest.path))}/`))),
			scripts: stringRecord(manifest.json.scripts),
			dependencies: Object.keys(stringRecord(manifest.json.dependencies)).sort(),
			devDependencies: Object.keys(stringRecord(manifest.json.devDependencies)).sort(),
		})),
		gitState: snapshot.git,
		lastIndexedState: { indexedAt: Date.now(), headRevision: snapshot.headRevision, structuralFingerprint: structuralFingerprint(snapshot), fileCount: snapshot.files.length, cacheHit: false, invalidations: [] },
	};
	return { profile, files };
}

export function structuralFingerprint(snapshot: RepositorySnapshot): string {
	const structural = [
		...snapshot.packageManifests.map(item => `${item.path}:${JSON.stringify(item.json.workspaces ?? null)}:${JSON.stringify(item.json.name ?? null)}`),
		...snapshot.configFiles,
		...snapshot.lockfiles,
		...snapshot.files.filter(file => file.split("/").length <= 2),
	].sort();
	return crypto.createHash("sha256").update(structural.join("\n")).digest("hex");
}

async function discoverSnapshot(root: string, previous?: CachePayload, maxIndexedFiles = 20_000): Promise<{ snapshot: RepositorySnapshot; mode: "full" | "incremental" | "fallback"; invalidations: string[] }> {
	const invalidations: string[] = [];
	const statusResult = await command(root, ["status", "--porcelain=v1", "-b", "-uall"]);
	if (statusResult.code !== 0) return { snapshot: fallbackSnapshot(root), mode: "fallback", invalidations: ["git unavailable"] };
	const git = parseGitStatus(statusResult.stdout);
	git.mergeRebaseState = await classifyGitOperation(root);
	const headResult = await command(root, ["rev-parse", "HEAD"]);
	const headRevision = headResult.code === 0 ? headResult.stdout.trim() : undefined;
	if (previous && headRevision && previous.profile.lastIndexedState.headRevision === headRevision && !git.dirty) {
		return { snapshot: { root, files: previous.files.map(item => item.path), rootFiles: previous.files.map(item => item.path).filter(file => !file.includes("/")), packageManifests: previous.profile.workspacePackages.flatMap(item => item.manifest ? [{ path: item.manifest, json: {} }] : []), lockfiles: previous.files.map(item => item.path).filter(file => /(?:^|\/)(bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|Cargo\.lock|poetry\.lock|uv\.lock|go\.mod|go\.sum)$/.test(file)), configFiles: previous.profile.configFiles, branch: git.branch, git, headRevision }, mode: "incremental", invalidations: [] };
	}
	const structuralFilesResult = await command(root, ["ls-files", "-co", "--exclude-standard"]);
	if (structuralFilesResult.code !== 0) return { snapshot: fallbackSnapshot(root), mode: "fallback", invalidations: ["git ls-files unavailable"] };
	const files = structuralFilesResult.stdout.split(/\r?\n/).map(normalizeRepoPath).filter(Boolean).slice(0, maxIndexedFiles);
	const packageManifests: Array<{ path: string; json: Record<string, unknown> }> = [];
	for (const file of files.filter(value => path.posix.basename(value) === "package.json" || path.posix.basename(value) === "Cargo.toml" || path.posix.basename(value) === "pyproject.toml" || path.posix.basename(value) === "go.mod")) {
		if (file.endsWith("package.json")) {
			const json = await readJsonFile(path.join(root, file));
			if (json) packageManifests.push({ path: file, json });
		}
	}
	const lockfiles = files.filter(file => /(?:^|\/)(bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|Cargo\.lock|poetry\.lock|uv\.lock|go\.mod|go\.sum)$/.test(file));
	const configFiles = files.filter(file => classifyPath(file) === "CONFIG");
	const rootFiles = files.filter(file => !file.includes("/"));
	if (previous) {
		const old = new Set(previous.files.map(item => item.path));
		const current = new Set(files);
		const added = files.filter(file => !old.has(file));
		const removed = previous.files.map(item => item.path).filter(file => !current.has(file));
		if (added.length || removed.length) invalidations.push("file membership changed");
		if (added.some(file => /(?:package\.json|lock|tsconfig|vite\.config|next\.config|cargo\.toml|pyproject\.toml|go\.mod|BUILD\.bazel)$/.test(path.posix.basename(file))) || removed.some(file => /(?:package\.json|lock|tsconfig|vite\.config|next\.config|cargo\.toml|pyproject\.toml|go\.mod|BUILD\.bazel)$/.test(path.posix.basename(file)))) invalidations.push("project configuration changed");
	}
	return { snapshot: { root, files, rootFiles, packageManifests, lockfiles, configFiles, branch: git.branch, git, headRevision }, mode: previous ? "incremental" : "full", invalidations };
}

function fallbackSnapshot(root: string): RepositorySnapshot {
	return { root, files: [], rootFiles: [], packageManifests: [], lockfiles: [], configFiles: [], git: { dirty: false, changedFiles: [], stagedFiles: [], unstagedFiles: [], untrackedFiles: [] } };
}

async function statFiles(root: string, records: RepositoryFileRecord[]): Promise<RepositoryFileRecord[]> {
	const result: RepositoryFileRecord[] = [];
	for (const record of records) {
		try {
			const stat = await fs.stat(path.join(root, record.path));
			result.push({ ...record, size: stat.size, mtimeMs: stat.mtimeMs });
		} catch {
			result.push(record);
		}
	}
	return result;
}

function queryFacts(profile: RepositoryProfile, task: string, complexity: TaskComplexity): RepositoryQueryResult {
	const lower = task.toLowerCase();
	const terms = lower.split(/[^a-z0-9_$.-]+/).filter(value => value.length >= 3);
	const score = (value: string) => terms.reduce((sum, term) => sum + (value.toLowerCase().includes(term) ? 1 : 0), 0);
	const candidateDirs = [...profile.importantDirectories, ...profile.sourceRoots, ...profile.testRoots];
	const files = [...profile.entryPoints.map(item => item.path), ...profile.configFiles, ...candidateDirs].filter((value, index, all) => all.indexOf(value) === index).sort((a, b) => score(b) - score(a)).slice(0, complexity === "SIMPLE" ? 5 : complexity === "NORMAL" ? 10 : 20);
	const facts = [
		profile.identity.name ? `project: ${profile.identity.name}` : undefined,
		profile.languages.length ? `languages: ${profile.languages.join(", ")}` : undefined,
		profile.packageManager ? `package manager: ${profile.packageManager}` : undefined,
		profile.frameworks.length ? `frameworks: ${profile.frameworks.join(", ")}` : undefined,
		profile.testFramework.length ? `tests: ${profile.testFramework.join(", ")}` : undefined,
		profile.buildSystem.length ? `build: ${profile.buildSystem.join(", ")}` : undefined,
	].filter((value): value is string => Boolean(value));
	for (const workspace of profile.workspacePackages.slice(0, complexity === "SIMPLE" ? 2 : 8)) facts.push(`workspace: ${workspace.name} at ${workspace.root}`);
	return { facts, files, workspaces: profile.workspacePackages.map(item => item.root), symbols: [], confidence: profile.identity.confidence };
}

export class RepositoryIntelligence {
	readonly root: string;
	readonly #cacheEnabled: boolean;
	readonly #maxIndexedFiles: number;
	readonly #symbolProvider?: RepositorySymbolProvider;
	#profile?: RepositoryProfile;
	#files: RepositoryFileRecord[] = [];
	#dependencies: RepositoryDependencyEdge[] = [];
	#symbols: RepositorySymbolRecord[] = [];
	#telemetry: RepositoryIntelligenceTelemetry = {
		cacheHit: false, initialIndexingTimeMs: 0, incrementalIndexingTimeMs: 0, filesIndexed: 0, symbolsIndexed: 0, dependencyEdges: 0, invalidations: [], fallbacks: [], queries: 0, queryLatencyMs: 0, indexMode: "fallback",
	};

	constructor(options: RepositoryIntelligenceOptions = {}) {
		this.root = normalizedRoot(options.root);
		this.#cacheEnabled = options.cache !== false && process.env[REPOSITORY_INTELLIGENCE_CACHE_ENV] !== "0";
		this.#maxIndexedFiles = options.maxIndexedFiles ?? 20_000;
		this.#symbolProvider = options.symbolProvider;
	}

	get profile(): RepositoryProfile | undefined { return this.#profile; }
	get telemetry(): RepositoryIntelligenceTelemetry { return { ...this.#telemetry, invalidations: [...this.#telemetry.invalidations], fallbacks: [...this.#telemetry.fallbacks] }; }
	get dependencies(): readonly RepositoryDependencyEdge[] { return this.#dependencies; }
	get symbols(): readonly RepositorySymbolRecord[] { return this.#symbols; }

	async refresh(mode: "auto" | "full" | "incremental" = "auto"): Promise<RepositoryProfile> {
		const started = performance.now();
		const cacheFile = serializeCachePath(this.root);
		let previous: CachePayload | undefined;
		if (this.#cacheEnabled && mode !== "full") {
			try {
				const parsed = JSON.parse(await fs.readFile(cacheFile, "utf8")) as CachePayload;
				if (parsed.schemaVersion === REPOSITORY_INTELLIGENCE_SCHEMA_VERSION && path.resolve(parsed.profile.identity.root) === this.root) previous = parsed;
			} catch {
				this.#telemetry.cacheMissReason = "cache unavailable";
			}
		}
		const discovery = await discoverSnapshot(this.root, mode === "full" ? undefined : previous, this.#maxIndexedFiles);
		if (discovery.mode === "fallback") {
			this.#telemetry = { ...this.#telemetry, cacheHit: false, cacheMissReason: discovery.invalidations.join(", "), indexMode: "fallback", fallbacks: [...this.#telemetry.fallbacks, ...discovery.invalidations], initialIndexingTimeMs: performance.now() - started };
			this.#profile = buildRepositoryProfile(discovery.snapshot).profile;
			this.#profile.lastIndexedState.cacheHit = false;
			this.#profile.lastIndexedState.invalidations = discovery.invalidations;
			return this.#profile;
		}
		const built = buildRepositoryProfile(discovery.snapshot);
		let fileRecords = await statFiles(this.root, built.files);
		let dependencies: RepositoryDependencyEdge[] = previous?.dependencies ? previous.dependencies.slice() : [];
		let symbols: RepositorySymbolRecord[] = previous?.symbols ? previous.symbols.slice() : [];
		const currentFileSet = new Set(discovery.snapshot.files);
		if (previous && discovery.mode === "incremental") {
			const changed = new Set(discovery.snapshot.git.changedFiles.map(normalizeRepoPath));
			fileRecords = fileRecords.map(record => ({ ...record, ...(changed.has(record.path) ? { hash: undefined } : previous?.files.find(item => item.path === record.path)?.hash ? { hash: previous.files.find(item => item.path === record.path)?.hash } : {}) }));
			dependencies = dependencies.filter(edge => currentFileSet.has(edge.from) && currentFileSet.has(edge.to) && !changed.has(edge.from));
			symbols = symbols.filter(symbol => currentFileSet.has(symbol.path) && !changed.has(symbol.path));
		}
		const toIndex = previous && discovery.mode === "incremental" ? discovery.snapshot.git.changedFiles.filter(file => currentFileSet.has(file)).map(normalizeRepoPath) : discovery.snapshot.files;
		const knownFiles = new Set(discovery.snapshot.files);
		let indexed = 0;
		for (const file of toIndex.filter(value => isCode(value))) {
			const content = await readTextFile(this.root, file);
			if (content === undefined) continue;
			indexed++;
			const related = extractDependencyEdges(file, content, knownFiles);
			dependencies.push(...related);
			const providedSymbols = this.#symbolProvider?.indexFileSymbols ? await this.#symbolProvider.indexFileSymbols(file).catch(() => []) : [];
			if (providedSymbols.length) symbols.push(...providedSymbols);
			else symbols.push(...fallbackSymbols(file, content));
			const record = fileRecords.find(item => item.path === file);
			if (record) record.hash = crypto.createHash("sha1").update(content).digest("hex");
		}
		dependencies = dependencies.filter((edge, index, all) => all.findIndex(other => other.from === edge.from && other.to === edge.to && other.kind === edge.kind) === index);
		symbols = symbols.filter((item, index, all) => all.findIndex(other => other.name === item.name && other.path === item.path && other.line === item.line) === index);
		const profile = built.profile;
		profile.gitState.mergeRebaseState = discovery.snapshot.git.mergeRebaseState;
		profile.lastIndexedState = {
			indexedAt: Date.now(), headRevision: discovery.snapshot.headRevision, structuralFingerprint: structuralFingerprint(discovery.snapshot), fileCount: discovery.snapshot.files.length,
			cacheHit: Boolean(previous), invalidations: discovery.invalidations,
		};
		this.#profile = profile;
		this.#files = fileRecords;
		this.#dependencies = dependencies;
		this.#symbols = symbols;
		const elapsed = performance.now() - started;
		this.#telemetry = {
			cacheHit: Boolean(previous),
			cacheMissReason: previous ? undefined : this.#telemetry.cacheMissReason,
			initialIndexingTimeMs: previous ? this.#telemetry.initialIndexingTimeMs : elapsed,
			incrementalIndexingTimeMs: previous ? elapsed : 0,
			filesIndexed: indexed,
			symbolsIndexed: symbols.length,
			dependencyEdges: dependencies.length,
			invalidations: discovery.invalidations,
			fallbacks: this.#telemetry.fallbacks,
			queries: this.#telemetry.queries,
			queryLatencyMs: this.#telemetry.queryLatencyMs,
			indexMode: previous ? "incremental" : "full",
		};
		if (this.#cacheEnabled) {
			const payload: CachePayload = { schemaVersion: REPOSITORY_INTELLIGENCE_SCHEMA_VERSION, profile, files: fileRecords, dependencies, symbols, structuralInputs: [...discovery.snapshot.configFiles, ...discovery.snapshot.lockfiles] };
			try {
				await fs.mkdir(path.dirname(cacheFile), { recursive: true });
				await fs.writeFile(cacheFile, JSON.stringify(payload), "utf8");
			} catch {
				this.#telemetry.fallbacks.push("cache write failed");
			}
		}
		return profile;
	}

	async ensureIndexed(complexity: TaskComplexity = "NORMAL"): Promise<RepositoryProfile> {
		if (this.#profile) return this.#profile;
		return this.refresh("auto");
	}

	findProjectFacts(task = "", complexity: TaskComplexity = "NORMAL"): RepositoryQueryResult {
		const started = performance.now();
		this.#telemetry.queries++;
		if (!this.#profile) return { facts: [], files: [], workspaces: [], symbols: [], confidence: 0 };
		const result = queryFacts(this.#profile, task, complexity);
		this.#telemetry.queryLatencyMs += performance.now() - started;
		return result;
	}

	findFileOwners(files: readonly string[]): RepositoryWorkspacePackage[] {
		if (!this.#profile) return [];
		const normalized = files.map(normalizeRepoPath);
		return this.#profile.workspacePackages.filter(workspace => normalized.some(file => file === workspace.root || file.startsWith(`${workspace.root}/`)));
	}

	findWorkspaceForFile(file: string): RepositoryWorkspacePackage | undefined {
		const owners = this.findFileOwners([file]);
		return owners.sort((a, b) => b.root.length - a.root.length)[0];
	}

	findLikelyEntryPoints(task = ""): RepositoryEntryPoint[] {
		if (!this.#profile) return [];
		const terms = task.toLowerCase().split(/[^a-z0-9_-]+/).filter(value => value.length >= 3);
		return [...this.#profile.entryPoints].sort((a, b) => {
			const score = (entry: RepositoryEntryPoint) => terms.reduce((sum, term) => sum + (entry.path.toLowerCase().includes(term) ? 1 : 0), 0) + entry.confidence;
			return score(b) - score(a);
		});
	}

	findRelevantTests(files: readonly string[], task = ""): string[] {
		if (!this.#profile) return [];
		const normalized = files.map(normalizeRepoPath);
		const names = normalized.map(file => path.posix.basename(file).replace(/\.[^.]+$/, ""));
		const candidates = this.#files.filter(file => file.kind === "TEST").map(file => file.path);
		return candidates.sort((a, b) => {
			const value = (file: string) => names.reduce((sum, name) => sum + (file.toLowerCase().includes(name.toLowerCase()) ? 3 : 0), 0) + (task && file.toLowerCase().includes(task.toLowerCase().split(/\s+/)[0] ?? "") ? 1 : 0);
			return value(b) - value(a);
		}).slice(0, 20);
	}

	findDependencies(file: string): string[] {
		const normalized = normalizeRepoPath(file);
		return this.#dependencies.filter(edge => edge.from === normalized).map(edge => edge.to);
	}

	findDependents(file: string): string[] {
		const normalized = normalizeRepoPath(file);
		return this.#dependencies.filter(edge => edge.to === normalized).map(edge => edge.from);
	}

	async findSymbolDefinition(symbol: string): Promise<RepositorySymbolRecord[]> {
		if (this.#symbolProvider?.findSymbolDefinition) return this.#symbolProvider.findSymbolDefinition(symbol);
		return this.#symbols.filter(item => item.name === symbol);
	}

	async findSymbolReferences(symbol: string): Promise<RepositorySymbolRecord[]> {
		if (this.#symbolProvider?.findSymbolReferences) return this.#symbolProvider.findSymbolReferences(symbol);
		return this.#symbols.filter(item => item.name === symbol);
	}

	getTaskRepositorySignals(task = ""): TaskRepositorySignals {
		const profile = this.#profile;
		if (!profile) return { knownUncertainty: true };
		const candidate = queryFacts(profile, task, "NORMAL");
		const repositorySize = profile.lastIndexedState.fileCount < 500 ? "small" : profile.lastIndexedState.fileCount < 5000 ? "medium" : "large";
		return {
			repositorySize,
			projectType: profile.languages.length > 1 ? `${profile.languages.join("/")} repository` : profile.languages[0],
			framework: profile.frameworks[0],
			hasTests: profile.testRoots.length > 0 || profile.testFramework.length > 0,
			relevantFileCount: candidate.files.length,
			subsystemCount: profile.importantDirectories.length,
			crossesSubsystems: profile.importantDirectories.length > 3 && candidate.files.length > 2,
			knownUncertainty: profile.languages.length === 0,
		};
	}

	getRelevantFacts(task: string, complexity: TaskComplexity): string {
		if (!this.#profile) return "";
		const result = this.findProjectFacts(task, complexity);
		const tests = result.files.flatMap(file => this.findRelevantTests([file], task)).slice(0, 6);
		const lines = [...result.facts, ...(result.files.length ? [`relevant: ${result.files.slice(0, 12).join(", ")}`] : []), ...(tests.length ? [`tests: ${tests.join(", ")}`] : [])];
		return lines.slice(0, complexity === "SIMPLE" ? 8 : complexity === "NORMAL" ? 14 : 24).join("\n");
	}
}

export function createRepositoryIntelligence(options: RepositoryIntelligenceOptions = {}): RepositoryIntelligence {
	return new RepositoryIntelligence(options);
}
