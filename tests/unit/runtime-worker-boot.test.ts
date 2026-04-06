import { describe, expect, test } from "vitest";

import { WorkerRegistry, detectReadyForPrompt } from "../../src/runtime/worker-boot.js";

describe("runtime worker boot", () => {
  test("ports worker boot behavior", async () => {
    const registry = new WorkerRegistry();
    const w1 = registry.create("/tmp/worktrees/repo-a", ["/tmp/worktrees"], true);
    const afterTrust = registry.observe(
      w1.workerId,
      "Do you trust the files in this folder?\n1. Yes, proceed\n2. No"
    );
    expect(afterTrust.status).toBe("spawning");
    expect(afterTrust.trustGateCleared).toBe(true);
    const trustRequired = afterTrust.events.find((e) => e.kind === "trust_required");
    expect(trustRequired?.payload).toEqual({
      type: "trust_prompt",
      cwd: "/tmp/worktrees/repo-a"
    });
    const trustResolved = afterTrust.events.find((e) => e.kind === "trust_resolved");
    expect(trustResolved?.payload).toEqual({
      type: "trust_prompt",
      cwd: "/tmp/worktrees/repo-a",
      resolution: "auto_allowlisted"
    });

    const ready = registry.observe(w1.workerId, "Ready for your input\n>");
    expect(ready.status).toBe("ready_for_prompt");
    expect(ready.lastError).toBeUndefined();

    const w2 = registry.create("/tmp/repo-b", [], true);
    const blocked = registry.observe(
      w2.workerId,
      "Do you trust the files in this folder?\n1. Yes, proceed\n2. No"
    );
    expect(blocked.status).toBe("trust_required");
    expect(blocked.lastError?.kind).toBe("trust_gate");
    expect(() => registry.sendPrompt(w2.workerId, "ship it")).toThrow("not ready for prompt delivery");

    const resolved = registry.resolveTrust(w2.workerId);
    expect(resolved.status).toBe("spawning");
    expect(resolved.trustGateCleared).toBe(true);
    expect(
      resolved.events.find((e) => e.kind === "trust_resolved")?.payload
    ).toEqual({
      type: "trust_prompt",
      cwd: "/tmp/repo-b",
      resolution: "manual_approval"
    });

    expect(detectReadyForPrompt("bellman@host %", "bellman@host %")).toBe(false);
    expect(detectReadyForPrompt("/tmp/repo $", "/tmp/repo $")).toBe(false);
    expect(detectReadyForPrompt("│ >", "│ >")).toBe(true);

    const w3 = registry.create("/tmp/repo-c", [], true);
    registry.observe(w3.workerId, "Ready for input\n>");
    registry.sendPrompt(w3.workerId, "Implement worker handshake");
    const recovered = registry.observe(
      w3.workerId,
      "% Implement worker handshake\nzsh: command not found: Implement"
    );
    expect(recovered.status).toBe("ready_for_prompt");
    expect(recovered.lastError?.kind).toBe("prompt_delivery");
    expect(recovered.replayPrompt).toBe("Implement worker handshake");
    const replayed = registry.sendPrompt(w3.workerId, undefined);
    expect(replayed.status).toBe("running");
    expect(replayed.replayPrompt).toBeUndefined();
    expect(replayed.promptDeliveryAttempts).toBe(2);

    const w4 = registry.create("/tmp/repo-d", [], false);
    let snap = registry.awaitReady(w4.workerId);
    expect(snap.ready).toBe(false);
    expect(snap.blocked).toBe(false);
    registry.observe(
      w4.workerId,
      "Do you trust the files in this folder?\n1. Yes, proceed\n2. No"
    );
    snap = registry.awaitReady(w4.workerId);
    expect(snap.ready).toBe(false);
    expect(snap.blocked).toBe(true);
    registry.resolveTrust(w4.workerId);
    registry.observe(w4.workerId, "Ready for your input\n>");
    snap = registry.awaitReady(w4.workerId);
    expect(snap.ready).toBe(true);
    expect(snap.blocked).toBe(false);

    const w5 = registry.create("/tmp/repo-e", [], true);
    registry.observe(w5.workerId, "Ready for input\n>");
    registry.sendPrompt(w5.workerId, "Run tests");
    const restarted = registry.restart(w5.workerId);
    expect(restarted.status).toBe("spawning");
    expect(restarted.promptDeliveryAttempts).toBe(0);
    const finished = registry.terminate(w5.workerId);
    expect(finished.status).toBe("finished");

    const w6 = registry.create("/tmp/repo-f", [], true);
    registry.observe(w6.workerId, "Ready for input\n>");
    registry.sendPrompt(w6.workerId, "Run tests");
    const failed = registry.observeCompletion(w6.workerId, "unknown", 0);
    expect(failed.status).toBe("failed");
    expect(failed.lastError?.kind).toBe("provider");
    expect(failed.lastError?.message).toContain("provider degraded");

    const w7 = registry.create("/tmp/repo-g", [], true);
    registry.observe(w7.workerId, "Ready for input\n>");
    registry.sendPrompt(w7.workerId, "Run tests");
    const done = registry.observeCompletion(w7.workerId, "stop", 150);
    expect(done.status).toBe("finished");
    expect(done.lastError).toBeUndefined();
  });
});
