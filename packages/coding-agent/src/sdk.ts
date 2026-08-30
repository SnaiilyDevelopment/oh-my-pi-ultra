import * as path from "node:path";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentOptions,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	filterProviderReplayMessages,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	Context,
	CredentialDisabledEvent,
	Effort,
	Message,
	Model,
	ModelUsageHealth,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { FALLBACK_DIALECT, preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	$env,
	$flag,
	getAgentDir,
	getModelDbPath,
	getProjectDir,
	logger,
	postmortem,
	prompt,
