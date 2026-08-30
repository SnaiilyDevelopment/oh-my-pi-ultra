export type {
	MnemopiBackendConfig,
	MnemopiLlmMode,
	MnemopiProviderOptions,
	MnemopiScoping,
} from "../mnemopi/config";
export type {
	MnemopiMemoryEditOperation,
	MnemopiMemoryEditOptions,
	MnemopiMemoryEditResult,
	MnemopiSessionState,
	MnemopiSessionStateOptions,
} from "../mnemopi/state";

// Persistent project-memory runtime is layered onto the existing memory/session
// subsystem. It is intentionally independent from the selected memory backend.
import "../memories/project-memory-runtime";

export * from "./local-backend";
export * from "./messages";
export * from "./off-backend";
export * from "./resolve";
export * from "./runtime";
export * from "./types";
export * from "../memories/project-memory";
export { getProjectMemoryTelemetry, getMemoryTelemetry } from "../memories/project-memory-runtime";
