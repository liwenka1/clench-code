import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

import {
  buildAuthorizationUrl,
  credentialsPath,
  exchangeOAuthCode,
  generatePkcePair,
  generateState,
  loopbackRedirectUri,
  loadOauthConfig,
  parseOauthCallbackRequestTarget,
  saveOauthCredentials,
} from "../runtime";
import type { OAuthConfig } from "../runtime";
import { parseCliArgs } from "./args";
import { parseMainArgs } from "./main";
import { createTerminalPermissionPrompter, TerminalTurnPresenter } from "./presenter";
import { runReplLoop } from "./repl";
import { printPromptSummary, runPromptMode } from "./prompt-run";
import { handleRouterCommand, writeStructured } from "./router-commands";
import {
  extractSessionReference,
  hasPersistFlag,
  looksLikeSlashCommandToken,
  translateHeadlessCommandArgv
} from "./router-entry";
import { resolveSessionFilePath, runCliMainWithArgv } from "./run";
import { printCliUsage } from "./usage";

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
  const parsed = parseCliArgs(argv, process.cwd());
  if (await handleRouterCommand(parsed, process.cwd())) {
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
  const resumeRef = extractSessionReference(argv);
  const persistFlag = hasPersistFlag(argv);
  const translatedHeadlessArgv = translateHeadlessCommandArgv(argv);

  if (translatedHeadlessArgv) {
    await runCliMainWithArgv(translatedHeadlessArgv);
    return;
  }

  if (argv.some(looksLikeSlashCommandToken)) {
    await runCliMainWithArgv(argv);
    return;
  }
  if (argv.includes("status")) {
    await runCliMainWithArgv(argv);
    return;
  }

  const action = parseMainArgs(argv, process.cwd());
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
    await runCliMainWithArgv(argv);
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
    await runCliMainWithArgv(argv);
    return;
  }

  await runCliMainWithArgv(argv);
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
