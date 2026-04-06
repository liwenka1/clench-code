import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  inheritedUpstreamProxyEnv,
  noProxyList,
  readSessionToken,
  remoteSessionContextFromEnvMap,
  upstreamProxyBootstrapFromEnvMap,
  upstreamProxyShouldEnable,
  upstreamProxyStateForPort,
  upstreamProxySubprocessEnv,
  upstreamProxyWsUrl
} from "../../src/runtime/remote.js";

describe("runtime remote", () => {
  test("ports remote mode helper behavior", async () => {
    const context = remoteSessionContextFromEnvMap({
      CLAUDE_CODE_REMOTE: "true",
      CLAUDE_CODE_REMOTE_SESSION_ID: "session-123",
      ANTHROPIC_BASE_URL: "https://remote.test"
    });
    expect(context.enabled).toBe(true);
    expect(context.sessionId).toBe("session-123");
    expect(context.baseUrl).toBe("https://remote.test");

    const failOpen = upstreamProxyBootstrapFromEnvMap({
      CLAUDE_CODE_REMOTE: "1",
      CCR_UPSTREAM_PROXY_ENABLED: "true"
    });
    expect(upstreamProxyShouldEnable(failOpen)).toBe(false);
    expect(upstreamProxyStateForPort(failOpen, 8080).enabled).toBe(false);

    const root = fs.mkdtempSync(path.join(process.cwd(), ".runtime-remote-"));
    const tokenPath = path.join(root, "session_token");
    fs.writeFileSync(tokenPath, "secret-token\n", "utf8");
    const caPath = path.join(root, "ca-bundle.crt");

    const bootstrap = upstreamProxyBootstrapFromEnvMap({
      CLAUDE_CODE_REMOTE: "1",
      CCR_UPSTREAM_PROXY_ENABLED: "true",
      CLAUDE_CODE_REMOTE_SESSION_ID: "session-123",
      ANTHROPIC_BASE_URL: "https://remote.test",
      CCR_SESSION_TOKEN_PATH: tokenPath,
      CCR_CA_BUNDLE_PATH: caPath
    });
    expect(upstreamProxyShouldEnable(bootstrap)).toBe(true);
    expect(bootstrap.token).toBe("secret-token");
    expect(upstreamProxyWsUrl("https://remote.test")).toBe("wss://remote.test/v1/code/upstreamproxy/ws");

    const state = upstreamProxyStateForPort(bootstrap, 9443);
    expect(state.enabled).toBe(true);
    const subEnv = upstreamProxySubprocessEnv(state);
    expect(subEnv.HTTPS_PROXY).toBe("http://127.0.0.1:9443");
    expect(subEnv.SSL_CERT_FILE).toBe(caPath);

    fs.writeFileSync(path.join(root, "trim.txt"), " abc123 \n", "utf8");
    expect(readSessionToken(path.join(root, "trim.txt"))).toBe("abc123");
    expect(readSessionToken(path.join(root, "missing"))).toBeUndefined();

    const inherited = inheritedUpstreamProxyEnv({
      HTTPS_PROXY: "http://127.0.0.1:8888",
      SSL_CERT_FILE: "/tmp/ca-bundle.crt",
      NO_PROXY: "localhost"
    });
    expect(Object.keys(inherited).length).toBe(3);
    expect(inherited.NO_PROXY).toBe("localhost");
    expect(Object.keys(inheritedUpstreamProxyEnv({})).length).toBe(0);

    expect(upstreamProxyWsUrl("http://localhost:3000/")).toBe("ws://localhost:3000/v1/code/upstreamproxy/ws");
    expect(noProxyList()).toContain("anthropic.com");
    expect(noProxyList()).toContain("github.com");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
