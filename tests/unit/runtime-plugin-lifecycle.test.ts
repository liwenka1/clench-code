import { describe, expect, test } from "vitest";

import { PluginHealthcheck, pluginStateFromServers } from "../../src/runtime/plugin-lifecycle.js";

describe("runtime plugin lifecycle", () => {
  test("ports plugin lifecycle behavior", async () => {
    expect(pluginStateFromServers([])).toEqual({
      state: "failed",
      reason: "no servers available"
    });

    expect(
      pluginStateFromServers([
        { serverName: "alpha", status: "healthy", capabilities: ["search"] },
        { serverName: "beta", status: "healthy", capabilities: ["write"] }
      ])
    ).toEqual({ state: "healthy" });

    const degraded = pluginStateFromServers([
      { serverName: "alpha", status: "healthy", capabilities: ["search"] },
      { serverName: "beta", status: "failed", capabilities: ["write"], lastError: "connection refused" },
      { serverName: "gamma", status: "degraded", capabilities: ["read"], lastError: "high latency" }
    ]);
    expect(degraded).toEqual({
      state: "degraded",
      healthyServers: ["alpha", "gamma"],
      failedServers: [
        {
          serverName: "beta",
          status: "failed",
          capabilities: ["write"],
          lastError: "connection refused"
        }
      ]
    });

    const healthcheck = new PluginHealthcheck("degraded-plugin", [
      { serverName: "alpha", status: "healthy", capabilities: ["search"] },
      { serverName: "beta", status: "failed", capabilities: ["write"], lastError: "connection refused" }
    ]);
    expect(
      healthcheck.degradedMode({
        tools: [{ name: "search" }],
        resources: [],
        partial: true
      })
    ).toEqual({
      availableTools: ["search"],
      unavailableTools: ["write"],
      reason: "1 servers healthy, 1 servers failed"
    });
  });
});
