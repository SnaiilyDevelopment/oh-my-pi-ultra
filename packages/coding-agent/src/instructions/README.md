# Dynamic instruction architecture

Task 11 moves durable agent behavior into a compact, deterministic instruction compositor. The existing `buildSystemPrompt()` pipeline remains the only provider-facing prompt constructor.

Instruction sources are typed and ordered as trusted instructions. Repository/context/tool output remains separate state and is never promoted to system instructions by the compositor.
