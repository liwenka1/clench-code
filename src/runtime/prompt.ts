import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { RuntimeConfig } from "./config.js";

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
export const FRONTIER_MODEL_NAME = "Claude Opus 4.6";
const MAX_INSTRUCTION_FILE_CHARS = 4_000;
const MAX_TOTAL_INSTRUCTION_CHARS = 12_000;

export interface ContextFile {
  path: string;
  content: string;
}

export interface ProjectContext {
  cwd: string;
  currentDate: string;
  gitStatus?: string;
  gitDiff?: string;
  instructionFiles: ContextFile[];
}

export class SystemPromptBuilder {
  private outputStyleName?: string;
  private outputStylePrompt?: string;
  private osName?: string;
  private osVersion?: string;
  private extraSections: string[] = [];
  private projectContext?: ProjectContext;
  private config?: RuntimeConfig;

  withOutputStyle(name: string, prompt: string): SystemPromptBuilder {
    this.outputStyleName = name;
    this.outputStylePrompt = prompt;
    return this;
  }

  withOs(osName: string, osVersion: string): SystemPromptBuilder {
    this.osName = osName;
    this.osVersion = osVersion;
    return this;
  }

  withProjectContext(projectContext: ProjectContext): SystemPromptBuilder {
    this.projectContext = projectContext;
    return this;
  }

  withRuntimeConfig(config: RuntimeConfig): SystemPromptBuilder {
    this.config = config;
    return this;
  }

  appendSection(section: string): SystemPromptBuilder {
    this.extraSections.push(section);
    return this;
  }

  build(): string[] {
    const sections = [
      getSimpleIntroSection(Boolean(this.outputStyleName)),
      ...(this.outputStyleName && this.outputStylePrompt ? [`# Output Style: ${this.outputStyleName}\n${this.outputStylePrompt}`] : []),
      getSimpleSystemSection(),
      getSimpleDoingTasksSection(),
      getActionsSection(),
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      this.environmentSection()
    ];

    if (this.projectContext) {
      sections.push(renderProjectContext(this.projectContext));
      if (this.projectContext.instructionFiles.length > 0) {
        sections.push(renderInstructionFiles(this.projectContext.instructionFiles));
      }
    }
    if (this.config) {
      sections.push(renderConfigSection(this.config));
    }
    sections.push(...this.extraSections);
    return sections;
  }

  render(): string {
    return this.build().join("\n\n");
  }

  private environmentSection(): string {
    return [
      "# Environment context",
      ...prependBullets([
        `Model family: ${FRONTIER_MODEL_NAME}`,
        `Working directory: ${this.projectContext?.cwd ?? "unknown"}`,
        `Date: ${this.projectContext?.currentDate ?? "unknown"}`,
        `Platform: ${this.osName ?? "unknown"} ${this.osVersion ?? "unknown"}`
      ])
    ].join("\n");
  }
}

export function prependBullets(items: string[]): string[] {
  return items.map((item) => ` - ${item}`);
}

export function discoverProjectContext(cwd: string, currentDate: string): ProjectContext {
  return {
    cwd,
    currentDate,
    gitStatus: readGitStatus(cwd),
    gitDiff: readGitDiff(cwd),
    instructionFiles: discoverInstructionFiles(cwd)
  };
}

export function renderInstructionFiles(files: ContextFile[]): string {
  const sections = ["# Claude instructions"];
  let remaining = MAX_TOTAL_INSTRUCTION_CHARS;
  for (const file of files) {
    if (remaining === 0) {
      sections.push("_Additional instruction content omitted after reaching the prompt budget._");
      break;
    }
    const rendered = renderInstructionContent(truncateInstructionContent(file.content, remaining));
    remaining = Math.max(0, remaining - rendered.length);
    sections.push(`## ${describeInstructionFile(file)}`);
    sections.push(rendered);
  }
  return sections.join("\n\n");
}

