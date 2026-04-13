import fs from "node:fs";
import path from "node:path";

type SkillScope = "project" | "config_home" | "home";
type SkillOrigin = "skills_dir" | "legacy_commands_dir";

interface SkillRoot {
  scope: SkillScope;
  path: string;
  origin: SkillOrigin;
}

interface SkillSummary {
  name: string;
  description?: string;
  scope: SkillScope;
  origin: SkillOrigin;
  shadowedBy?: SkillScope;
}

interface SkillEntry {
  name: string;
  description?: string;
  skillPath: string;
}

export interface SkillInvocation {
  skillName: string;
  displayName: string;
  description?: string;
  skillPath: string;
  instructions: string;
  argsText: string;
  prompt: string;
  systemPrompt: string;
}

export type ResolvedSkillsCommand =
  | { kind: "local"; output: string }
  | { kind: "invoke"; invocation: SkillInvocation };

export function renderSkillsCommand(cwd: string, args: string[]): string {
  const resolved = resolveSkillsCommand(cwd, args);
  return resolved.kind === "local" ? resolved.output : renderSkillsUsage(args.join(" "));
}

export function resolveSkillsCommand(cwd: string, args: string[]): ResolvedSkillsCommand {
  const normalized = args.map((arg) => arg.trim()).filter(Boolean);
  const raw = normalized.join(" ").trim();
  if (!raw || raw === "list") {
    return { kind: "local", output: renderSkillsReport(loadSkillsFromRoots(discoverSkillRoots(cwd))) };
  }
  if (raw === "install") {
    return { kind: "local", output: renderSkillsUsage("install") };
  }
  if (raw.startsWith("install ")) {
    const source = raw.slice("install ".length).trim();
    if (!source) {
      return { kind: "local", output: renderSkillsUsage("install") };
    }
    return { kind: "local", output: renderSkillInstallReport(installSkill(source, cwd)) };
  }
  if (isHelpArg(raw) || raw === "help") {
    return { kind: "local", output: renderSkillsUsage(undefined) };
  }
  if (raw.startsWith("help ")) {
    return { kind: "local", output: renderSkillsUsage(raw.slice("help ".length).trim() || undefined) };
  }
  return { kind: "invoke", invocation: resolveSkillInvocation(cwd, raw) };
}

export function listActiveSkillNames(cwd: string): string[] {
  return loadSkillsFromRoots(discoverSkillRoots(cwd))
    .filter((skill) => !skill.shadowedBy)
    .map((skill) => skill.name)
    .sort((left, right) => left.localeCompare(right));
}

export function resolveSkillInvocation(cwd: string, args: string): SkillInvocation {
  const [skillToken, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const requested = skillToken?.trim();
  if (!requested) {
    throw new Error("skill must not be empty");
  }

  let skillPath: string;
  try {
    skillPath = resolveSkillPath(cwd, requested);
  } catch (error) {
    const names = listActiveSkillNames(cwd);
    const lines = [`Unknown skill: ${requested} (${error instanceof Error ? error.message : String(error)})`];
    if (names.length > 0) {
      lines.push(`  Available skills: ${names.join(", ")}`);
    }
    lines.push("  Usage: /skills [list|install <path>|help|<skill> [args]]");
    throw new Error(lines.join("\n"));
  }

  const definition = parseSkillDefinition(fs.readFileSync(skillPath, "utf8"));
  const normalizedName = requested.replace(/^[$/]+/, "");
  const displayName = definition.name || fallbackSkillNameFromPath(skillPath);
  const argsText = rest.join(" ").trim();

  return {
    skillName: normalizedName,
    displayName,
    description: definition.description,
    skillPath,
    instructions: definition.instructions,
    argsText,
    prompt: argsText || "Follow the active skill instructions.",
    systemPrompt: renderSkillSystemPrompt({
      skillName: normalizedName,
      displayName,
      description: definition.description,
      skillPath,
      instructions: definition.instructions,
      argsText
    })
  };
}

export function resolveSkillPath(cwd: string, skill: string): string {
  const requested = skill.trim().replace(/^[$/]+/, "");
  if (!requested) {
    throw new Error("skill must not be empty");
  }

  const roots = discoverSkillRoots(cwd);
  for (const root of roots) {
    const entries = readSkillEntries(root);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const directMatch = entries.find((entry) => entry.name === requested);
    if (directMatch) {
      return directMatch.skillPath;
    }
    const caseInsensitiveMatch = entries.find((entry) => entry.name.toLowerCase() === requested.toLowerCase());
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch.skillPath;
    }
  }

  throw new Error(`unknown skill: ${requested}`);
}

