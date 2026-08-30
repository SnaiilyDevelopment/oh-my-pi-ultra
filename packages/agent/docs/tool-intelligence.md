# Tool Intelligence & High-Signal Execution

Task 05 adds a deterministic result-projection layer at the existing agent model-call boundary. It follows the repository's current architecture instead of introducing a second tool framework.

## Audited execution path

```text
model
  -> tool selection
  -> provider/tool-call validation in Agent loop
  -> Tool.execute()
  -> AgentToolResult
  -> existing output-meta spill/truncation/artifact handling
  -> ToolResult message in Agent context
  -> Tool Intelligence projection (Task 05)
  -> Context Intelligence (Task 02)
  -> provider conversion / LLM call
```

`createTools()` constructs built-ins from `BUILTIN_TOOLS`/`HIDDEN_TOOLS` and wraps created tools with the existing `wrapToolWithMetaNotice()`. That wrapper already owns output notices, artifact spill, and error rendering. Task 05 does not replace it.

Read/search already contain substantial specialized behavior: `read` supports exact line/range handling and snapshots, while `grep` already groups matches, caps per-file output, and exposes `skip` pagination. Task 05 therefore does not blindly rewrite or summarize source reads and only projects oversized/high-signal search output.

## Projection model

The projector classifies a result into `shell`, `test`, `compiler`, `git`, `search`, `glob`, or `none`. Small successful results remain essentially unchanged. Large or failed results are projected into deterministic fields such as:

```text
COMMAND FAILURE
command: bun run build
exit: 1
duration: 412.3ms
errors:
src/auth/session.ts:143 timeout
paths: src/auth/session.ts
recent output: ...
```

Test results expose counts and primary failures. Compiler results expose diagnostic lines, error codes, and locations. Git results expose branch/conflicts/changed files. Search/glob projections expose counts and a small high-value window rather than an unbounded listing.

No LLM summarization is used.

## Full output and ranges

The projector never owns a second full-output store. Existing `output-meta.ts` already spills large results to `artifact://<id>` and emits recovery metadata. Task 05 preserves an existing artifact reference when the projection replaces the model-facing content.

File reads keep exact source content. Existing read selectors remain the preferred way to request line ranges or targeted reads. Existing grep `skip` pagination remains the preferred way to retrieve later result windows.

## Duplicate handling

The runtime performs conservative same-content duplicate suppression for successful repeated non-source/UI tools within the same model-call projection. It emits:

```text
[unchanged since previous result]
```

Read/browser/computer/LSP results are intentionally excluded. A different hash is always treated as a state change.

## Task 02 interaction

Task 05 runs before Context Intelligence so Task 02 ranks the projected representation, not the unbounded raw text. The projector records importance/state/size metadata; Context Intelligence remains the owner of context relevance and budget allocation.

## Task 03 interaction

Projected failures preserve the original `isError`/tool result semantics and attach `details.toolIntelligence`. Task 03 therefore receives structured state alongside the existing result instead of needing another failure taxonomy. Verification continues to own deterministic checks, failure recovery, and bounded repair.

## Task 04 interaction

Repository Intelligence remains the source of package-manager, workspace, project, and repository facts. Tool Intelligence does not rediscover those facts. It only shapes the output of a tool call when the tool result itself requires compression.

## Security

No permission, approval, validation, sandbox, command restriction, or provider tool schema is changed by Task 05. Repository content cannot change projection policy.

## Telemetry

`ToolIntelligenceTelemetry` records raw output bytes, model-facing bytes, projection calls, projection latency, duplicate suppression, cache misses/hits, artifact references, and per-tool aggregates. The measurement target is decision-relevant information retained per model-facing token, not compression ratio alone.

A deterministic benchmark harness lives at `packages/agent/bench/tool-intelligence.ts` and compares representative shell, test, search, and source-read cases.

## Runtime controls

```text
PI_TOOL_INTELLIGENCE=0
PI_TOOL_INTELLIGENCE_LARGE_BYTES=<bytes>
PI_TOOL_INTELLIGENCE_HUGE_BYTES=<bytes>
PI_TOOL_INTELLIGENCE_DUPLICATE_SUPPRESSION=0
```

The existing artifact-spill and read/search range settings remain authoritative for full-output retrieval and source fidelity.

## Tool descriptions and parallelism audit

The first Task 05 pass does not rewrite tool schemas/descriptions en masse. Existing schemas are already typed and many tools already expose concise result-specific limits. A later benchmark can identify individual descriptions whose token cost is material.

The agent/tool provider stack already permits multiple independent tool calls in a turn. Task 05 does not introduce a second scheduler and does not reorder calls. Dependent tool operations remain under the existing agent/tool lifecycle.

## Limitations

Browser/computer/LSP outputs are deliberately not aggressively projected because visual/action state and structured protocol metadata can be decision-critical. Source reads are also left exact. Search has only light projection because the existing grep tool already performs grouping and pagination. More specialized projections can be added later based on benchmark evidence rather than speculative heuristics.
