import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  runtimeSettingsPath,
  workerStatePath
} from "../runtime";
import { oauthTokenIsExpired } from "../runtime/oauth.js";
import type { CliOptions } from "./args";
import { initializeRepo } from "./init";
import { runMcpServe } from "./mcp-serve";
import { renderDoctorView, renderInitView, renderSandboxStatusView, renderVersionView } from "./views";

export async function handleRouterCommand(parsed: CliOptions, cwd: string): Promise<boolean> {
  switch (parsed.command?.type) {
    case "version":
      printVersionCommand(parsed.outputFormat);
      return true;
    case "init":
      printInitCommand(cwd, parsed.outputFormat);
      return true;
    case "doctor":
      printDoctorCommand(cwd, parsed.model, parsed.outputFormat);
      return true;
    case "sandbox":
      printSandboxCommand(cwd, parsed.outputFormat);
      return true;
    case "state":
      printStateCommand(cwd, parsed.outputFormat);
      return true;
    case "mcp-serve":
      await runMcpServe();
      return true;
    case "dump-manifests":
      writeStructured(buildPortManifest(cwd), parsed.outputFormat);
      return true;
    case "bootstrap-plan":
      printBootstrapPlanCommand(parsed.command.query, parsed.command.limit, parsed.outputFormat);
      return true;
    default:
      return false;
  }
}

export function writeStructured(value: unknown, format: "text" | "json" | "ndjson"): void {
  if (format === "ndjson") {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printVersionCommand(outputFormat: "text" | "json" | "ndjson"): void {
  const version = readCliVersion();
  const payload = {
    kind: "version",
    message: renderVersionView({ version }).trimEnd(),
    version
  };
  if (outputFormat === "text") {
    process.stdout.write(renderVersionView({ version }));
  } else {
    writeStructured(payload, outputFormat);
  }
}

function printInitCommand(cwd: string, outputFormat: "text" | "json" | "ndjson"): void {
  const report = initializeRepo(cwd);
  if (outputFormat === "text") {
    process.stdout.write(renderInitView(report));
  } else {
    writeStructured({ kind: "init", ...report }, outputFormat);
  }
}

function printDoctorCommand(cwd: string, model: string, outputFormat: "text" | "json" | "ndjson"): void {
  const report = buildDoctorReport(cwd, model);
  if (outputFormat === "text") {
    process.stdout.write(renderDoctorView(report));
  } else {
    writeStructured(report, outputFormat);
  }
  if (report.checks.some((check) => check.status === "fail")) {
    process.exitCode = 1;
  }
}

function printSandboxCommand(cwd: string, outputFormat: "text" | "json" | "ndjson"): void {
  const status = buildSandboxReport(cwd);
  if (outputFormat === "text") {
    process.stdout.write(renderSandboxStatusView(status));
  } else {
    writeStructured(status, outputFormat);
  }
}

function printStateCommand(cwd: string, outputFormat: "text" | "json" | "ndjson"): void {
  const raw = readWorkerState(cwd);
  if (outputFormat === "text") {
    process.stdout.write(`${raw}\n`);
  } else {
    writeStructured(JSON.parse(raw) as unknown, outputFormat);
  }
}

function printBootstrapPlanCommand(
  query: string[],
  limit: number | undefined,
  outputFormat: "text" | "json" | "ndjson"
): void {
  const plan = bootstrapSession(query.join(" "), limit);
  if (outputFormat === "text") {
    process.stdout.write(`${plan.output}\n`);
  } else {
    writeStructured(plan, outputFormat);
  }
}

function readWorkerState(cwd: string): string {
  const filePath = workerStatePath(cwd);
  if (!path.isAbsolute(filePath)) {
    throw new Error(`invalid worker state path: ${filePath}`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`no worker state file found at ${filePath} - run a worker first`);
  }
  return fs.readFileSync(filePath, "utf8").trim();
}

function readCliVersion(): string {
  const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: string };
  return parsed.version ?? "0.0.0";
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

function countConfigValidationErrors(validation: ReturnType<typeof loadRuntimeConfig>["validation"]): number {
  return Object.values(validation).reduce((count, result) => count + result.errors.length, 0);
}

function countConfigValidationWarnings(validation: ReturnType<typeof loadRuntimeConfig>["validation"]): number {
  return Object.values(validation).reduce((count, result) => count + result.warnings.length, 0);
}
