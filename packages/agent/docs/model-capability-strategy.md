# Model Capability & Adaptive Strategy

OMP Ultra consumes the resolved `Model` object and provider compatibility metadata already produced by the catalog/`pi-ai` stack. It does not create a second provider framework and never infers capabilities from model names.

## Capability profile

The normalized profile keeps `supported`, `unsupported`, and `unknown` separate. It uses only fields the current OMP architecture can act on: context/output limits, explicit thinking metadata, native tool support, image input, computer-use support, tool-choice compat, parallel-tool compat, prompt-cache compat, and developer-role compat.

## Strategy profile

Task Router complexity is combined with the capability profile:

- context budget is scaled to the actual context window and preserves output headroom;
- reasoning is raised only when the model exposes a controllable thinking ladder;
- explicitly supported parallel tool calls are enabled for non-trivial tasks;
- structured output remains on OMP's existing fallback path unless explicit support metadata exists;
- very complex tasks or models without controllable reasoning get deeper deterministic verification;
- unsupported capability can select a capability-aware fallback policy; unknown capability never forces a model switch.

## Runtime

`model-capability-runtime.ts` runs before the existing Task Router runtime. When the user has not explicitly selected a thinking level, it applies the strategy's selected effort through the existing `Agent.setThinkingLevel()` API. Provider-specific encoding remains inside `pi-ai`.

Telemetry is exposed by `getModelCapabilities()` and `getModelStrategy()` and is kept on agent state for downstream Task 01-05 consumers.

Disable with:

```text
PI_MODEL_CAPABILITIES=0
```

## Cache

Stable profiles are cached by provider, model id, API, and base URL. `invalidateModelCapabilities()` is available to callers when an endpoint/model definition changes. Runtime capability evidence is intended to invalidate only after repeated evidence, preventing one transient provider failure from causing a permanent downgrade.

## Known limits

The current model abstraction does not expose an explicit provider-neutral structured-output declaration for every API, so that capability remains `unknown` unless compat metadata supplies it. Likewise, system-message support is deliberately `unknown` at the normalized strategy layer because provider adapters own the final wire normalization. Automatic model replacement is not performed here; this layer reports a capability-safe fallback policy without inventing a compatible fallback model.
