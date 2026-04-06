import { describe, expect, test } from "vitest";

import { TaskPacketValidationError } from "../../src/runtime/task-packet.js";
import { TaskRegistry } from "../../src/runtime/task-registry.js";

describe("runtime task registry", () => {
  test("ports task registry behavior", async () => {
    const registry = new TaskRegistry();

    const task = registry.create("Do something", "A test task");
    expect(task.status).toBe("created");
    expect(task.prompt).toBe("Do something");
    expect(task.description).toBe("A test task");
    expect(task.taskPacket).toBeUndefined();
    expect(registry.get(task.taskId)?.taskId).toBe(task.taskId);

    const packetTask = registry.createFromPacket({
      objective: "Ship task packet support",
      scope: "runtime/task system",
      repo: "clench-parity",
      branchPolicy: "origin/main only",
      acceptanceTests: ["cargo test --workspace"],
      commitPolicy: "single commit",
      reportingContract: "print commit sha",
      escalationPolicy: "manual escalation"
    });
    expect(packetTask.prompt).toBe("Ship task packet support");
    expect(packetTask.description).toBe("runtime/task system");
    expect(packetTask.taskPacket?.repo).toBe("clench-parity");

    const listedAll = registry.list();
    expect(listedAll.length).toBe(2);
    registry.setStatus(packetTask.taskId, "running");
    expect(registry.list("running").length).toBe(1);
    expect(registry.list("created").length).toBe(1);

    const updated = registry.update(task.taskId, "Here's more context");
    expect(updated.messages.length).toBe(1);
    expect(updated.messages[0]?.content).toBe("Here's more context");
    expect(updated.messages[0]?.role).toBe("user");

    registry.appendOutput(task.taskId, "line 1\n");
    registry.appendOutput(task.taskId, "line 2\n");
    expect(registry.output(task.taskId)).toBe("line 1\nline 2\n");

    registry.assignTeam(task.taskId, "team_abc");
    expect(registry.get(task.taskId)?.teamId).toBe("team_abc");

    expect(registry.stop(packetTask.taskId).status).toBe("stopped");
    expect(() => registry.stop(packetTask.taskId)).toThrow("already in terminal state");

    const fresh = registry.create("created task");
    expect(registry.stop(fresh.taskId).status).toBe("stopped");

    const terminalCompleted = registry.create("done");
    registry.setStatus(terminalCompleted.taskId, "completed");
    expect(() => registry.stop(terminalCompleted.taskId)).toThrow("completed");

    const terminalFailed = registry.create("failed");
    registry.setStatus(terminalFailed.taskId, "failed");
    expect(() => registry.stop(terminalFailed.taskId)).toThrow("failed");

    expect(registry.remove(task.taskId)?.taskId).toBe(task.taskId);
    expect(registry.remove("missing")).toBeUndefined();

    expect(() => registry.stop("nonexistent")).toThrow("task not found: nonexistent");
    expect(() => registry.update("nonexistent", "msg")).toThrow("task not found: nonexistent");
    expect(() => registry.output("nonexistent")).toThrow("task not found: nonexistent");
    expect(() => registry.appendOutput("nonexistent", "data")).toThrow("task not found: nonexistent");
    expect(() => registry.setStatus("nonexistent", "running")).toThrow("task not found: nonexistent");
    expect(() => registry.assignTeam("missing", "team_123")).toThrow("task not found: missing");

    expect(registry.len()).toBeGreaterThanOrEqual(3);
    expect(registry.isEmpty()).toBe(false);

    expect(() =>
      registry.createFromPacket({
        objective: "",
        scope: "",
        repo: "",
        branchPolicy: "",
        acceptanceTests: [""],
        commitPolicy: "",
        reportingContract: "",
        escalationPolicy: ""
      })
    ).toThrow(TaskPacketValidationError);
  });
});
