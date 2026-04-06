import type { ToolDefinition } from "../api/types";

/** Maps `cli/main` allowed names (`grep`, `glob`) to registry / API names. */
const CLI_TO_API: Record<string, string> = {
  bash: "bash",
  read_file: "read_file",
  write_file: "write_file",
  grep: "grep_search",
  glob: "glob_search"
};

const DESCRIPTIONS: Record<string, string> = {
  bash: "Run a shell command in the workspace",
  read_file: "Read a file path",
  write_file: "Write content to a file path",
  grep_search: "Search files with regex",
  glob_search: "Glob file patterns"
};

/** Minimal JSON-schema placeholders; real validation happens in tool execution. */
function inputSchemaFor(name: string): Record<string, unknown> {
  if (name === "bash") {
    return {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"]
    };
  }
  if (name === "read_file" || name === "write_file") {
    return {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    };
  }
  return {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" }
    }
  };
}

/** Anthropic `tools` payload for CLI `--allowed-tools` names. */
export function cliToolDefinitionsForNames(cliNames: string[]): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of cliNames) {
    const key = raw.trim().toLowerCase();
    const apiName = CLI_TO_API[key];
    if (!apiName || seen.has(apiName)) {
      continue;
    }
    seen.add(apiName);
    out.push({
      name: apiName,
      description: DESCRIPTIONS[apiName] ?? `Tool ${apiName}`,
      input_schema: inputSchemaFor(apiName)
    });
  }
  return out;
}
