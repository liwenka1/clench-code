import { describe, expect, test } from "vitest";

import { CronRegistry, TeamRegistry } from "../../src/runtime/team-cron-registry.js";

describe("runtime team cron registry", () => {
  test("ports team cron registry behavior", async () => {
    const teamRegistry = new TeamRegistry();
    expect(teamRegistry.isEmpty()).toBe(true);
    expect(teamRegistry.len()).toBe(0);
    expect(teamRegistry.list()).toEqual([]);

    const alpha = teamRegistry.create("Alpha Squad", ["task_001", "task_002"]);
    expect(alpha.name).toBe("Alpha Squad");
    expect(alpha.taskIds.length).toBe(2);
    expect(alpha.status).toBe("created");
    expect(teamRegistry.get(alpha.teamId)?.teamId).toBe(alpha.teamId);

    const beta = teamRegistry.create("Team B", []);
    expect(teamRegistry.list().length).toBe(2);
    expect(teamRegistry.delete(alpha.teamId).status).toBe("deleted");
    expect(teamRegistry.get(alpha.teamId)?.status).toBe("deleted");
    expect(teamRegistry.remove(beta.teamId)?.teamId).toBe(beta.teamId);
    expect(teamRegistry.len()).toBe(1);
    expect(teamRegistry.remove("missing")).toBeUndefined();
    expect(() => teamRegistry.delete("nonexistent")).toThrow("team not found: nonexistent");

    const gamma = teamRegistry.create("Gamma", []);
    expect(teamRegistry.len()).toBe(2);
    teamRegistry.remove(alpha.teamId);
    expect(teamRegistry.len()).toBe(1);
    teamRegistry.remove(gamma.teamId);
    expect(teamRegistry.len()).toBe(0);
    expect(teamRegistry.isEmpty()).toBe(true);

    const cronRegistry = new CronRegistry();
    expect(cronRegistry.isEmpty()).toBe(true);
    expect(cronRegistry.len()).toBe(0);
    expect(cronRegistry.list(true)).toEqual([]);
    expect(cronRegistry.list(false)).toEqual([]);

    const first = cronRegistry.create("0 * * * *", "Check status", "hourly check");
    expect(first.schedule).toBe("0 * * * *");
    expect(first.prompt).toBe("Check status");
    expect(first.enabled).toBe(true);
    expect(first.runCount).toBe(0);
    expect(first.lastRunAt).toBeUndefined();
    expect(cronRegistry.get(first.cronId)?.cronId).toBe(first.cronId);

    const second = cronRegistry.create("* * * * *", "Task 2");
    cronRegistry.disable(second.cronId);
    expect(cronRegistry.list(false).length).toBe(2);
    expect(cronRegistry.list(true).length).toBe(1);
    expect(cronRegistry.list(true)[0]?.cronId).toBe(first.cronId);

    cronRegistry.recordRun(first.cronId);
    cronRegistry.recordRun(first.cronId);
    const fetched = cronRegistry.get(first.cronId);
    expect(fetched?.runCount).toBe(2);
    expect(fetched?.lastRunAt).toBeDefined();

    const third = cronRegistry.create("*/15 * * * *", "Check health");
    expect(third.description).toBeUndefined();
    expect(third.enabled).toBe(true);

    const deleted = cronRegistry.delete(second.cronId);
    expect(deleted.cronId).toBe(second.cronId);
    expect(cronRegistry.get(second.cronId)).toBeUndefined();

    const disableOnly = cronRegistry.create("0 0 * * *", "Nightly");
    const beforeDisable = cronRegistry.get(disableOnly.cronId)?.updatedAt ?? 0;
    cronRegistry.disable(disableOnly.cronId);
    expect(cronRegistry.get(disableOnly.cronId)?.enabled).toBe(false);
    expect((cronRegistry.get(disableOnly.cronId)?.updatedAt ?? 0) >= beforeDisable).toBe(true);

    expect(() => cronRegistry.delete("nonexistent")).toThrow("cron not found: nonexistent");
    expect(() => cronRegistry.disable("nonexistent")).toThrow("cron not found: nonexistent");
    expect(() => cronRegistry.recordRun("nonexistent")).toThrow("cron not found: nonexistent");
    expect(cronRegistry.get("nonexistent")).toBeUndefined();
  });
});
