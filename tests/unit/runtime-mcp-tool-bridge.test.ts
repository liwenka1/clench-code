import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { McpServerManager } from "../../src/runtime/mcp-stdio.js";
import { McpToolRegistry, managerFromConfig, registryFromConfig, summarizeServerConfig } from "../../src/runtime/mcp-tool-bridge.js";
import { withEnv } from "../helpers/envGuards.js";
import { writeJsonFile } from "../helpers/sessionFixtures.js";

describe("runtime mcp tool bridge", () => {
  test("ports MCP tool bridge behavior", async () => {
    const registry = new McpToolRegistry();
    registry.registerServer(
      "alpha",
      "connected",
      [
        {
          name: "echo",
          description: "Echo tool",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
        }
      ],
      [{ uri: "res://alpha", name: "Alpha", mimeType: "application/json" }],
      "bridge test server"
    );

    expect(registry.getServer("alpha")?.status).toBe("connected");
    expect(registry.listServers()).toHaveLength(1);
    expect(registry.listResources("alpha")[0]?.uri).toBe("res://alpha");
    expect(registry.readResource("alpha", "res://alpha").name).toBe("Alpha");
    expect(registry.listTools("alpha")[0]?.name).toBe("echo");

    expect(() => registry.callTool("alpha", "echo", { text: "hello" })).toThrow(
      "MCP server manager is not configured"
    );

    registry.setManager(
      new McpServerManager([
        {
          serverName: "alpha",
          tools: [{ name: "echo" }],
          handlers: {
            echo: (params) => {
              const text = (params as { text?: string } | undefined)?.text ?? "";
              return {
                structuredContent: { server: "alpha", echoed: text },
                content: [{ type: "text", text: `alpha:${text}` }]
              };
            }
          }
        }
      ])
    );

    expect(registry.callTool("alpha", "echo", { text: "hello" })).toEqual({
      structuredContent: { server: "alpha", echoed: "hello" },
      content: [{ type: "text", text: "alpha:hello" }]
    });

    registry.setAuthStatus("alpha", "auth_required");
    expect(() => registry.listTools("alpha")).toThrow("not connected");
    expect(() => registry.callTool("alpha", "echo", {})).toThrow("auth_required");
    registry.setAuthStatus("alpha", "connected");

    expect(() => registry.readResource("alpha", "res://missing")).toThrow("resource 'res://missing'");
    expect(() => registry.callTool("alpha", "missing", {})).toThrow("tool 'missing'");
    expect(() => registry.listResources("missing")).toThrow("server 'missing' not found");
    expect(() => registry.setAuthStatus("missing", "connected")).toThrow("server 'missing' not found");

    expect(registry.disconnect("alpha")?.serverName).toBe("alpha");
    expect(registry.disconnect("missing")).toBeUndefined();
    expect(registry.isEmpty()).toBe(true);
  });

  test("setManager allows clearing and re-binding the backing manager", async () => {
    const registry = new McpToolRegistry();
    registry.registerServer("alpha", "connected", [{ name: "echo" }], []);
    const manager = new McpServerManager([
      {
        serverName: "alpha",
        tools: [{ name: "echo" }],
        handlers: { echo: () => ({ ok: 1 }) }
      }
    ]);
    registry.setManager(manager);
    expect(registry.callTool("alpha", "echo", {})).toEqual({ ok: 1 });
    registry.setManager(undefined);
    expect(() => registry.callTool("alpha", "echo", {})).toThrow("MCP server manager is not configured");
    registry.setManager(
      new McpServerManager([
        {
          serverName: "alpha",
          tools: [{ name: "echo" }],
          handlers: { echo: () => ({ ok: 2 }) }
        }
      ])
    );
    expect(registry.callTool("alpha", "echo", {})).toEqual({ ok: 2 });
  });

  test("registryFromConfig_bootstraps_connection_state_from_config_shapes", async () => {
    const registry = registryFromConfig({
      stdioDemo: {
        type: "stdio",
        command: "node",
        args: ["server.mjs"],
        env: {}
      },
      oauthDemo: {
        type: "http",
        url: "https://vendor.example/mcp",
        headers: {},
        oauth: { clientId: "client-1" }
      }
    });

    expect(registry.listServers()).toEqual([
      {
        serverName: "stdioDemo",
        status: "error",
        tools: [],
        resources: [],
        serverInfo: "node server.mjs",
        errorMessage: "stdio bootstrap failed"
      },
      {
        serverName: "oauthDemo",
        status: "auth_required",
        tools: [],
        resources: [],
        serverInfo: "https://vendor.example/mcp",
        errorMessage: "oauth credentials not found"
      }
    ]);

    expect(
      summarizeServerConfig({
        type: "managed_proxy",
        url: "https://proxy.example/mcp",
        id: "sess-9"
      })
    ).toBe("https://proxy.example/mcp#sess-9");
  });

  test("managerFromConfig_builds_sdk_handlers_from_config", async () => {
    const manager = managerFromConfig({
      demo: {
        type: "sdk",
        name: "demo-sdk",
        tools: [
          {
            name: "echo",
            description: "Echo tool",
            inputSchema: { type: "object" },
            echoArguments: true
          }
        ],
        resources: [{ uri: "resource://demo", name: "Demo Resource" }]
      }
    });

    expect(manager?.discoverTools("demo")).toEqual({
      demo: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object" } }]
    });
    expect(manager?.discoverResources("demo")).toEqual({
      demo: [{ uri: "resource://demo", name: "Demo Resource" }]
    });
    expect(manager?.callTool("mcp__demo__echo", { text: "hello" })).toEqual({
      structuredContent: {
        server: "demo",
        tool: "echo",
        arguments: { text: "hello" }
      },
      content: [{ type: "text", text: "demo:echo" }]
    });
  });

  test("registryFromConfig_discovers_stdio_server_and_exposes_callable_tool", async () => {
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/mcp-stdio-echo.mjs"
    );
    const registry = registryFromConfig({
      stdioDemo: {
        type: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {}
      }
    });

    expect(registry.getServer("stdioDemo")).toMatchObject({
      status: "connected",
      tools: [{ name: "echo" }],
      resources: [{ uri: "resource://echo" }]
    });
    expect(registry.callTool("stdioDemo", "echo", { text: "from-registry" })).toEqual({
      content: [{ type: "text", text: "echo:from-registry" }],
      structuredContent: { server: "echo-stdio", tool: "echo", echoed: "from-registry" },
      isError: false
    });
  });

  test("registryFromConfig_marks_remote_oauth_server_connected_when_saved_credentials_exist", async () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-connected-"));
    await withEnv({ CLENCH_CONFIG_HOME: configHome }, async () => {
      await writeJsonFile(path.join(configHome, "credentials.json"), {
        oauth: {
          accessToken: "token-1",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          scopes: ["mcp:read"]
        }
      });

      const registry = registryFromConfig({
        remote: {
          type: "http",
          url: "https://vendor.example/mcp",
          headers: {},
          oauth: { clientId: "client-1" }
        }
      });

      expect(registry.getServer("remote")).toMatchObject({
        status: "connected",
        serverInfo: "https://vendor.example/mcp"
      });
    });
    fs.rmSync(configHome, { recursive: true, force: true });
  });

  test("registryFromConfig_marks_remote_oauth_server_connecting_when_expired_token_can_refresh", async () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-refresh-"));
    await withEnv({ CLENCH_CONFIG_HOME: configHome }, async () => {
      await writeJsonFile(path.join(configHome, "credentials.json"), {
        oauth: {
          accessToken: "expired-token",
          refreshToken: "refresh-token",
          expiresAt: Math.floor(Date.now() / 1000) - 60,
          scopes: ["mcp:read"]
        }
      });
      await writeJsonFile(path.join(configHome, "settings.json"), {
        oauth: {
          clientId: "runtime-client",
          authorizeUrl: "https://issuer.example/oauth/authorize",
          tokenUrl: "https://issuer.example/oauth/token",
          scopes: ["mcp:read"]
        }
      });

      const registry = registryFromConfig({
        remote: {
          type: "sse",
          url: "https://vendor.example/sse",
          headers: {},
          oauth: { clientId: "client-1" }
        }
      });

      expect(registry.getServer("remote")).toMatchObject({
        status: "connecting",
        serverInfo: "https://vendor.example/sse",
        errorMessage: "saved OAuth token is expired; refresh is available"
      });
    });
    fs.rmSync(configHome, { recursive: true, force: true });
  });
});
