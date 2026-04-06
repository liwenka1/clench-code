import { describe, expect, test } from "vitest";

import { McpServerManager } from "../../src/runtime/mcp-stdio.js";
import { McpToolRegistry } from "../../src/runtime/mcp-tool-bridge.js";

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
});