function discoverSkillRoots(cwd: string): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const seen = new Set<string>();

  const push = (scope: SkillScope, candidate: string, origin: SkillOrigin) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return;
    }
    seen.add(resolved);
    roots.push({ scope, path: resolved, origin });
  };

  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    push("project", path.join(current, ".claw", "skills"), "skills_dir");
    push("project", path.join(current, ".omc", "skills"), "skills_dir");
    push("project", path.join(current, ".agents", "skills"), "skills_dir");
    push("project", path.join(current, ".codex", "skills"), "skills_dir");
    push("project", path.join(current, ".claude", "skills"), "skills_dir");
    push("project", path.join(current, ".claw", "commands"), "legacy_commands_dir");
    push("project", path.join(current, ".codex", "commands"), "legacy_commands_dir");
    push("project", path.join(current, ".claude", "commands"), "legacy_commands_dir");
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
  }

  const clawConfigHome = process.env.CLAW_CONFIG_HOME?.trim();
  if (clawConfigHome) {
    push("config_home", path.join(clawConfigHome, "skills"), "skills_dir");
    push("config_home", path.join(clawConfigHome, "commands"), "legacy_commands_dir");
  }
  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) {
    push("config_home", path.join(codexHome, "skills"), "skills_dir");
    push("config_home", path.join(codexHome, "commands"), "legacy_commands_dir");
  }
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (claudeConfigDir) {
    push("config_home", path.join(claudeConfigDir, "skills"), "skills_dir");
    push("config_home", path.join(claudeConfigDir, "skills", "omc-learned"), "skills_dir");
    push("config_home", path.join(claudeConfigDir, "commands"), "legacy_commands_dir");
  }

  const home = process.env.HOME?.trim();
  if (home) {
    push("home", path.join(home, ".claw", "skills"), "skills_dir");
    push("home", path.join(home, ".omc", "skills"), "skills_dir");
    push("home", path.join(home, ".codex", "skills"), "skills_dir");
    push("home", path.join(home, ".claude", "skills"), "skills_dir");
    push("home", path.join(home, ".claude", "skills", "omc-learned"), "skills_dir");
    push("home", path.join(home, ".claw", "commands"), "legacy_commands_dir");
    push("home", path.join(home, ".codex", "commands"), "legacy_commands_dir");
    push("home", path.join(home, ".claude", "commands"), "legacy_commands_dir");
  }

  return roots;
}

function loadSkillsFromRoots(roots: SkillRoot[]): SkillSummary[] {
  const skills: SkillSummary[] = [];
  const activeScopes = new Map<string, SkillScope>();

  for (const root of roots) {
    const rootSkills: SkillSummary[] = [];
    for (const entry of readSkillEntries(root)) {
      rootSkills.push({
        name: entry.name,
        description: entry.description,
        scope: root.scope,
        origin: root.origin
      });
    }

    rootSkills.sort((left, right) => left.name.localeCompare(right.name));
    for (const skill of rootSkills) {
      const key = skill.name.toLowerCase();
      const shadowedBy = activeScopes.get(key);
      if (shadowedBy) {
        skill.shadowedBy = shadowedBy;
      } else {
        activeScopes.set(key, skill.scope);
      }
      skills.push(skill);
    }
  }

  return skills;
}

