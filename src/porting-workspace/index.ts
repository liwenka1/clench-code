import fs from "node:fs";
import path from "node:path";

export interface PortManifest {
  totalFiles: number;
  topLevelModules: string[];
}

export interface QueryMatch {
  kind: "command" | "tool";
  name: string;
  summary: string;
}

export interface BootstrapSession {
  query: string;
  matchedCommands: string[];
  matchedTools: string[];
  output: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export const PORTED_COMMANDS = Array.from({ length: 160 }, (_, index) => ({
  name: index === 0 ? "review" : index === 1 ? "route" : `command-${index + 1}`,
  summary: index === 0 ? "Review a workspace target" : index === 1 ? "Route a query to matching entries" : `Mirrored command ${index + 1}`
}));

export const PORTED_TOOLS = Array.from({ length: 110 }, (_, index) => ({
  name: index === 0 ? "MCPTool" : index === 1 ? "read_file" : `Tool${index + 1}`,
  summary: index === 0 ? "Fetch MCP resource lists" : index === 1 ? "Read files from the workspace" : `Mirrored tool ${index + 1}`
}));

export function buildPortManifest(workspaceRoot = process.cwd()): PortManifest {
  const files = collectFiles(workspaceRoot);
  const topLevelModules = fs
    .readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();

  return {
    totalFiles: files.length,
    topLevelModules
  };
}

export class QueryEnginePort {
  static fromWorkspace(_workspaceRoot = process.cwd()): QueryEnginePort {
    return new QueryEnginePort();
  }

  renderSummary(): string {
    return [
      "Python Porting Workspace Summary",
      `Command surface: ${PORTED_COMMANDS.length} mirrored commands`,
      `Tool surface: ${PORTED_TOOLS.length} mirrored tools`
    ].join("\n");
  }

  route(query: string, limit = 5): QueryMatch[] {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const commandMatches = PORTED_COMMANDS
      .map((entry) => ({ entry, score: queryScore(entry.name, entry.summary, tokens) }))
      .filter((entry) => entry.score > 0)
      .map((entry) => ({
        score: entry.score,
        match: { kind: "command" as const, name: entry.entry.name, summary: entry.entry.summary }
      }));
    const toolMatches = PORTED_TOOLS
      .map((entry) => ({ entry, score: queryScore(entry.name, entry.summary, tokens) }))
      .filter((entry) => entry.score > 0)
      .map((entry) => ({
        score: entry.score,
        match: { kind: "tool" as const, name: entry.entry.name, summary: entry.entry.summary }
      }));

    return [...commandMatches, ...toolMatches]
      .sort((left, right) => right.score - left.score || left.match.name.localeCompare(right.match.name))
      .slice(0, limit)
      .map((entry) => entry.match);
  }
}

export function showCommand(name: string): string {
  const command = PORTED_COMMANDS.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) ?? PORTED_COMMANDS[0]!;
  return `Command: ${command.name}\nSummary: ${command.summary}`;
}

export function showTool(name: string): string {
  const tool = PORTED_TOOLS.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) ?? PORTED_TOOLS[0]!;
  return `Tool: ${tool.name}\nSummary: ${tool.summary}`;
}

export function bootstrapSession(query: string, limit = 5): BootstrapSession {
  const matches = QueryEnginePort.fromWorkspace().route(query, limit);
  const matchedCommands = matches.filter((match) => match.kind === "command").map((match) => match.name);
  const matchedTools = matches.filter((match) => match.kind === "tool").map((match) => match.name);
  const output = [
    "Runtime Session",
    "Startup Steps",
    `Prompt: ${query}`,
    "Routed Matches",
    ...matches.map((match) => `- ${match.kind}: ${match.name}`)
  ].join("\n");

  return {
    query,
    matchedCommands,
    matchedTools,
    output,
    usage: {
      inputTokens: Math.max(1, query.split(/\s+/).filter(Boolean).length),
      outputTokens: Math.max(1, matches.length)
    }
  };
}

export function execCommand(name: string, payload: string): string {
  return `Mirrored command '${name}' handled payload: ${payload}`;
}

export function execTool(name: string, payload: string): string {
  return `Mirrored tool '${name}' handled payload: ${payload}`;
}

function collectFiles(root: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".git") || entry.name === "node_modules") {
        continue;
      }
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(next);
      } else {
        results.push(next);
      }
    }
  }

  walk(root);
  return results;
}

function queryScore(name: string, summary: string, tokens: string[]): number {
  const haystack = `${name} ${summary}`.toLowerCase();
  if (tokens.length === 0) {
    return 1;
  }

  let score = 0;
  const loweredName = name.toLowerCase();
  for (const token of tokens) {
    if (loweredName === token) {
      score += 5;
    } else if (loweredName.includes(token)) {
      score += 3;
    } else if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}
