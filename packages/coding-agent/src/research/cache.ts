import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { ResearchResult } from "./types";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function key(input: string): string {
	return crypto.createHash("sha256").update(input).digest("hex");
}

export interface ResearchCacheOptions { ttlMs?: number; root?: string; }

export async function readResearchCache(cacheKey: string, options: ResearchCacheOptions = {}): Promise<ResearchResult | undefined> {
	const root = options.root ?? path.join(getAgentDir(), "research-cache");
	try {
		const file = path.join(root, `${key(cacheKey)}.json`);
		const stat = await fs.stat(file);
		const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
		if (Date.now() - stat.mtimeMs > ttl) return undefined;
		return JSON.parse(await fs.readFile(file, "utf8")) as ResearchResult;
	} catch { return undefined; }
}

export async function writeResearchCache(cacheKey: string, result: ResearchResult, options: ResearchCacheOptions = {}): Promise<void> {
	const root = options.root ?? path.join(getAgentDir(), "research-cache");
	await fs.mkdir(root, { recursive: true });
	const file = path.join(root, `${key(cacheKey)}.json`);
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		const safe = JSON.stringify(result);
		await fs.writeFile(temp, safe, { mode: 0o600 });
		await fs.rename(temp, file);
	} finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
