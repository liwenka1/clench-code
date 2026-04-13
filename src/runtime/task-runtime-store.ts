import fs from "node:fs";
import path from "node:path";

import { TaskRegistry, type TaskRegistrySnapshot } from "./task-registry.js";
import { CronRegistry, TeamRegistry, type CronRegistrySnapshot, type TeamRegistrySnapshot } from "./team-cron-registry.js";

interface TaskRuntimeSnapshot {
  version: 1;
  tasks: TaskRegistrySnapshot;
  teams: TeamRegistrySnapshot;
  crons: CronRegistrySnapshot;
}

interface TaskRuntimeStore {
  taskRegistry: TaskRegistry;
  teamRegistry: TeamRegistry;
  cronRegistry: CronRegistry;
}

let loadedStore: TaskRuntimeStore | undefined;

export function getTaskRuntimeStore(): TaskRuntimeStore {
  if (!loadedStore) {
    loadedStore = loadTaskRuntimeStore();
  }
  return loadedStore;
}

export function persistTaskRuntimeStore(): void {
  const store = getTaskRuntimeStore();
  const filePath = taskRuntimeStatePath(process.cwd());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const snapshot: TaskRuntimeSnapshot = {
    version: 1,
    tasks: store.taskRegistry.snapshot(),
    teams: store.teamRegistry.snapshot(),
    crons: store.cronRegistry.snapshot()
  };
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export function resetTaskRuntimeStore(options?: { clearPersisted?: boolean }): void {
  if (options?.clearPersisted === false) {
    loadedStore = undefined;
    return;
  }
  loadedStore = {
    taskRegistry: new TaskRegistry(),
    teamRegistry: new TeamRegistry(),
    cronRegistry: new CronRegistry()
  };
  try {
    fs.rmSync(taskRuntimeStatePath(process.cwd()), { force: true });
  } catch {
    // Ignore cleanup failures during resets.
  }
}

export function taskRuntimeStatePath(cwd: string): string {
  const override = process.env.CLENCH_TASK_STATE_PATH?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(cwd, ".clench", "task-runtime.json");
}

function loadTaskRuntimeStore(): TaskRuntimeStore {
  const filePath = taskRuntimeStatePath(process.cwd());
  if (!fs.existsSync(filePath)) {
    return {
      taskRegistry: new TaskRegistry(),
      teamRegistry: new TeamRegistry(),
      cronRegistry: new CronRegistry()
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<TaskRuntimeSnapshot>;
    return {
      taskRegistry: new TaskRegistry(parsed.tasks),
      teamRegistry: new TeamRegistry(parsed.teams),
      cronRegistry: new CronRegistry(parsed.crons)
    };
  } catch {
    return {
      taskRegistry: new TaskRegistry(),
      teamRegistry: new TeamRegistry(),
      cronRegistry: new CronRegistry()
    };
  }
}