function installSkill(source: string, cwd: string): {
  invocationName: string;
  source: string;
  installedPath: string;
  installRoot: string;
} {
  const resolvedSource = resolveSkillInstallSource(source, cwd);
  const promptPath = resolvedSource.type === "directory"
    ? path.join(resolvedSource.path, "SKILL.md")
    : resolvedSource.path;
  const contents = fs.readFileSync(promptPath, "utf8");
  const declared = parseSkillDefinition(contents).name;
  const fallback = resolvedSource.type === "directory"
    ? path.basename(resolvedSource.path)
    : path.basename(resolvedSource.path, path.extname(resolvedSource.path));
  const invocationName = deriveInstallName(declared ?? fallback);
  const installRoot = defaultSkillInstallRoot();
  const installedPath = path.join(installRoot, invocationName);

  if (fs.existsSync(installedPath)) {
    throw new Error(`skill '${invocationName}' is already installed at ${installedPath}`);
  }

  fs.mkdirSync(installedPath, { recursive: true });
  try {
    if (resolvedSource.type === "directory") {
      fs.cpSync(resolvedSource.path, installedPath, { recursive: true });
    } else {
      fs.copyFileSync(resolvedSource.path, path.join(installedPath, "SKILL.md"));
    }
  } catch (error) {
    fs.rmSync(installedPath, { recursive: true, force: true });
    throw error;
  }

  return {
    invocationName,
    source: resolvedSource.path,
    installedPath,
    installRoot
  };
}

function parseSkillDefinition(contents: string): { name?: string; description?: string; instructions: string } {
  const lines = contents.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { instructions: contents.trim() };
  }
  let name: string | undefined;
  let description: string | undefined;
  let frontmatterEndIndex = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "---") {
      frontmatterEndIndex = index;
      break;
    }
    if (line.startsWith("name:")) {
      const value = unquoteFrontmatterValue(line.slice("name:".length).trim());
      if (value) {
        name = value;
      }
      continue;
    }
    if (line.startsWith("description:")) {
      const value = unquoteFrontmatterValue(line.slice("description:".length).trim());
      if (value) {
        description = value;
      }
    }
  }
  return {
    name,
    description,
    instructions: lines.slice(frontmatterEndIndex + 1).join("\n").trim()
  };
}

function readSkillEntries(root: SkillRoot): SkillEntry[] {
  const entries: SkillEntry[] = [];
  for (const entry of fs.readdirSync(root.path, { withFileTypes: true })) {
    if (root.origin === "skills_dir") {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillPath = path.join(root.path, entry.name, "SKILL.md");
      if (!fs.existsSync(skillPath) || !fs.statSync(skillPath).isFile()) {
        continue;
      }
      const definition = parseSkillDefinition(fs.readFileSync(skillPath, "utf8"));
      entries.push({
        name: definition.name || entry.name,
        description: definition.description,
        skillPath
      });
      continue;
    }

    const candidatePath = path.join(root.path, entry.name);
    const markdownPath = entry.isDirectory()
      ? path.join(candidatePath, "SKILL.md")
      : candidatePath;
    const isMarkdown = markdownPath.toLowerCase().endsWith(".md");
    if (!fs.existsSync(markdownPath) || !fs.statSync(markdownPath).isFile() || !isMarkdown) {
      continue;
    }
    const definition = parseSkillDefinition(fs.readFileSync(markdownPath, "utf8"));
    const fallbackName = path.basename(markdownPath, path.extname(markdownPath));
    entries.push({
      name: definition.name || fallbackName,
      description: definition.description,
      skillPath: markdownPath
    });
  }
  return entries;
}

function unquoteFrontmatterValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}

