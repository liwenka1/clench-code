import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  detectProviderKind,
  hasOpenAiCompatApiKey,
  readAnthropicBaseUrl,
  readOpenAiBaseUrl,
  readXaiBaseUrl
} from "../api/index.js";
import {
  credentialsPath,
  loadOauthConfig,
  loadOauthCredentials,
  loadRuntimeConfig,
  resolveSandboxStatus,
  runtimeSettingsPath
} from "../runtime/index.js";
import { oauthTokenIsExpired } from "../runtime/oauth.js";
import { renderAgentsCommand } from "./agents";
import { initializeRepo } from "./init";
import {
  renderDiffView,
  renderDoctorView,
  renderHelpView,
  renderInitView,
  renderMemoryView,
  renderSandboxStatusView,
  renderVersionView
} from "./views";

export function printHelp(): void {
  process.stdout.write(renderHelpView());
}

export function printAgents(cwd: string, args: string[]): void {
  process.stdout.write(renderAgentsCommand(cwd, args));
}

export function printVersion(): void {
  process.stdout.write(renderVersionView({ version: readCliVersion() }));
}

export function printInit(cwd: string): void {
  process.stdout.write(renderInitView(initializeRepo(cwd)));
}

export function printDoctor(cwd: string, model: string): void {
  process.stdout.write(renderDoctorView(readDoctorReport(cwd, model)));
}

export function printSandbox(cwd: string): void {
  process.stdout.write(renderSandboxStatusView(readSandboxReport(cwd)));
}

export function printDiff(cwd: string): void {
  process.stdout.write(renderDiffView(readDiffReport(cwd)));
}

export function printMemory(cwd: string): void {
  process.stdout.write(renderMemoryView(readMemoryReport(cwd)));
}

function readDiffReport(cwd: string): {
  result: "no_git_repo" | "clean" | "changes";
  detail?: string;
  staged?: string;
  unstaged?: string;
} {
  if (!isInsideGitWorkTree(cwd)) {
    return {
      result: "no_git_repo",
      detail: `${cwd} is not inside a git project`
    };
  }
  const staged = runGitDiffCommand(cwd, ["diff", "--cached"]).trim();
  const unstaged = runGitDiffCommand(cwd, ["diff"]).trim();
  if (!staged && !unstaged) {
    return {
      result: "clean",
      detail: "no current changes"
    };
  }
  return {
    result: "changes",
    staged,
    unstaged
  };
}

function readMemoryReport(cwd: string): {
  cwd: string;
  files: Array<{ path: string; lines: number; preview: string }>;
} {
  return {
    cwd,
    files: discoverInstructionFiles(cwd).map((file) => ({
      path: file.path,
      lines: file.content.split("\n").length,
      preview: file.content.split("\n")[0]?.trim() ?? ""
    }))
  };
}

function readSandboxReport(cwd: string) {
  const { merged } = loadRuntimeConfig(cwd);
  return resolveSandboxStatus(
    {
      enabled: merged.sandbox?.enabled,
      namespaceRestrictions: (merged.sandbox as Record<string, unknown> | undefined)?.namespaceRestrictions as boolean | undefined,
      networkIsolation: (merged.sandbox as Record<string, unknown> | undefined)?.networkIsolation as boolean | undefined,
      filesystemMode: (merged.sandbox as Record<string, unknown> | undefined)?.filesystemMode as "off" | "workspace-only" | "allow-list" | undefined,
      allowedMounts: Array.isArray((merged.sandbox as Record<string, unknown> | undefined)?.allowedMounts)
        ? ((merged.sandbox as Record<string, unknown>).allowedMounts as string[])
        : []
    },
    cwd
  );
}

function readDoctorReport(cwd: string, model: string) {
  const runtimeConfig = loadRuntimeConfig(cwd);
  const provider = detectProviderKind(model, runtimeConfig.merged);
  const savedOauth = loadOauthCredentials();
  const oauthConfig = loadOauthConfig();
  const anthropicApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const anthropicBearer = Boolean(process.env.ANTHROPIC_AUTH_TOKEN?.trim());
  const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }> = [];

  if (anthropicApiKey || anthropicBearer) {
    checks.push({
      name: "auth",
      status: "pass",
      message: `anthropic env credentials detected (api_key=${anthropicApiKey}, bearer=${anthropicBearer})`
    });
  } else if (savedOauth && !oauthTokenIsExpired(savedOauth)) {
    checks.push({
      name: "auth",
      status: "pass",
      message: `saved oauth bearer available at ${credentialsPath()}`
    });
  } else if (savedOauth?.refreshToken && oauthConfig) {
    checks.push({
      name: "auth",
      status: "warn",
      message: "saved oauth token is expired but refresh config is present"
    });
  } else {
    checks.push({
      name: "auth",
      status: "fail",
      message: "no usable Anthropic credentials found in env or saved oauth credentials"
    });
  }

  const openAiPresent = hasOpenAiCompatApiKey("OPENAI_API_KEY");
  const xaiPresent = hasOpenAiCompatApiKey("XAI_API_KEY");
  checks.push({
    name: "provider endpoints",
    status: "pass",
    message: `anthropic=${readAnthropicBaseUrl()} openai=${readOpenAiBaseUrl()} xai=${readXaiBaseUrl()} env(openai=${openAiPresent}, xai=${xaiPresent})`
  });

  const validationErrorCount = countConfigValidationErrors(runtimeConfig.validation);
  const validationWarningCount = countConfigValidationWarnings(runtimeConfig.validation);
  const skippedConfigCount = runtimeConfig.loadDiagnostics.length;
  checks.push({
    name: "config",
    status: skippedConfigCount > 0 || validationErrorCount > 0
      ? "fail"
      : runtimeConfig.loadedFiles.length > 0
        ? validationWarningCount > 0 ? "warn" : "pass"
        : "warn",
    message: runtimeConfig.loadedFiles.length > 0 || skippedConfigCount > 0
      ? `loaded ${runtimeConfig.loadedFiles.length} runtime config file(s), skipped ${skippedConfigCount}, diagnostics ${validationErrorCount} error(s) ${validationWarningCount} warning(s)`
      : `no runtime config files loaded (settings path ${runtimeSettingsPath()})`
  });

  const sandbox = readSandboxReport(cwd);
  checks.push({
    name: "sandbox",
    status: sandbox.enabled && !sandbox.active ? "warn" : "pass",
    message: sandbox.enabled
      ? `enabled=${sandbox.enabled} active=${sandbox.active}${sandbox.fallbackReason ? ` fallback=${sandbox.fallbackReason}` : ""}`
      : "sandbox disabled in config"
  });

  return {
    cwd,
    model,
    provider,
    configFiles: runtimeConfig.loadedFiles,
    checks
  };
}

function countConfigValidationErrors(validation: ReturnType<typeof loadRuntimeConfig>["validation"]): number {
  return Object.values(validation).reduce((count, result) => count + result.errors.length, 0);
}

function countConfigValidationWarnings(validation: ReturnType<typeof loadRuntimeConfig>["validation"]): number {
  return Object.values(validation).reduce((count, result) => count + result.warnings.length, 0);
}

function discoverInstructionFiles(cwd: string): Array<{ path: string; content: string }> {
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

  const files: Array<{ path: string; content: string }> = [];
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
    const normalized = file.content.replace(/\n{3,}/g, "\n\n").trim();
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function readCliVersion(): string {
  const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: string };
  return parsed.version ?? "0.0.0";
}

function isInsideGitWorkTree(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

function runGitDiffCommand(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}
