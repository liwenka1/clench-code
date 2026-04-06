import { describe, expect, test } from "vitest";

import {
  mcpServerSignature,
  mcpToolName,
  mcpToolPrefix,
  normalizeNameForMcp,
  renderScopedConfig,
  scopedMcpConfigHash,
  stableHexHash,
  unwrapCcrProxyUrl
} from "../../src/runtime/mcp.js";

describe("runtime mcp", () => {
  test("ports MCP config and orchestration behavior", async () => {
    expect(normalizeNameForMcp("github.com")).toBe("github_com");
    expect(normalizeNameForMcp("tool name!")).toBe("tool_name_");
    expect(normalizeNameForMcp("claude.ai Example   Server!!")).toBe("claude_ai_Example_Server");
    expect(mcpToolPrefix("claude.ai Example Server")).toBe("mcp__claude_ai_Example_Server__");
    expect(mcpToolName("claude.ai Example Server", "weather tool")).toBe(
      "mcp__claude_ai_Example_Server__weather_tool"
    );

    const wrapped =
      "https://api.anthropic.com/v2/session_ingress/shttp/mcp/123?mcp_url=https%3A%2F%2Fvendor.example%2Fmcp&other=1";
    expect(unwrapCcrProxyUrl(wrapped)).toBe("https://vendor.example/mcp");
    expect(unwrapCcrProxyUrl("https://vendor.example/mcp")).toBe("https://vendor.example/mcp");

    expect(
      mcpServerSignature({
        type: "stdio",
        command: "uvx",
        args: ["mcp-server"],
        env: { TOKEN: "secret" }
      })
    ).toBe("stdio:[uvx|mcp-server]");

    expect(
      mcpServerSignature({
        type: "ws",
        url: "https://api.anthropic.com/v2/ccr-sessions/1?mcp_url=wss%3A%2F%2Fvendor.example%2Fmcp",
        headers: {}
      })
    ).toBe("url:wss://vendor.example/mcp");

    const httpRendered =
      "http|https://vendor.example/mcp|Authorization=Bearer token|helper.sh|";
    expect(
      renderScopedConfig({
        type: "http",
        url: "https://vendor.example/mcp",
        headers: { Authorization: "Bearer token" },
        headersHelper: "helper.sh"
      })
    ).toBe(httpRendered);
    expect(stableHexHash(httpRendered)).toBe("fbf9de24ad5bedca");

    const firstHash = scopedMcpConfigHash({
      scope: "user",
      config: {
        type: "http",
        url: "https://vendor.example/mcp",
        headers: { Authorization: "Bearer token" },
        headersHelper: "helper.sh"
      }
    });
    const secondHash = scopedMcpConfigHash({
      scope: "local",
      config: {
        type: "http",
        url: "https://vendor.example/mcp",
        headers: { Authorization: "Bearer token" },
        headersHelper: "helper.sh"
      }
    });
    const changedHash = scopedMcpConfigHash({
      scope: "local",
      config: {
        type: "http",
        url: "https://vendor.example/v2/mcp",
        headers: {}
      }
    });

    expect(firstHash).toBe(secondHash);
    expect(firstHash).toBe("fbf9de24ad5bedca");
    expect(firstHash).not.toBe(changedHash);

    expect(
      renderScopedConfig({
        type: "managed_proxy",
        url: "https://proxy.example/mcp",
        id: "sess-1"
      })
    ).toBe("claudeai-proxy|https://proxy.example/mcp|sess-1");

    expect(
      renderScopedConfig({
        type: "sdk",
        name: "my-sdk"
      })
    ).toBe("sdk|my-sdk");
  });
});
