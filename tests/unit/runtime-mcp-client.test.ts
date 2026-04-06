import { describe, expect, test } from "vitest";

import {
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  mcpClientAuthFromOauth,
  mcpClientAuthRequiresUserAuth,
  mcpClientBootstrapFromScopedConfig,
  resolvedMcpToolCallTimeoutMs
} from "../../src/runtime/mcp-client.js";

describe("runtime mcp client", () => {
  test("ports MCP client behavior", async () => {
    const stdio = mcpClientBootstrapFromScopedConfig("stdio-server", {
      scope: "user",
      config: {
        type: "stdio",
        command: "uvx",
        args: ["mcp-server"],
        env: { TOKEN: "secret" },
        toolCallTimeoutMs: 15_000
      }
    });

    expect(stdio.normalizedName).toBe("stdio-server");
    expect(stdio.toolPrefix).toBe("mcp__stdio-server__");
    expect(stdio.signature).toBe("stdio:[uvx|mcp-server]");
    expect(stdio.transport.type).toBe("stdio");
    if (stdio.transport.type === "stdio") {
      expect(stdio.transport.command).toBe("uvx");
      expect(stdio.transport.args).toEqual(["mcp-server"]);
      expect(stdio.transport.env.TOKEN).toBe("secret");
      expect(resolvedMcpToolCallTimeoutMs(stdio.transport)).toBe(15_000);
    }

    const remote = mcpClientBootstrapFromScopedConfig("remote server", {
      scope: "project",
      config: {
        type: "http",
        url: "https://vendor.example/mcp",
        headers: { "X-Test": "1" },
        headersHelper: "helper.sh",
        oauth: {
          clientId: "client-id",
          callbackPort: 7777,
          authServerMetadataUrl: "https://issuer.example/.well-known/oauth-authorization-server",
          xaa: true
        }
      }
    });

    expect(remote.normalizedName).toBe("remote_server");
    expect(remote.transport.type).toBe("http");
    if (remote.transport.type === "http") {
      expect(remote.transport.url).toBe("https://vendor.example/mcp");
      expect(remote.transport.headersHelper).toBe("helper.sh");
      expect(mcpClientAuthRequiresUserAuth(remote.transport.auth)).toBe(true);
    }

    const ws = mcpClientBootstrapFromScopedConfig("ws server", {
      scope: "local",
      config: { type: "ws", url: "wss://vendor.example/mcp", headers: {} }
    });
    expect(ws.transport.type).toBe("websocket");
    if (ws.transport.type === "websocket") {
      expect(mcpClientAuthRequiresUserAuth(ws.transport.auth)).toBe(false);
    }

    const sdk = mcpClientBootstrapFromScopedConfig("sdk server", {
      scope: "local",
      config: { type: "sdk", name: "sdk-server" }
    });
    expect(sdk.signature).toBeUndefined();
    expect(sdk.transport).toEqual({ type: "sdk", name: "sdk-server" });

    expect(mcpClientAuthFromOauth()).toEqual({ type: "none" });
    expect(
      resolvedMcpToolCallTimeoutMs({
        type: "stdio",
        command: "node",
        args: [],
        env: {}
      })
    ).toBe(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS);
  });
});
