import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { benchmarkHelp as commandHelp } from "../cli/command-help";
import { runBenchmarkCommand } from "../cli/benchmark-cli";

export default class Benchmark extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "run, list, task, compare, report, or replay", required: true }),
		target: Args.string({ description: "task id, run id, run-set pair, or report target", required: false }),
	};
	static flags = {
		suite: Flags.string({ description: "Benchmark task suite JSON path" }),
		repository: Flags.string({ description: "Repository checkout used as the benchmark source" }),
		tasks: Flags.string({ description: "Comma-separated task ids" }),
		variant: Flags.string({ description: "baseline, ultra, or both", options: ["baseline", "ultra", "both"], default: "both" }),
		"baseline-command": Flags.string({ description: "Command that runs baseline OMP" }),
		"ultra-command": Flags.string({ description: "Command that runs OMP Ultra" }),
		runs: Flags.integer({ description: "Runs per task and variant", default: 1 }),
		timeout: Flags.integer({ description: "Per-run timeout in milliseconds" }),
		"output-dir": Flags.string({ description: "Benchmark result directory", default: ".omp/benchmarks" }),
		"require-tools": Flags.string({ description: "Comma-separated executables required before running" }),
		model: Flags.string({ description: "Model id recorded in benchmark metadata" }),
		provider: Flags.string({ description: "Provider recorded in benchmark metadata" }),
		"omp-commit": Flags.string({ description: "Baseline OMP commit recorded in metadata" }),
		"omp-ultra-commit": Flags.string({ description: "OMP Ultra commit recorded in metadata" }),
		branch: Flags.string({ description: "Branch name recorded in metadata" }),
		json: Flags.boolean({ description: "Output machine-readable JSON", default: false }),
		"success-threshold": Flags.string({ description: "Allowed Ultra success-rate decrease before flagging regression" }),
		"token-threshold": Flags.string({ description: "Allowed Ultra/base mean-token ratio" }),
		"latency-threshold": Flags.string({ description: "Allowed Ultra/base mean-latency ratio" }),
		"model-call-threshold": Flags.string({ description: "Allowed Ultra/base mean-model-call ratio" }),
		"tool-call-threshold": Flags.string({ description: "Allowed Ultra/base mean-tool-call ratio" }),
	};
	static examples = [
		"omp benchmark list",
		"omp benchmark task debugging-root-cause",
		"omp benchmark run --repository . --require-tools node --baseline-command 'omp launch --print' --ultra-command 'omp-ultra launch --print' --runs 3",
		"omp benchmark report <run-set-id>",
		"omp benchmark compare <baseline-run-set>,<ultra-run-set> --json",
		"omp benchmark replay <run-id>",
	];
	async run(): Promise<void> {
		const { args, flags } = await this.parse(Benchmark);
		const result = await runBenchmarkCommand({ action: args.action, target: args.target, flags: { suite: flags.suite, repository: flags.repository, tasks: flags.tasks, variant: flags.variant, baselineCommand: flags["baseline-command"], ultraCommand: flags["ultra-command"], runs: flags.runs, timeout: flags.timeout, outputDir: flags["output-dir"], requireTools: flags["require-tools"], model: flags.model, provider: flags.provider, ompCommit: flags["omp-commit"], ompUltraCommit: flags["omp-ultra-commit"], branch: flags.branch, json: flags.json, successThreshold: flags["success-threshold"], tokenThreshold: flags["token-threshold"], latencyThreshold: flags["latency-threshold"], modelCallThreshold: flags["model-call-threshold"], toolCallThreshold: flags["tool-call-threshold"] } });
		if (typeof result === "string") { process.stdout.write(`${result}\n`); return; }
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	}
}
