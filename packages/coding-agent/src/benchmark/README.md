# OMP Ultra Benchmark Harness

This package measures real coding-task execution. It is intentionally separate from `omp bench`, which benchmarks model transport/throughput.

## CLI

```text
omp benchmark list
omp benchmark task <task-id>
omp benchmark run --repository <checkout> --baseline-command '<omp command>' --ultra-command '<omp-ultra command>' --runs 3 --require-tools bun,git
omp benchmark report <run-set-id>
omp benchmark compare <baseline-run-set>,<ultra-run-set> --json
omp benchmark replay <run-id>
```

A benchmark run always starts from the exact current repository commit and creates a detached Git worktree. The source checkout is never used as the mutable benchmark workspace.

## Evidence contract

The runner accepts an optional single-line `OMP_BENCH_EVIDENCE_JSON=<json>` marker on stdout or JSON written to `OMP_BENCH_EVIDENCE_FILE`. The JSON may contain the existing `AgentRunSummary` and `AgentRunCoverage` plus Task 01–09 measurements:

```json
{
  "summary": { "chats": {"total": 3}, "tools": {"total": 7, "error": 0}, "usage": {"inputTokens": 1200, "outputTokens": 500, "reasoningOutputTokens": 200, "totalTokens": 1900} },
  "coverage": {},
  "context": {"samples": 3, "peakTokens": 42000, "compactionCount": 1, "retrievedMemory": 2},
  "tools": {"rawOutputBytes": 12000, "modelFacingOutputBytes": 4500, "toolOutputTokens": 1100, "parallelGroups": 1},
  "orchestration": {"initialComplexity":"COMPLEX", "strategyChanges":1, "escalations":0, "specialistCalls":2, "verificationDepth":"deep"},
  "specialists": {"decisions":2, "invocations":2, "parallelGroups":1},
  "verification": {"state":"VERIFIED_SUCCESS", "testsPassed":5, "regressions":0, "repairAttempts":0, "escalations":0},
  "latency": {"modelMs":2200, "toolMs":900, "verificationMs":600, "orchestrationMs":50, "waitingMs":100, "specialistMs":700},
  "humanInterventions": [{"type":"none","count":0}]
}
```

`AgentRunSummary` is the source of truth for model/tool/token totals; benchmark code does not re-count those events. Missing dimensions stay `0`/unknown rather than being guessed.

## Deterministic success

Use `verification.commands`, `requiredPaths`, `forbiddenPaths`, and `expectedText` in a task definition. The runner executes command checks through the existing Task 03 `executeVerificationPlan()` and evaluates file/behavior assertions inside the isolated worktree.

A model saying “done” is never enough for `SUCCESS`.

## Environment and secrets

Runs record repository commit, branch, OS, architecture, runtime versions, model/provider metadata, and harness version. Environment keys/values are sanitized. Logs are stored separately from JSON run records and are also sanitized. API keys, access tokens, cookies, credentials, and common token forms are redacted.

Setup failures are stored with `comparisonEligible=false` so they remain diagnosable without becoming false A/B evidence.

## Repeated runs and comparison

Run the same task multiple times with the same repository commit, model, settings, timeout, and environment. Compare only equivalent workloads. The report includes raw sample counts, eligible sample counts, success rate with a descriptive Wilson interval, mean/median/p95 tokens/latency/model/tool calls, and configurable regression flags.

There is deliberately no S++ score. Raw dimensions remain authoritative.

## Seed suite

`seed-suite.json` contains one small task for every required project category. The seed tasks are repository-agnostic templates; they are not evidence of coding performance until a real repository, deterministic verification, and actual baseline/Ultra execution are supplied.
