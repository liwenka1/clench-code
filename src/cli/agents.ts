import fs from "node:fs";
import path from "node:path";

type AgentScope = "project" | "config_home" | "home";

interface AgentRoot {
  scope: AgentScope;
  label: string;
  path: string;
}

interface AgentSummary {
  name: string;
  description?: string;
  model?: string;
  reasoningEffort?: string;
  scope: AgentScope;
  sourceLabel: string;
  shadowedBy?: string;
}

export function renderAgentsCommand(cwd: string, args: string[]): string {
  const normalized = args.map((arg) => arg.trim()).filter(Boolean);
  if (normalized.length === 0 || normalized[0] === "list") {
    if (normalized.length <= 1) {
      return renderAgentsReport(loadAgentsFromRoots(discoverAgentRoots(cwd)));
    }
    return renderAgentsUsage(normalized.join(" "));
  }
  if (isHelpArg(normalized[0]!)) {
    return renderAgentsUsage(normalized.slice(1).join(" ") || undefined);
  }
  if (normalized[0] === "help") {
    return renderAgentsUsage(normalized.slice(1).join(" ") || undefined);
  }
  return renderAgentsUsage(normalized.join(" "));
}

function discoverAgentRoots(cwd: string): AgentRoot[] {
  const roots: AgentRoot[] = [];
  const seen = new Set<string>();

  const push = (scope: AgentScope, label: string, candidate: string) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return;
    }
    seen.add(resolved);
    roots.push({ scope, label, path: resolved });
  };

  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    push("project", "project .claw", path.join(current, ".claw", "agents"));
    push("project", "project .codex", path.join(current, ".codex", "agents"));
    push("project", "project .claude", path.join(current, ".claude", "agents"));
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
  }

  const clawConfigHome = process.env.CLAW_CONFIG_HOME?.trim();
  if (clawConfigHome) {
    push("config_home", "$CLAW_CONFIG_HOME", path.join(clawConfigHome, "agents"));
  }
  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) {
    push("config_home", "$CODEX_HOME", path.join(codexHome, "agents"));
  }
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (claudeConfigDir) {
    push("config_home", "$CLAUDE_CONFIG_DIR", path.join(claudeConfigDir, "agents"));
  }

  const home = process.env.HOME?.trim();
  if (home) {
    push("home", "~/.claw", path.join(home, ".claw", "agents"));
    push("home", "~/.codex", path.join(home, ".codex", "agents"));
    push("home", "~/.claude", path.join(home, ".claude", "agents"));
  }

  return roots;
}

function loadAgentsFromRoots(roots: AgentRoot[]): AgentSummary[] {
  const agents: AgentSummary[] = [];
  const activeSources = new Map<string, string>();

  for (const root of roots) {
    const rootAgents: AgentSummary[] = [];
    for (const entry of fs.readdirSync(root.path, { withFileTypes: true })) {
      if (!entry.isFile() || path.extname(entry.name) !== ".toml") {
        continue;
      }
      const filePath = path.join(root.path, entry.name);
      const contents = fs.readFileSync(filePath, "utf8");
      const fallbackName = path.basename(entry.name, ".toml");
      rootAgents.push({
        name: parseTomlString(contents, "name") ?? fallbackName,
        description: parseTomlString(contents, "description"),
        model: parseTomlString(contents, "model"),
        reasoningEffort: parseTomlString(contents, "model_reasoning_effort"),
        scope: root.scope,
        sourceLabel: root.label
      });
    }

    rootAgents.sort((left, right) => left.name.localeCompare(right.name));
    for (const agent of rootAgents) {
      const key = agent.name.toLowerCase();
      const shadowedBy = activeSources.get(key);
      if (shadowedBy) {
        agent.shadowedBy = shadowedBy;
      } else {
        activeSources.set(key, agent.sourceLabel);
      }
      agents.push(agent);
    }
  }

  return agents;
}

function parseTomlString(contents: string, key: string): string | undefined {
  const line = contents
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${key} =`));
  if (!line) {
    return undefined;
  }
  const rawValue = line.slice(line.indexOf("=") + 1).trim();
  if (!rawValue) {
    return undefined;
  }
  if ((rawValue.startsWith("\"") && rawValue.endsWith("\"")) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
    return rawValue.slice(1, -1).trim();
  }
  return rawValue.replace(/#.*/, "").trim() || undefined;
}

function renderAgentsReport(agents: AgentSummary[]): string {
  if (agents.length === 0) {
    return "No agents found.\n";
  }

  const activeCount = agents.filter((agent) => !agent.shadowedBy).length;
  const lines = ["Agents", `  ${activeCount} active agents`, ""];
  for (const scope of ["project", "config_home", "home"] as const) {
    const group = agents.filter((agent) => agent.scope === scope);
    if (group.length === 0) {
      continue;
    }
    lines.push(`${scopeLabel(scope)}:`);
    for (const agent of group) {
      const detail = [
        agent.name,
        agent.description,
        agent.model,
        agent.reasoningEffort
      ].filter(Boolean).join(" · ");
      lines.push(agent.shadowedBy ? `  (shadowed by ${agent.shadowedBy}) ${detail}` : `  ${detail}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderAgentsUsage(unexpected?: string): string {
  const lines = [
    "Agents",
    "  Usage            /agents [list|help]",
    "  Direct CLI       clench agents [list|help]",
    "  Sources          .claw/agents, .codex/agents, .claude/agents, ~/.claw/agents, ~/.codex/agents, ~/.claude/agents"
  ];
  if (unexpected) {
    lines.push(`  Unexpected       ${unexpected}`);
  }
  return `${lines.join("\n")}\n`;
}

function scopeLabel(scope: AgentScope): string {
  switch (scope) {
    case "project":
      return "Project";
    case "config_home":
      return "Config home";
    case "home":
      return "Home";
  }
}

function isHelpArg(value: string): boolean {
  return value === "help" || value === "-h" || value === "--help";
}
