import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { McpServer, type McpServerSpec } from "../runtime/index.js";
import type { McpToolDefinition } from "../runtime/index.js";
import { loadWorkspaceToolRegistryAsync } from "../tools/index.js";

export interface RunMcpServeInput {
  cwd?: string;
  stdin?: Readable;
  stdout?: Writable;
  serverName?: string;
  serverVersion?: string;
}

/** Starts a minimal MCP stdio server that exposes this workspace's tool
 * surface to external MCP clients.
 *
 * Mirrors the reference project's `claw mcp serve`: tool descriptors come
 * from the workspace tool registry and `tools/call` is dispatched through
 * `GlobalToolRegistry.executeToolAsync`, so the served surface matches
 * exactly what the in-process agent loop sees. */
export async function runMcpServe(input: RunMcpServeInput = {}): Promise<void> {
  const cwd = input.cwd ?? process.cwd();
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const registry = await loadWorkspaceToolRegistryAsync(cwd);
  const tools = collectToolDefinitions(registry);
  const spec: McpServerSpec = {
    serverName: input.serverName ?? "clench",
    serverVersion: input.serverVersion ?? readCliVersion(),
    tools,
    toolHandler: async (name, args) => {
      const payload = toRecord(args);
      return await registry.executeToolAsync(name, payload);
    }
  };
  const server = new McpServer(spec);
  await server.run(stdin, stdout);
}

function collectToolDefinitions(registry: {
  entries(): Array<{ name: string }>;
  toolDefinition(name: string): { name: string; description?: string; input_schema?: unknown } | undefined;
}): McpToolDefinition[] {
  const seen = new Set<string>();
  const out: McpToolDefinition[] = [];
  for (const entry of registry.entries()) {
    if (seen.has(entry.name)) {
      continue;
    }
    seen.add(entry.name);
    const definition = registry.toolDefinition(entry.name);
    if (!definition) {
      continue;
    }
    out.push({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.input_schema
    });
  }
  return out;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readCliVersion(): string {
  try {
    const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
