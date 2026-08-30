export type InstructionTaskKind = "simple" | "normal" | "debugging" | "architecture" | "refactoring" | "complex";
export type InstructionPhase = "UNDERSTAND" | "PLAN" | "IMPLEMENT" | "VERIFY" | "RECOVER" | "REVIEW" | "COMPLETE" | "BLOCKED";
export type SpecialistInstructionRole = "EXPLORER" | "ARCHITECT" | "DEBUGGER" | "TEST_ENGINEER" | "REVIEWER" | "SECURITY_REVIEWER" | "RESEARCHER";
export interface InstructionTaskProfile { complexity: "SIMPLE" | "NORMAL" | "COMPLEX" | "VERY_COMPLEX"; workflow?: { plan?: boolean; architecture?: boolean; verification?: "basic" | "standard" | "deep" | "final"; reasoningDepth?: string }; kind?: InstructionTaskKind; }
export interface InstructionFailureState { present: boolean; category?: string; check?: string; summary?: string; repeatCount?: number; }
export interface InstructionVerificationState { state?: string; failureCategory?: string; checksSelected?: number; checksPassed?: number; checksFailed?: number; }
export interface InstructionModelState { structuredOutput?: "supported" | "unsupported" | "unknown"; toolCalling?: "supported" | "unsupported" | "unknown"; parallelToolCalls?: "supported" | "unsupported" | "unknown"; promptCaching?: "supported" | "unsupported" | "unknown"; }
export interface InstructionState { task?: InstructionTaskProfile; phase?: InstructionPhase; lastAction?: string; objective?: string; failure?: InstructionFailureState; verification?: InstructionVerificationState; contextPressure?: number; model?: InstructionModelState; toolNames?: readonly string[]; untrustedContentPresent?: boolean; specialistRole?: SpecialistInstructionRole; }
export type InstructionPriority = "critical" | "core" | "optional";
export type InstructionLayerName = "base" | "task" | "phase" | "recovery" | "capability" | "specialist";
export interface InstructionLayer { readonly name: InstructionLayerName; readonly priority: InstructionPriority; readonly text: string; }
export interface InstructionTelemetry { readonly baseTokens: number; readonly dynamicTokens: number; readonly phaseTokens: number; readonly specialistTokens: number; readonly totalInstructionTokens: number; readonly duplicateInstructionsRemoved: number; readonly omittedOptionalInstructions: number; readonly compositionLatencyMs: number; }
export interface ComposedInstructions { readonly text: string; readonly layers: readonly InstructionLayer[]; readonly telemetry: InstructionTelemetry; }
export interface InstructionBudget { readonly maxTokens?: number; readonly countTokens?: (text: string) => number; }
