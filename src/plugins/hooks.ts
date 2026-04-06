import { spawnSync } from "node:child_process";

import { PluginHooks } from "./index.js";

export class HookRunResult {
  constructor(
    readonly denied: boolean,
    readonly failed: boolean,
    readonly messages: string[]
  ) {}

  static allow(messages: string[] = []): HookRunResult {
    return new HookRunResult(false, false, messages);
  }
}

export class HookRunner {
  constructor(private readonly hooks: PluginHooks) {}

  runPreToolUse(toolName: string, toolInput: string): HookRunResult {
    return this.runCommands(this.hooks.preToolUse, "PreToolUse", toolName, toolInput, undefined, false);
  }

  runPostToolUse(toolName: string, toolInput: string, toolOutput: string, isError: boolean): HookRunResult {
    return this.runCommands(this.hooks.postToolUse, "PostToolUse", toolName, toolInput, toolOutput, isError);
  }

  runPostToolUseFailure(toolName: string, toolInput: string, toolError: string): HookRunResult {
    return this.runCommands(
      this.hooks.postToolUseFailure,
      "PostToolUseFailure",
      toolName,
      toolInput,
      toolError,
      true
    );
  }

  private runCommands(
    commands: string[],
    event: string,
    toolName: string,
    toolInput: string,
    toolOutput: string | undefined,
    isError: boolean
  ): HookRunResult {
    if (commands.length === 0) {
      return HookRunResult.allow();
    }

    const messages: string[] = [];
    const payload = JSON.stringify({
      hook_event_name: event,
      tool_name: toolName,
      tool_input_json: toolInput,
      tool_output: toolOutput,
      tool_result_is_error: isError
    });

    for (const command of commands) {
      const result = spawnSync("sh", ["-lc", command], {
        input: payload,
        encoding: "utf8",
        env: {
          ...process.env,
          HOOK_EVENT: event,
          HOOK_TOOL_NAME: toolName,
          HOOK_TOOL_INPUT: toolInput,
          HOOK_TOOL_OUTPUT: toolOutput ?? "",
          HOOK_TOOL_IS_ERROR: isError ? "1" : "0"
        }
      });

      const message = (result.stdout || result.stderr || "").trim();
      if (message) {
        messages.push(message);
      }

      if (result.status === 2) {
        return new HookRunResult(true, false, messages);
      }

      if ((result.status ?? 1) !== 0) {
        return new HookRunResult(false, true, messages);
      }
    }

    return HookRunResult.allow(messages);
  }
}
