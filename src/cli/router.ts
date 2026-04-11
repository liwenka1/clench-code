import path from "node:path";

import {
  detectProviderKind,
  hasOpenAiCompatApiKey,
  readAnthropicBaseUrl,
  readOpenAiBaseUrl,
  readXaiBaseUrl
} from "../api";
import { bootstrapSession, buildPortManifest } from "../porting-workspace/index.js";
import {
  credentialsPath,
  loadOauthConfig,
  loadOauthCredentials,
  loadRuntimeConfig,
  resolveSandboxStatus,
  runtimeSettingsPath
} from "../runtime";
import { oauthTokenIsExpired } from "../runtime/oauth.js";
import { parseCliArgs } from "./args";
import { parseMainArgs } from "./main";
import { createTerminalPermissionPrompter, TerminalTurnPresenter } from "./presenter";
import { runReplLoop } from "./repl";
import { printPromptSummary, runPromptMode } from "./prompt-run";
import { resolveSessionFilePath, runCliMainWithArgv } from "./run";
import { printCliUsage } from "./usage";
import { renderDoctorView, renderSandboxStatusView } from "./views";

/** `/help` yes; `/var/foo/session.jsonl` no (absolute path). */
function looksLikeSlashCommandToken(token: string): boolean {
  return token.startsWith("/") && token.length > 1 && !token.slice(1).includes("/");
}

/** `--resume` is checked before `--session` (same resolution rules). */
function extractSessionReference(argv: string[]): string | undefined {
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

function hasPersistFlag(argv: string[]): boolean {
  return argv.includes("--persist");
}

/**
 * Top-level CLI router: thin slash/status session commands vs one-shot `parseMainArgs` prompt mode.
 */
export async function runCliEntry(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (parsed.command?.type === "doctor") {
    const report = buildDoctorReport(process.cwd(), parsed.model);
    if (parsed.outputFormat === "text") {
      process.stdout.write(renderDoctorView(report));
    } else {
      writeStructured(report, parsed.outputFormat);
    }
    if (report.checks.some((check) => check.status === "fail")) {
      process.exitCode = 1;
    }
    return;
  }
  if (parsed.command?.type === "sandbox") {
    const status = buildSandboxReport(process.cwd());
    if (parsed.outputFormat === "text") {
      process.stdout.write(renderSandboxStatusView(status));
    } else {
      writeStructured(status, parsed.outputFormat);
    }
    return;
  }
  if (parsed.command?.type === "dump-manifests") {
    writeStructured(buildPortManifest(process.cwd()), parsed.outputFormat);
    return;
  }
  if (parsed.command?.type === "bootstrap-plan") {
    const plan = bootstrapSession(parsed.command.query.join(" "), parsed.command.limit);
    if (parsed.outputFormat === "text") {
      process.stdout.write(`${plan.output}\n`);
    } else {
      writeStructured(plan, parsed.outputFormat);
    }
    return;
  }
  const resumeRef = extractSessionReference(argv);
  const persistFlag = hasPersistFlag(argv);

  if (argv.some(looksLikeSlashCommandToken)) {
    runCliMainWithArgv(argv);
    return;
  }
  if (argv.includes("status")) {
    runCliMainWithArgv(argv);
    return;
  }

  const action = parseMainArgs(argv);
  if (action.type === "help") {
    printCliUsage();
    return;
  }

  if (action.type === "repl") {
    let resumePath: string | undefined;
    if (resumeRef) {
      resumePath = resolveSessionFilePath(process.cwd(), resumeRef);
    } else if (persistFlag) {
      resumePath = path.join(process.cwd(), ".clench", "sessions", "default.jsonl");
    }
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (tty) {
      await runReplLoop({
        model: action.model,
        permissionMode: action.permissionMode,
        outputFormat: action.outputFormat,
        allowedTools: action.allowedTools,
        resumeSessionPath: resumePath,
        compact: action.compact
      });
      return;
    }
    runCliMainWithArgv(argv);
    return;
  }

  if (action.type === "prompt" && action.prompt.trim()) {
    let resumePath: string | undefined;
    if (resumeRef) {
      resumePath = resolveSessionFilePath(process.cwd(), resumeRef);
    } else if (persistFlag) {
      resumePath = path.join(process.cwd(), ".clench", "sessions", "default.jsonl");
    }
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const presenter = tty && action.outputFormat === "text" && !action.compact
      ? new TerminalTurnPresenter({ interactive: true, model: action.model })
      : undefined;
    try {
      presenter?.beginTurn();
      const summary = await runPromptMode({
        prompt: action.prompt,
        model: action.model,
        permissionMode: action.permissionMode,
        outputFormat: action.outputFormat,
        allowedTools: action.allowedTools,
        resumeSessionPath: resumePath,
        prompter: tty && action.permissionMode === "workspace-write" ? createTerminalPermissionPrompter() : undefined,
        observer: presenter
          ? {
              onToolResult: ({ toolName, output, isError }) => presenter.onToolResult(toolName, output, isError)
            }
          : undefined,
        onAssistantEvent: presenter ? (event) => presenter.onAssistantEvent(event) : undefined
      });
      if (presenter) {
        presenter.finish(summary);
      } else {
        printPromptSummary(summary, action.outputFormat, { compact: action.compact, model: action.model });
      }
    } catch (error) {
      presenter?.fail(error);
      throw error;
    }
    return;
  }

  if (resumeRef) {
    runCliMainWithArgv(argv);
    return;
  }

  runCliMainWithArgv(argv);
}

function writeStructured(value: unknown, format: "text" | "json" | "ndjson"): void {
  if (format === "ndjson") {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function buildSandboxReport(cwd: string) {
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

function buildDoctorReport(cwd: string, model: string) {
  const runtimeConfig = loadRuntimeConfig(cwd);
  const provider = detectProviderKind(model);
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

  checks.push({
    name: "config",
    status: runtimeConfig.loadedFiles.length > 0 ? "pass" : "warn",
    message: runtimeConfig.loadedFiles.length > 0
      ? `loaded ${runtimeConfig.loadedFiles.length} runtime config file(s)`
      : `no runtime config files loaded (settings path ${runtimeSettingsPath()})`
  });

  const sandbox = buildSandboxReport(cwd);
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