export function truncateInstructionContent(content: string, remainingChars: number): string {
  const hardLimit = Math.min(MAX_INSTRUCTION_FILE_CHARS, remainingChars);
  const trimmed = content.trim();
  if (trimmed.length <= hardLimit) {
    return trimmed;
  }
  return `${trimmed.slice(0, hardLimit)}\n\n[truncated]`;
}

export function renderInstructionContent(content: string): string {
  return truncateInstructionContent(content, MAX_INSTRUCTION_FILE_CHARS);
}

export function collapseBlankLines(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n");
}

export function normalizeInstructionContent(content: string): string {
  return collapseBlankLines(content).trim();
}

export function displayContextPath(filePath: string): string {
  return path.basename(filePath) || filePath;
}

export function renderProjectContext(projectContext: ProjectContext): string {
  const lines = [
    "# Project context",
    ...prependBullets([
      `Today's date is ${projectContext.currentDate}.`,
      `Working directory: ${projectContext.cwd}`
    ])
  ];
  if (projectContext.instructionFiles.length > 0) {
    lines.push(...prependBullets([`Claude instruction files discovered: ${projectContext.instructionFiles.length}.`]));
  }
  if (projectContext.gitStatus) {
    lines.push("", "Git status snapshot:", projectContext.gitStatus);
  }
  if (projectContext.gitDiff) {
    lines.push("", "Git diff snapshot:", projectContext.gitDiff);
  }
  return lines.join("\n");
}

function renderConfigSection(config: RuntimeConfig): string {
  return ["# Runtime config", JSON.stringify(config, null, 2)].join("\n");
}

function discoverInstructionFiles(cwd: string): ContextFile[] {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  directories.reverse();

  const files: ContextFile[] = [];
  for (const dir of directories) {
    for (const candidate of [
      path.join(dir, "CLAUDE.md"),
      path.join(dir, "CLAUDE.local.md"),
      path.join(dir, ".clench", "CLAUDE.md"),
      path.join(dir, ".clench", "instructions.md")
    ]) {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const content = fs.readFileSync(candidate, "utf8");
      if (content.trim()) {
        files.push({ path: candidate, content });
      }
    }
  }

  const seen = new Set<string>();
  return files.filter((file) => {
    const normalized = normalizeInstructionContent(file.content);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function describeInstructionFile(file: ContextFile): string {
  return `${displayContextPath(file.path)} (scope: ${path.dirname(file.path)})`;
}

function readGitStatus(cwd: string): string | undefined {
  try {
    const output = execFileSync("git", ["--no-optional-locks", "status", "--short", "--branch"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function readGitDiff(cwd: string): string | undefined {
  try {
    const staged = execFileSync("git", ["diff", "--cached"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const unstaged = execFileSync("git", ["diff"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const sections = [
      ...(staged ? [`Staged changes:\n${staged}`] : []),
      ...(unstaged ? [`Unstaged changes:\n${unstaged}`] : [])
    ];
    return sections.length > 0 ? sections.join("\n\n") : undefined;
  } catch {
    return undefined;
  }
}

function getSimpleIntroSection(hasOutputStyle: boolean): string {
  return `You are an interactive agent that helps users ${
    hasOutputStyle
      ? 'according to your "Output Style" below, which describes how you should respond to user queries.'
      : "with software engineering tasks."
  } Use the instructions below and the tools available to you to assist the user.`;
}

function getSimpleSystemSection(): string {
  return ["# System", ...prependBullets([
    "All text you output outside of tool use is displayed to the user.",
    "Tools are executed in a user-selected permission mode.",
    "Tool results and user messages may include system tags carrying runtime information."
  ])].join("\n");
}

function getSimpleDoingTasksSection(): string {
  return ["# Doing tasks", ...prependBullets([
    "Read relevant code before changing it and keep changes tightly scoped to the request.",
    "Do not add speculative abstractions, compatibility shims, or unrelated cleanup.",
    "Report outcomes faithfully: if verification fails or was not run, say so explicitly."
  ])].join("\n");
}

function getActionsSection(): string {
  return "# Executing actions with care\nCarefully consider reversibility and blast radius before taking an action.";
}
