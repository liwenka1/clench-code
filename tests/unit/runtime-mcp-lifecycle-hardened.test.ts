import { describe, expect, test } from "vitest";

import {
  McpLifecycleValidator,
  allMcpLifecyclePhases,
  formatMcpErrorSurface,
  mcpDegradedReport,
  mcpErrorSurface
} from "../../src/runtime/mcp-lifecycle-hardened.js";

describe("runtime mcp lifecycle hardened", () => {
  test("ports hardened MCP lifecycle behavior", async () => {
    const validator = new McpLifecycleValidator();
    const phases = [
      "config_load",
      "server_registration",
      "spawn_connect",
      "initialize_handshake",
      "tool_discovery",
      "resource_discovery",
      "ready",
      "invocation",
      "ready",
      "shutdown",
      "cleanup"
    ] as const;

    for (const phase of phases) {
      expect(validator.runPhase(phase).type).toBe("success");
    }
    expect(validator.state.currentPhase).toBe("cleanup");
    for (const phase of [
      "config_load",
      "server_registration",
      "spawn_connect",
      "initialize_handshake",
      "tool_discovery",
      "resource_discovery",
      "ready",
      "invocation",
      "shutdown",
      "cleanup"
    ]) {
      expect(validator.state.phaseTimestamps.has(phase)).toBe(true);
      expect(validator.state.phaseTimestamp(phase)).toEqual(validator.state.phaseTimestamps.get(phase));
    }

    expect(McpLifecycleValidator.validatePhaseTransition("tool_discovery", "ready")).toBe(true);
    expect(McpLifecycleValidator.validatePhaseTransition("ready", "config_load")).toBe(false);

    const invalid = new McpLifecycleValidator();
    invalid.runPhase("config_load");
    invalid.runPhase("server_registration");
    const invalidResult = invalid.runPhase("ready");
    expect(invalidResult.type).toBe("failure");
    if (invalidResult.type === "failure") {
      expect(invalidResult.error.context.from).toBe("server_registration");
      expect(invalid.state.errorsForPhase("ready")).toHaveLength(1);
    }

    const timeout = new McpLifecycleValidator().recordTimeout("spawn_connect", 250, "alpha", { attempt: "1" });
    expect(timeout.type).toBe("timeout");
    if (timeout.type === "timeout") {
      expect(timeout.waitedMs).toBe(250);
      expect(timeout.error.context.waited_ms).toBe("250");
      expect(timeout.error.serverName).toBe("alpha");
    }

    const timeoutResume = new McpLifecycleValidator();
    const timeoutOnly = timeoutResume.recordTimeout("spawn_connect", 100, "beta", {});
    expect(timeoutOnly.type).toBe("timeout");
    expect(timeoutResume.runPhase("ready").type).toBe("success");

    const recoverable = new McpLifecycleValidator();
    ["config_load", "server_registration", "spawn_connect", "initialize_handshake", "tool_discovery", "ready"].forEach(
      (phase) => recoverable.runPhase(phase as Parameters<McpLifecycleValidator["runPhase"]>[0])
    );
    recoverable.recordFailure(
      mcpErrorSurface("invocation", "tool call failed but can be retried", {
        serverName: "alpha",
        context: { reason: "timeout" },
        recoverable: true
      })
    );
    expect(recoverable.runPhase("ready").type).toBe("success");

    const nonrecoverable = new McpLifecycleValidator();
    ["config_load", "server_registration", "spawn_connect", "initialize_handshake", "tool_discovery", "ready"].forEach(
      (phase) => nonrecoverable.runPhase(phase as Parameters<McpLifecycleValidator["runPhase"]>[0])
    );
    nonrecoverable.recordFailure(
      mcpErrorSurface("invocation", "tool call corrupted session", {
        serverName: "alpha",
        recoverable: false
      })
    );
    const rejectedResume = nonrecoverable.runPhase("ready");
    expect(rejectedResume.type).toBe("failure");

    const report = mcpDegradedReport(
      ["alpha", "beta", "alpha"],
      [
        {
          serverName: "broken",
          phase: "initialize_handshake",
          error: mcpErrorSurface("initialize_handshake", "initialize failed", {
            serverName: "broken",
            context: { reason: "broken pipe" }
          })
        }
      ],
      ["alpha.echo", "beta.search", "alpha.echo"],
      ["alpha.echo", "beta.search", "broken.fetch"]
    );
    expect(report.workingServers).toEqual(["alpha", "beta"]);
    expect(report.availableTools).toEqual(["alpha.echo", "beta.search"]);
    expect(report.missingTools).toEqual(["broken.fetch"]);

    const error = mcpErrorSurface("spawn_connect", "process exited early", {
      serverName: "alpha",
      context: { exit_code: "1" },
      recoverable: true
    });
    expect(formatMcpErrorSurface(error)).toContain("recoverable");
    expect(allMcpLifecyclePhases()).toHaveLength(11);
  });
});
