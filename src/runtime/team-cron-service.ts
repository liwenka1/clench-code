import type { Task } from "./task-registry.js";
import { createTask, getGlobalTaskRegistry } from "./task-service.js";
import { type CronEntry, type CronRegistry, type Team, type TeamRegistry } from "./team-cron-registry.js";
import { getTaskRuntimeStore, persistTaskRuntimeStore, resetTaskRuntimeStore } from "./task-runtime-store.js";

export function getGlobalTeamRegistry(): TeamRegistry {
  return getTaskRuntimeStore().teamRegistry;
}

export function getGlobalCronRegistry(): CronRegistry {
  return getTaskRuntimeStore().cronRegistry;
}

export function resetGlobalTeamCronRegistry(options?: { clearPersisted?: boolean }): void {
  resetTaskRuntimeStore(options);
}

export function createTeam(name: string, taskIds: string[]): Team {
  const team = getGlobalTeamRegistry().create(name, taskIds);
  persistTaskRuntimeStore();
  return team;
}

export function createCron(schedule: string, prompt: string, description?: string, teamId?: string): CronEntry {
  const cron = getGlobalCronRegistry().create(schedule, prompt, description, teamId);
  persistTaskRuntimeStore();
  return cron;
}

export function deleteTeam(teamId: string): Team {
  const team = getGlobalTeamRegistry().delete(teamId);
  persistTaskRuntimeStore();
  return team;
}

export function messageTeam(teamId: string, message: string): { team: Team; updatedTasks: Task[]; skippedTaskIds: string[] } {
  const teamRegistry = getGlobalTeamRegistry();
  const taskRegistry = getGlobalTaskRegistry();
  const team = teamRegistry.get(teamId);
  if (!team) {
    throw new Error(`team not found: ${teamId}`);
  }
  const updatedTasks: Task[] = [];
  const skippedTaskIds: string[] = [];
  for (const taskId of team.taskIds) {
    try {
      updatedTasks.push(taskRegistry.update(taskId, message));
    } catch {
      skippedTaskIds.push(taskId);
    }
  }
  const updatedTeam = teamRegistry.setStatus(teamId, "running");
  persistTaskRuntimeStore();
  return { team: updatedTeam, updatedTasks, skippedTaskIds };
}

export function runTeam(teamId: string): { team: Team; updatedTasks: Task[]; skippedTaskIds: string[] } {
  const teamRegistry = getGlobalTeamRegistry();
  const taskRegistry = getGlobalTaskRegistry();
  const team = teamRegistry.get(teamId);
  if (!team) {
    throw new Error(`team not found: ${teamId}`);
  }
  const updatedTasks: Task[] = [];
  const skippedTaskIds: string[] = [];
  for (const taskId of team.taskIds) {
    try {
      taskRegistry.setStatus(taskId, "running");
      const task = taskRegistry.get(taskId);
      if (task) {
        updatedTasks.push(task);
      }
    } catch {
      skippedTaskIds.push(taskId);
    }
  }
  const updatedTeam = teamRegistry.setStatus(teamId, "running");
  persistTaskRuntimeStore();
  return { team: updatedTeam, updatedTasks, skippedTaskIds };
}

export function deleteCron(cronId: string): CronEntry {
  const cron = getGlobalCronRegistry().delete(cronId);
  persistTaskRuntimeStore();
  return cron;
}

export function disableCron(cronId: string): CronEntry {
  const registry = getGlobalCronRegistry();
  registry.disable(cronId);
  const cron = registry.get(cronId);
  if (!cron) {
    throw new Error(`cron not found: ${cronId}`);
  }
  persistTaskRuntimeStore();
  return cron;
}

export function recordCronRun(cronId: string): void {
  getGlobalCronRegistry().recordRun(cronId);
  persistTaskRuntimeStore();
}

export function runCron(cronId: string):
  | { cron: CronEntry; targetType: "task"; task: Task }
  | { cron: CronEntry; targetType: "team"; team: Team; updatedTasks: Task[]; skippedTaskIds: string[] } {
  const registry = getGlobalCronRegistry();
  const cron = registry.get(cronId);
  if (!cron) {
    throw new Error(`cron not found: ${cronId}`);
  }
  if (!cron.enabled) {
    throw new Error(`cron is disabled: ${cronId}`);
  }
  if (cron.teamId) {
    const result = runTeam(cron.teamId);
    registry.recordRun(cronId);
    const updatedCron = registry.get(cronId);
    if (!updatedCron) {
      throw new Error(`cron not found: ${cronId}`);
    }
    persistTaskRuntimeStore();
    return {
      cron: updatedCron,
      targetType: "team",
      team: result.team,
      updatedTasks: result.updatedTasks,
      skippedTaskIds: result.skippedTaskIds
    };
  }
  const task = createTask(cron.prompt, cron.description || `Triggered by cron ${cron.schedule}`);
  registry.recordRun(cronId);
  const updatedCron = registry.get(cronId);
  if (!updatedCron) {
    throw new Error(`cron not found: ${cronId}`);
  }
  persistTaskRuntimeStore();
  return { cron: updatedCron, targetType: "task", task };
}
