import * as fs from "node:fs/promises";
import * as path from "node:path";
import { safePath, sanitizeString } from "./sanitize";
import type { BenchmarkRunRecord, BenchmarkRunSet, BenchmarkTaskSuite, ComparisonReport } from "./types";

export class BenchmarkStore {
	readonly root: string;
	constructor(root: string) { this.root = root; }
	get tasksPath() { return path.join(this.root, "tasks"); }
	get runsPath() { return path.join(this.root, "runs"); }
	get setsPath() { return path.join(this.root, "sets"); }
	get reportsPath() { return path.join(this.root, "reports"); }
	get logsPath() { return path.join(this.root, "logs"); }

	async init(): Promise<void> {
		for (const dir of [this.tasksPath, this.runsPath, this.setsPath, this.reportsPath, this.logsPath]) await fs.mkdir(dir, { recursive: true });
	}
	async saveTaskSuite(suite: BenchmarkTaskSuite): Promise<void> { await this.init(); await atomicJson(path.join(this.tasksPath, `${safePath(suite.name)}.json`), suite); }
	async saveRun(record: BenchmarkRunRecord): Promise<void> { await this.init(); await atomicJson(path.join(this.runsPath, `${safePath(record.runId)}.json`), record); }
	async saveRunSet(set: BenchmarkRunSet): Promise<void> { await this.init(); await atomicJson(path.join(this.setsPath, `${safePath(set.runSetId)}.json`), set); }
	async saveReport(id: string, report: ComparisonReport): Promise<void> { await this.init(); await atomicJson(path.join(this.reportsPath, `${safePath(id)}.json`), report); }
	async loadRun(id: string): Promise<BenchmarkRunRecord> { return readJson(path.join(this.runsPath, `${safePath(id)}.json`)); }
	async loadRunSet(id: string): Promise<BenchmarkRunSet> { return readJson(path.join(this.setsPath, `${safePath(id)}.json`)); }
	async loadReport(id: string): Promise<ComparisonReport> { return readJson(path.join(this.reportsPath, `${safePath(id)}.json`)); }
	async listRunSets(): Promise<string[]> { await this.init(); return (await fs.readdir(this.setsPath)).filter(file => file.endsWith(".json")).sort(); }
	async listRuns(): Promise<string[]> { await this.init(); return (await fs.readdir(this.runsPath)).filter(file => file.endsWith(".json")).sort(); }
	async writeLog(runId: string, variant: string, stdout: string, stderr: string): Promise<{ stdout: string; stderr: string }> {
		await this.init();
		const prefix = `${safePath(runId)}-${safePath(variant)}`;
		const stdoutPath = path.join(this.logsPath, `${prefix}.stdout.log`);
		const stderrPath = path.join(this.logsPath, `${prefix}.stderr.log`);
		await fs.writeFile(stdoutPath, sanitizeString(stdout, 200_000), "utf8");
		await fs.writeFile(stderrPath, sanitizeString(stderr, 200_000), "utf8");
		return { stdout: stdoutPath, stderr: stderrPath };
	}
}

async function atomicJson(file: string, value: unknown): Promise<void> {
	const temp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
	await fs.rename(temp, file);
}
async function readJson<T>(file: string): Promise<T> { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
