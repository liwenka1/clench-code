import { PermissionPolicy, type PermissionMode } from "../runtime/index.js";

export type ToolSource = "base" | "runtime" | "plugin";

export interface ToolManifestEntry {
  name: string;
  source: ToolSource;
  requiredPermission: PermissionMode;
}

export interface ToolSearchResult {
  name: string;
  source: ToolSource;
}

const BUILTIN_TOOLS: ToolManifestEntry[] = [
  { name: "read_file", source: "base", requiredPermission: "read-only" },
  { name: "grep_search", source: "base", requiredPermission: "read-only" },
  { name: "glob_search", source: "base", requiredPermission: "read-only" },
  { name: "write_file", source: "base", requiredPermission: "workspace-write" },
  { name: "bash", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "Task", source: "runtime", requiredPermission: "read-only" },
  { name: "ToolSearch", source: "runtime", requiredPermission: "read-only" }
];

const TOOL_ALIASES = new Map<string, string>([
  ["Read", "read_file"],
  ["Write", "write_file"],
  ["Grep", "grep_search"],
  ["Glob", "glob_search"],
  ["Bash", "bash"],
  ["AgentTool", "Task"]
]);

export class ToolRegistry {
  constructor(private readonly manifestEntries: ToolManifestEntry[]) {}

  entries(): ToolManifestEntry[] {
    return [...this.manifestEntries];
  }

  search(query: string, maxResults = 5): ToolSearchResult[] {
    const lowered = query.toLowerCase();
    return this.manifestEntries
      .filter((entry) => entry.name.toLowerCase().includes(lowered))
      .slice(0, maxResults)
      .map((entry) => ({ name: entry.name, source: entry.source }));
  }
}

export class GlobalToolRegistry {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionPolicy = new PermissionPolicy("danger-full-access")
  ) {}

  static builtin(): GlobalToolRegistry {
    return new GlobalToolRegistry(new ToolRegistry(BUILTIN_TOOLS));
  }

  entries(): ToolManifestEntry[] {
    return this.registry.entries();
  }

  search(query: string, maxResults = 5): ToolSearchResult[] {
    return this.registry.search(query, maxResults);
  }

  normalizeAllowedTools(allowed: string[]): string[] {
    return allowed.map((tool) => {
      const canonical = TOOL_ALIASES.get(tool) ?? tool;
      const known = this.registry.entries().some((entry) => entry.name === canonical);
      if (!known && !canonical.startsWith("mcp__")) {
        throw new Error(`unknown tool '${tool}'`);
      }
      return canonical;
    });
  }

  executeTool(name: string, input: Record<string, unknown>): string {
    const entry = this.registry.entries().find((tool) => tool.name === name);
    if (!entry) {
      throw new Error(`unknown tool '${name}'`);
    }

    const authorization = this.permissionPolicy
      .withToolRequirement(entry.name, entry.requiredPermission)
      .authorize(
      entry.name,
      JSON.stringify(input)
    );
    if (authorization.type === "deny") {
      throw new Error(authorization.reason);
    }

    if (entry.name === "write_file") {
      return String(input.path ?? "written");
    }
    if (entry.name === "bash") {
      return String(input.command ?? "");
    }
    if (entry.name === "ToolSearch") {
      return JSON.stringify(this.search(String(input.query ?? ""), Number(input.maxResults ?? 5)));
    }
    if (entry.name === "Task") {
      const subagentType = String(input.subagent_type ?? "general-purpose");
      return JSON.stringify({
        subagentType,
        allowedTools: [...allowedToolsForSubagent(subagentType)]
      });
    }
    return JSON.stringify(input);
  }

  withPermissionPolicy(policy: PermissionPolicy): GlobalToolRegistry {
    return new GlobalToolRegistry(this.registry, policy);
  }
}

export function normalizeAllowedTools(allowed: string[]): string[] {
  return GlobalToolRegistry.builtin().normalizeAllowedTools(allowed);
}

export function executeTool(
  name: string,
  input: Record<string, unknown>,
  permissionPolicy = new PermissionPolicy("danger-full-access")
): string {
  return GlobalToolRegistry.builtin().withPermissionPolicy(permissionPolicy).executeTool(name, input);
}

export function allowedToolsForSubagent(subagentType: string): Set<string> {
  const normalized = subagentType.trim().toLowerCase();
  if (normalized === "explore") {
    return new Set(["read_file", "grep_search", "glob_search", "ToolSearch"]);
  }
  if (normalized === "plan") {
    return new Set(["read_file", "grep_search", "glob_search"]);
  }
  if (normalized === "verification") {
    return new Set(["read_file", "grep_search", "bash"]);
  }
  return new Set(["read_file", "grep_search", "glob_search", "write_file", "bash", "ToolSearch"]);
}
