import { describe, expect, test } from "vitest";

import {
  buildLinuxSandboxCommand,
  detectContainerEnvironmentFrom,
  resolveSandboxStatusForRequest,
  sandboxConfigResolveRequest
} from "../../src/runtime/sandbox.js";

describe("runtime sandbox", () => {
  test("ports sandbox mode and isolation reporting behavior", async () => {
    const detected = detectContainerEnvironmentFrom({
      envPairs: [["container", "docker"]],
      dockerenvExists: true,
      containerenvExists: false,
      proc1Cgroup: "12:memory:/docker/abc"
    });
    expect(detected.inContainer).toBe(true);
    expect(detected.markers).toContain("/.dockerenv");
    expect(detected.markers.some((m) => m === "env:container=docker")).toBe(true);
    expect(detected.markers.some((m) => m === "/proc/1/cgroup:docker")).toBe(true);

    const config = {
      enabled: true,
      namespaceRestrictions: true,
      networkIsolation: false,
      filesystemMode: "workspace-only" as const,
      allowedMounts: ["logs"]
    };
    const request = sandboxConfigResolveRequest(config, {
      enabled: true,
      namespaceRestrictions: false,
      networkIsolation: true,
      filesystemMode: "allow-list",
      allowedMounts: ["tmp"]
    });
    expect(request.enabled).toBe(true);
    expect(request.namespaceRestrictions).toBe(false);
    expect(request.networkIsolation).toBe(true);
    expect(request.filesystemMode).toBe("allow-list");
    expect(request.allowedMounts).toEqual(["tmp"]);

    const status = resolveSandboxStatusForRequest(request, "/workspace", {
      inContainer: false,
      markers: []
    });
    if (process.platform === "linux" && status.namespaceActive && status.networkActive) {
      const launcher = buildLinuxSandboxCommand("printf hi", "/workspace", status);
      if (launcher) {
        expect(launcher.program).toBe("unshare");
        expect(launcher.args).toContain("--mount");
        expect(launcher.args.includes("--net")).toBe(status.networkActive);
      }
    }
  });
});