function renderSkillsReport(skills: SkillSummary[]): string {
  if (skills.length === 0) {
    return "No skills found.\n";
  }

  const activeCount = skills.filter((skill) => !skill.shadowedBy).length;
  const lines = ["Skills", `  ${activeCount} active skills`, ""];
  for (const scope of ["project", "config_home", "home"] as const) {
    const group = skills.filter((skill) => skill.scope === scope);
    if (group.length === 0) {
      continue;
    }
    lines.push(`${scopeLabel(scope)}:`);
    for (const skill of group) {
      const detail = [skill.name, skill.description].filter(Boolean).join(" · ");
      lines.push(skill.shadowedBy ? `  (shadowed by ${scopeLabel(skill.shadowedBy)}) ${detail}` : `  ${detail}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderSkillsUsage(unexpected?: string): string {
  const lines = [
    "Skills",
    "  Usage            /skills [list|install <path>|help|<skill> [args]]",
    "  Alias            /skill",
    "  Direct CLI       clench skills [list|install <path>|help|<skill> [args]]",
    "  Install root     $CLAW_CONFIG_HOME/skills or ~/.claw/skills",
    "  Sources          .claw/skills, .omc/skills, .agents/skills, .codex/skills, .claude/skills, ~/.claw/skills, ~/.omc/skills, ~/.codex/skills, ~/.claude/skills, ~/.claude/skills/omc-learned, legacy /commands"
  ];
  if (unexpected) {
    lines.push(`  Unexpected       ${unexpected}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderSkillInstallReport(skill: {
  invocationName: string;
  source: string;
  installedPath: string;
  installRoot: string;
}): string {
  return [
    "Skill installed",
    `  Invocation name  ${skill.invocationName}`,
    `  Source           ${skill.source}`,
    `  Installed path   ${skill.installedPath}`,
    `  Install root     ${skill.installRoot}`
  ].join("\n") + "\n";
}

function renderSkillSystemPrompt(skill: {
  skillName: string;
  displayName: string;
  description?: string;
  skillPath: string;
  instructions: string;
  argsText: string;
}): string {
  return [
    "# Active skill",
    `- Invocation name: ${skill.skillName}`,
    `- Display name: ${skill.displayName}`,
    `- Source: ${skill.skillPath}`,
    ...(skill.description ? [`- Description: ${skill.description}`] : []),
    ...(skill.argsText ? [`- Invocation arguments: ${skill.argsText}`] : []),
    "",
    "# Skill instructions",
    skill.instructions || "_No skill instructions found._"
  ].join("\n");
}

function fallbackSkillNameFromPath(skillPath: string): string {
  if (path.basename(skillPath).toLowerCase() === "skill.md") {
    return path.basename(path.dirname(skillPath));
  }
  return path.basename(skillPath, path.extname(skillPath));
}

function scopeLabel(scope: SkillScope): string {
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

function resolveSkillInstallSource(source: string, cwd: string): { type: "directory" | "markdown"; path: string } {
  const candidate = path.isAbsolute(source) ? source : path.join(cwd, source);
  const resolved = fs.realpathSync(candidate);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const skillPath = path.join(resolved, "SKILL.md");
    if (!fs.existsSync(skillPath) || !fs.statSync(skillPath).isFile()) {
      throw new Error(`skill directory '${resolved}' must contain SKILL.md`);
    }
    return { type: "directory", path: resolved };
  }
  if (stat.isFile() && path.extname(resolved).toLowerCase() === ".md") {
    return { type: "markdown", path: resolved };
  }
  throw new Error(`skill source '${resolved}' must be a directory with SKILL.md or a markdown file`);
}

function defaultSkillInstallRoot(): string {
  const clawConfigHome = process.env.CLAW_CONFIG_HOME?.trim();
  if (clawConfigHome) {
    return path.join(clawConfigHome, "skills");
  }
  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) {
    return path.join(codexHome, "skills");
  }
  const home = process.env.HOME?.trim();
  if (home) {
    return path.join(home, ".claw", "skills");
  }
  throw new Error("unable to resolve a skills install root; set CLAW_CONFIG_HOME or HOME");
}

function deriveInstallName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error(`unable to derive an installable invocation name from '${raw}'`);
  }
  return normalized;
}
