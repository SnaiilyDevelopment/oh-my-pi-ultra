import { describe, expect, test } from "bun:test";
import { runToolIntelligenceBenchmark } from "../bench/tool-intelligence";

describe("tool intelligence benchmark", () => {
	test("retains decision-relevant evidence while reducing eligible large outputs", () => {
		const rows = runToolIntelligenceBenchmark();
		const shell = rows.find(row => row.name === "shell")!;
		const testResult = rows.find(row => row.name === "test")!;
		const search = rows.find(row => row.name === "search")!;
		const read = rows.find(row => row.name === "read")!;
		expect(shell.informationRetained).toBe(true);
		expect(testResult.informationRetained).toBe(true);
		expect(search.informationRetained).toBe(true);
		expect(read.informationRetained).toBe(true);
		expect(shell.modelFacingBytes).toBeLessThan(shell.rawBytes);
		expect(testResult.modelFacingBytes).toBeLessThan(testResult.rawBytes);
		expect(search.modelFacingBytes).toBeLessThan(search.rawBytes);
		expect(read.modelFacingBytes).toBe(read.rawBytes);
	});
});
