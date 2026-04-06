import { spawnSync } from "node:child_process";

export type PluginKind = "builtin" | "bundled" | "external";
export type PluginPermission = "read" | "write" | "execute";
export type PluginToolPermission = "read-only" | "workspace-write" | "danger-full-access";

export interface PluginMetadata {
  name: string;
  version: string;
  description: string;
  kind?: PluginKind;
  permissions?: PluginPermission[];
}

export class PluginHooks {
  constructor(
    readonly preToolUse: string[] = [],
    readonly postToolUse: string[] = [],
    readonly postToolUseFailure: string[] = []
  ) {}

  isEmpty(): boolean {
    return (
      this.preToolUse.length === 0 &&
      this.postToolUse.length === 0 &&
      this.postToolUseFailure.length === 0
    );
  }

  mergedWith(other: PluginHooks): PluginHooks {
    return new PluginHooks(
      [...this.preToolUse, ...other.preToolUse],
      [...this.postToolUse, ...other.postToolUse],
      [...this.postToolUseFailure, ...other.postToolUseFailure]
    );
  }
}

export class PluginLifecycle {
  constructor(
    readonly init: string[] = [],
    readonly shutdown: string[] = []
  ) {}

  isEmpty(): boolean {
    return this.init.length === 0 && this.shutdown.length === 0;
  }
}

export interface PluginToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export class PluginTool {
  constructor(
    readonly pluginId: string,
    readonly pluginName: string,
    readonly definition: PluginToolDefinition,
    readonly command: string,
    readonly args: string[] = [],
    readonly requiredPermission: PluginToolPermission = "workspace-write"
  ) {}

  execute(input: unknown): string {
    const serialized = JSON.stringify(input);
    const output = spawnSync(this.command, this.args, {
      input: serialized,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAWD_PLUGIN_ID: this.pluginId,
        CLAWD_PLUGIN_NAME: this.pluginName,
        CLAWD_TOOL_NAME: this.definition.name,
        CLAWD_TOOL_INPUT: serialized
      }
    });

    if ((output.status ?? 1) !== 0) {
      throw new Error((output.stderr || output.stdout || "plugin tool failed").trim());
    }
    return output.stdout.trim();
  }
}

export class PluginDefinition {
  constructor(
    readonly metadata: PluginMetadata,
    readonly hooks = new PluginHooks(),
    readonly lifecycle = new PluginLifecycle(),
    readonly tools: PluginTool[] = []
  ) {}

  validate(): void {
    if (!this.metadata.name.trim()) {
      throw new Error("plugin name cannot be empty");
    }
    if (!this.metadata.version.trim()) {
      throw new Error("plugin version cannot be empty");
    }
  }

  initialize(): string[] {
    return this.lifecycle.init.map(runLifecycleCommand);
  }

  shutdown(): string[] {
    return this.lifecycle.shutdown.map(runLifecycleCommand);
  }
}

export function parsePluginKind(value: string): PluginKind | undefined {
  return ["builtin", "bundled", "external"].includes(value) ? (value as PluginKind) : undefined;
}

export function parsePluginPermission(value: string): PluginPermission | undefined {
  return ["read", "write", "execute"].includes(value) ? (value as PluginPermission) : undefined;
}

export function parsePluginToolPermission(value: string): PluginToolPermission | undefined {
  return ["read-only", "workspace-write", "danger-full-access"].includes(value)
    ? (value as PluginToolPermission)
    : undefined;
}

export function defaultToolPermissionLabel(): PluginToolPermission {
  return "workspace-write";
}

function runLifecycleCommand(command: string): string {
  const result = spawnSync("sh", ["-lc", command], {
    encoding: "utf8",
    env: process.env
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || result.stdout || "plugin lifecycle failed").trim());
  }
  return result.stdout.trim();
}
