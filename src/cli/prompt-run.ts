import path from "node:path";

import {
  maxTokensForModel,
  ProviderClient,
  type ProviderClientConnectOptions
} from "../api/providers";
import {
  ConversationRuntime,
  PermissionPolicy,
  ProviderRuntimeClient,
  Session,
  StaticToolExecutor,
  type PermissionMode,
  type TurnSummary
} from "../runtime";
import { executeTool } from "../tools";
import { cliToolDefinitionsForNames } from "./cli-tool-definitions";

export interface RunPromptModeInput {
  prompt: string;
  model: string;
  permissionMode: PermissionMode;
  outputFormat: "text" | "json" | "ndjson";
  allowedTools?: string[];
  /** When set, opens or creates the session file so history persists across turns (JSONL append). */
  resumeSessionPath?: string;
}

function providerConnectOptionsForSession(session: Session): ProviderClientConnectOptions {
  const sid =
    session.sessionId?.trim() ||
    (session.persistencePath ? path.basename(session.persistencePath) : "") ||
    "default-session";
  return { promptCacheSessionId: sid };
}

function buildToolExecutor(mode: PermissionMode, toolNames: string[]): StaticToolExecutor {
  const policy = new PermissionPolicy(mode);
  let exec = new StaticToolExecutor();
  for (const name of toolNames) {
    exec = exec.register(name, (input) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(input) as Record<string, unknown>;
      } catch {
        parsed = { _raw: input };
      }
      return executeTool(name, parsed, policy);
    });
  }
  return exec;
}

/**
 * One-shot prompt using `ProviderClient` + `ConversationRuntime` (network required unless fetch is mocked).
 * With `resumeSessionPath`, loads prior messages (or creates the file) and appends new turns to the same JSONL file.
 */
export async function runPromptMode(input: RunPromptModeInput): Promise<TurnSummary> {
  const session = input.resumeSessionPath
    ? Session.openAtPath(input.resumeSessionPath)
    : Session.new();

  const provider = await ProviderClient.fromModel(input.model, providerConnectOptionsForSession(session));
  const maxTokens = maxTokensForModel(input.model);
  const defs = input.allowedTools?.length ? cliToolDefinitionsForNames(input.allowedTools) : [];
  const toolNames = defs.map((d) => d.name);

  const apiClient = new ProviderRuntimeClient(provider, input.model, maxTokens, {
    tools: defs.length ? defs : undefined,
    toolChoice: defs.length ? { type: "auto" } : undefined
  });

  const runtime = new ConversationRuntime(
    session,
    apiClient,
    toolNames.length ? buildToolExecutor(input.permissionMode, toolNames) : new StaticToolExecutor(),
    new PermissionPolicy(input.permissionMode),
    ["You are a concise, helpful assistant."]
  );

  return runtime.runTurn(input.prompt.trim());
}

export function printPromptSummary(summary: TurnSummary, outputFormat: RunPromptModeInput["outputFormat"]): void {
  if (outputFormat === "json") {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (outputFormat === "ndjson") {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }

  for (const msg of summary.assistantMessages) {
    for (const block of msg.blocks) {
      if (block.type === "text") {
        process.stdout.write(`${block.text}\n`);
      } else if (block.type === "tool_use") {
        process.stdout.write(`[tool_use ${block.name} id=${block.id}]\n`);
      }
    }
  }
}
