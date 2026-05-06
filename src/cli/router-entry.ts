/** `/help` yes; `/var/foo/session.jsonl` no (absolute path). */
export function looksLikeSlashCommandToken(token: string): boolean {
  return token.startsWith("/") && token.length > 1 && !token.slice(1).includes("/");
}

/** `--resume` is checked before `--session` (same resolution rules). */
export function extractSessionReference(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--resume") {
      return argv[i + 1];
    }
    if (token?.startsWith("--resume=")) {
      return token.slice("--resume=".length);
    }
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--session") {
      return argv[i + 1];
    }
    if (token?.startsWith("--session=")) {
      return token.slice("--session=".length);
    }
  }
  return undefined;
}

export function hasPersistFlag(argv: string[]): boolean {
  return argv.includes("--persist");
}

export function translateHeadlessCommandArgv(argv: string[]): string[] | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === "--persist" || token === "--compact" || token === "--help" || token === "-h") {
      continue;
    }
    if (optionConsumesNextValue(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      continue;
    }
    const slashName = topLevelSlashAlias(token);
    if (!slashName) {
      return undefined;
    }
    return [...argv.slice(0, index), slashName, ...argv.slice(index + 1)];
  }
  return undefined;
}

function optionConsumesNextValue(token: string): boolean {
  return (
    token === "--model" ||
    token === "--permission-mode" ||
    token === "--output-format" ||
    token === "--allowed-tools" ||
    token === "--resume" ||
    token === "--session" ||
    token === "--config"
  );
}

function topLevelSlashAlias(token: string): string | undefined {
  return TOP_LEVEL_SLASH_ALIASES[token];
}

const TOP_LEVEL_SLASH_ALIASES: Record<string, string | undefined> = {
  config: "/config",
  agents: "/agents",
  skills: "/skills",
  tasks: "/tasks",
  teams: "/teams",
  crons: "/crons",
  resume: "/resume",
  cost: "/cost",
  diff: "/diff",
  memory: "/memory",
  model: "/model",
  session: "/session",
  export: "/export",
  history: "/history",
  permissions: "/permissions",
  compact: "/compact",
  clear: "/clear",
  mcp: "/mcp",
  plugin: "/plugin",
  plugins: "/plugins",
  marketplace: "/marketplace"
};
