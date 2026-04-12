import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
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
  buildAuthorizationUrl,
  clearOauthCredentials,
  credentialsPath,
  exchangeOAuthCode,
  generatePkcePair,
  generateState,
  loopbackRedirectUri,
  loadOauthConfig,
  loadOauthCredentials,
  loadRuntimeConfig,
  parseOauthCallbackRequestTarget,
  resolveSandboxStatus,
  saveOauthCredentials,
  runtimeSettingsPath
} from "../runtime";
import { oauthTokenIsExpired } from "../runtime/oauth.js";
import { workerStatePath, type OAuthConfig } from "../runtime";
import { parseCliArgs } from "./args";
import { initializeRepo } from "./init";
import { parseMainArgs } from "./main";
import { createTerminalPermissionPrompter, TerminalTurnPresenter } from "./presenter";
import { runReplLoop } from "./repl";
import { printPromptSummary, runPromptMode } from "./prompt-run";
import { resolveSessionFilePath, runCliMainWithArgv } from "./run";
import { printCliUsage } from "./usage";
import { renderDoctorView, renderInitView, renderLogoutView, renderSandboxStatusView, renderVersionView } from "./views";

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

function translateHeadlessCommandArgv(argv: string[]): string[] | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === "--persist" || token === "--compact" || token === "--help" || token === "-h") {
      continue;
    }
    if (
      token === "--model" ||
      token === "--permission-mode" ||
      token === "--output-format" ||
      token === "--allowed-tools" ||
      token === "--resume" ||
      token === "--session" ||
      token === "--config"
    ) {
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

function topLevelSlashAlias(token: string): string | undefined {
  if (token === "config") {
    return "/config";
  }
  if (token === "cost") {
    return "/cost";
  }
  if (token === "diff") {
    return "/diff";
  }
  if (token === "memory") {
    return "/memory";
  }
  if (token === "model") {
    return "/model";
  }
  if (token === "session") {
    return "/session";
  }
  if (token === "export") {
    return "/export";
  }
  if (token === "history") {
    return "/history";
  }
  if (token === "permissions") {
    return "/permissions";
  }
  if (token === "compact") {
    return "/compact";
  }
  if (token === "clear") {
    return "/clear";
  }
  if (token === "mcp") {
    return "/mcp";
  }
  if (token === "plugin") {
    return "/plugin";
  }
  if (token === "plugins") {
    return "/plugins";
  }
  if (token === "marketplace") {
    return "/marketplace";
  }
  return undefined;
}

/**
 * Top-level CLI router: thin slash/status session commands vs one-shot `parseMainArgs` prompt mode.
 */
export async function runCliEntry(
  argv: string[],
  io: {
    stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
    openBrowser?: (url: string) => Promise<void>;
    waitForOAuthCallback?: (port: number) => Promise<{ code?: string; state?: string; error?: string; errorDescription?: string }>;
  } = {}
): Promise<void> {
  const stdin = io.stdin ?? process.stdin;
  const parsed = parseCliArgs(argv);
  if (parsed.command?.type === "version") {
    const version = readCliVersion();
    const payload = {
      kind: "version",
      message: renderVersionView({ version }).trimEnd(),
      version
    };
    if (parsed.outputFormat === "text") {
      process.stdout.write(renderVersionView({ version }));
    } else {
      writeStructured(payload, parsed.outputFormat);
    }
    return;
  }
  if (parsed.command?.type === "init") {
    const report = initializeRepo(process.cwd());
    if (parsed.outputFormat === "text") {
      process.stdout.write(renderInitView(report));
    } else {
      writeStructured({ kind: "init", ...report }, parsed.outputFormat);
    }
    return;
  }
  if (parsed.command?.type === "login") {
    const oauth = loadOauthConfig();
    const config = oauth ?? defaultOauthConfig();
    const callbackPort = config.callbackPort ?? 4545;
    const redirectUri = loopbackRedirectUri(callbackPort);
    const pkce = generatePkcePair();
    const state = generateState();
    const authorizeUrl = buildAuthorizationUrl({
      authorizeUrl: config.authorizeUrl,
      clientId: config.clientId,
      redirectUri,
      scopes: [...config.scopes],
      state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: pkce.challengeMethod,
      extraParams: {}
    });
    if (parsed.outputFormat === "text") {
      process.stdout.write("Starting Claude OAuth login...\n");
      process.stdout.write(`Listening for callback on ${redirectUri}\n`);
    }
    try {
      await (io.openBrowser ?? openBrowser)(authorizeUrl);
    } catch (error) {
      emitLoginBrowserOpenFailure(parsed.outputFormat, authorizeUrl, error);
    }
    const callback = await (io.waitForOAuthCallback ?? waitForOAuthCallback)(callbackPort);
    if (callback.error) {
      throw new Error(`${callback.error}: ${callback.errorDescription ?? "authorization failed"}`);
    }
    const code = callback.code;
    if (!code) {
      throw new Error("callback did not include code");
    }
    const returnedState = callback.state;
    if (!returnedState) {
      throw new Error("callback did not include state");
    }
    if (returnedState !== state) {
      throw new Error("oauth state mismatch");
    }
    const tokenSet = await exchangeOAuthCode(
      config,
      {
        grantType: "authorization_code",
        code,
        redirectUri,
        clientId: config.clientId,
        codeVerifier: pkce.verifier,
        state
      }
    );
    saveOauthCredentials(tokenSet);
    if (parsed.outputFormat === "text") {
      process.stdout.write("Claude OAuth login complete.\n");
    } else {
      writeStructured({ kind: "login", callbackPort, redirectUri, message: "Claude OAuth login complete." }, parsed.outputFormat);
    }
    return;
  }
  if (parsed.command?.type === "logout") {
    const filePath = credentialsPath();
    clearOauthCredentials();
    if (parsed.outputFormat === "text") {
      process.stdout.write(renderLogoutView(filePath));
    } else {
      writeStructured({ kind: "logout", credentialsPath: filePath, message: "Claude OAuth credentials cleared." }, parsed.outputFormat);
    }
    return;
  }
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
  if (parsed.command?.type === "state") {
    const raw = readWorkerState(process.cwd());
    if (parsed.outputFormat === "text") {
      process.stdout.write(`${raw}\n`);
    } else {
      writeStructured(JSON.parse(raw) as unknown, parsed.outputFormat);
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
  const translatedHeadlessArgv = translateHeadlessCommandArgv(argv);

  if (translatedHeadlessArgv) {
    runCliMainWithArgv(translatedHeadlessArgv);
    return;
  }

  if (argv.some(looksLikeSlashCommandToken)) {
    runCliMainWithArgv(argv);
    return;
  }
  if (argv.includes("status")) {
    runCliMainWithArgv(argv);
    return;
  }

  const action = parseMainArgs(argv);
  const stdinContext = await readPipedStdin(stdin);
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
    const tty = Boolean(stdin.isTTY && process.stdout.isTTY);
    if (stdinContext) {
      await runPromptTurn({
        prompt: mergePromptWithStdin("", stdinContext),
        model: action.model,
        permissionMode: action.permissionMode,
        outputFormat: action.outputFormat,
        allowedTools: action.allowedTools,
        resumePath,
        compact: action.compact,
        tty
      });
      return;
    }
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
    const tty = Boolean(stdin.isTTY && process.stdout.isTTY);
    await runPromptTurn({
      prompt: mergePromptWithStdin(action.prompt, stdinContext),
      model: action.model,
      permissionMode: action.permissionMode,
      outputFormat: action.outputFormat,
      allowedTools: action.allowedTools,
      resumePath,
      compact: action.compact,
      tty
    });
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

async function runPromptTurn(input: {
  prompt: string;
  model: string;
  permissionMode: "read-only" | "workspace-write" | "danger-full-access";
  outputFormat: "text" | "json" | "ndjson";
  allowedTools?: string[];
  resumePath?: string;
  compact: boolean;
  tty: boolean;
}): Promise<void> {
  const presenter = input.tty && input.outputFormat === "text" && !input.compact
    ? new TerminalTurnPresenter({ interactive: true, model: input.model })
    : undefined;
  try {
    presenter?.beginTurn();
    const summary = await runPromptMode({
      prompt: input.prompt,
      model: input.model,
      permissionMode: input.permissionMode,
      outputFormat: input.outputFormat,
      allowedTools: input.allowedTools,
      resumeSessionPath: input.resumePath,
      prompter: input.tty && input.permissionMode === "workspace-write" ? createTerminalPermissionPrompter() : undefined,
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
      printPromptSummary(summary, input.outputFormat, { compact: input.compact, model: input.model });
    }
  } catch (error) {
    presenter?.fail(error);
    throw error;
  }
}

async function readPipedStdin(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin
): Promise<string | undefined> {
  if (stdin.isTTY) {
    return undefined;
  }
  let buffer = "";
  for await (const chunk of stdin) {
    buffer += String(chunk);
  }
  return buffer.trim() ? buffer : undefined;
}

function mergePromptWithStdin(prompt: string, stdinContent: string | undefined): string {
  const trimmedPrompt = prompt.trim();
  const trimmedStdin = stdinContent?.trim();
  if (!trimmedStdin) {
    return trimmedPrompt;
  }
  if (!trimmedPrompt) {
    return trimmedStdin;
  }
  return `${trimmedPrompt}\n\n${trimmedStdin}`;
}

async function openBrowser(url: string): Promise<void> {
  const commands: Array<{ program: string; args: string[] }> =
    process.platform === "darwin"
      ? [{ program: "open", args: [url] }]
      : process.platform === "win32"
        ? [{ program: "cmd", args: ["/C", "start", "", url] }]
        : [{ program: "xdg-open", args: [url] }];
  let lastError: unknown;
  for (const command of commands) {
    try {
      const child = spawn(command.program, command.args, { stdio: "ignore", detached: true });
      child.unref();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("no supported browser opener command found");
}

function emitLoginBrowserOpenFailure(
  outputFormat: "text" | "json" | "ndjson",
  authorizeUrl: string,
  error: unknown
): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`warning: failed to open browser automatically: ${message}\n`);
  if (outputFormat === "text") {
    process.stdout.write(`Open this URL manually:\n${authorizeUrl}\n`);
  } else {
    process.stderr.write(`Open this URL manually:\n${authorizeUrl}\n`);
  }
}

async function waitForOAuthCallback(port: number): Promise<{ code?: string; state?: string; error?: string; errorDescription?: string }> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        const requestLine = buffer.split(/\r?\n/, 1)[0];
        if (!requestLine) {
          return;
        }
        try {
          const target = requestLine.split(" ")[1];
          if (!target) {
            throw new Error("missing callback request target");
          }
          const callback = parseOauthCallbackRequestTarget(target);
          const body = callback.error
            ? "Claude OAuth login failed. You can close this window."
            : "Claude OAuth login succeeded. You can close this window.";
          socket.end(
            `HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
          );
          server.close();
          resolve(callback);
        } catch (error) {
          socket.end(
            "HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: 14\r\nconnection: close\r\n\r\ninvalid request"
          );
          server.close();
          reject(error);
        }
      });
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
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

function buildLoginBootstrap() {
  const oauth = loadOauthConfig();
  const config = oauth ?? defaultOauthConfig();
  const callbackPort = config.callbackPort ?? 4545;
  const redirectUri = loopbackRedirectUri(callbackPort);
  const pkce = generatePkcePair();
  const state = generateState();
  const authorizeUrl = buildAuthorizationUrl({
    authorizeUrl: config.authorizeUrl,
    clientId: config.clientId,
    redirectUri,
    scopes: [...config.scopes],
    state,
    codeChallenge: pkce.challenge,
    codeChallengeMethod: pkce.challengeMethod,
    extraParams: {}
  });
  return {
    authorizeUrl,
    callbackPort,
    redirectUri,
    credentialsPath: credentialsPath(),
    configSource: oauth ? "runtime-settings" : "default",
    manualRedirectUrl: config.manualRedirectUrl,
    state,
    codeVerifier: pkce.verifier
  };
}

function defaultOauthConfig(): OAuthConfig {
  return {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://platform.claude.com/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    scopes: [
      "user:profile",
      "user:inference",
      "user:sessions:claude_code"
    ]
  };
}
