import net from "node:net";
import { spawn } from "node:child_process";

import {
  buildAuthorizationUrl,
  clearOauthCredentials,
  credentialsPath,
  exchangeOAuthCode,
  generatePkcePair,
  generateState,
  loopbackRedirectUri,
  loadOauthConfig,
  parseOauthCallbackRequestTarget,
  saveOauthCredentials,
  type OAuthConfig
} from "../runtime";
import type { CliOptions } from "./args";
import { writeStructured } from "./router-commands";
import { renderLogoutView } from "./views";

export interface RouterOAuthIo {
  openBrowser?: (url: string) => Promise<void>;
  waitForOAuthCallback?: (port: number) => Promise<{ code?: string; state?: string; error?: string; errorDescription?: string }>;
}

export async function handleRouterOAuthCommand(parsed: CliOptions, io: RouterOAuthIo = {}): Promise<boolean> {
  if (parsed.command?.type === "login") {
    await printLoginCommand(parsed.outputFormat, io);
    return true;
  }
  if (parsed.command?.type === "logout") {
    printLogoutCommand(parsed.outputFormat);
    return true;
  }
  return false;
}

async function printLoginCommand(outputFormat: "text" | "json" | "ndjson", io: RouterOAuthIo): Promise<void> {
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

  if (outputFormat === "text") {
    process.stdout.write("Starting Claude OAuth login...\n");
    process.stdout.write(`Listening for callback on ${redirectUri}\n`);
  }

  try {
    await (io.openBrowser ?? openBrowser)(authorizeUrl);
  } catch (error) {
    emitLoginBrowserOpenFailure(outputFormat, authorizeUrl, error);
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

  if (outputFormat === "text") {
    process.stdout.write("Claude OAuth login complete.\n");
  } else {
    writeStructured({ kind: "login", callbackPort, redirectUri, message: "Claude OAuth login complete." }, outputFormat);
  }
}

function printLogoutCommand(outputFormat: "text" | "json" | "ndjson"): void {
  const filePath = credentialsPath();
  clearOauthCredentials();
  if (outputFormat === "text") {
    process.stdout.write(renderLogoutView(filePath));
  } else {
    writeStructured({ kind: "logout", credentialsPath: filePath, message: "Claude OAuth credentials cleared." }, outputFormat);
  }
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
