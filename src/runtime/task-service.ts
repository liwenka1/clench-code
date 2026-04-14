import { type Task, type TaskRegistry } from "./task-registry.js";
import type { TaskPacket } from "./task-packet.js";
import { getTaskRuntimeStore, persistTaskRuntimeStore, resetTaskRuntimeStore } from "./task-runtime-store.js";

export function getGlobalTaskRegistry(): TaskRegistry {
  return getTaskRuntimeStore().taskRegistry;
}

export function resetGlobalTaskRegistry(options?: { clearPersisted?: boolean }): void {
  resetTaskRuntimeStore(options);
}

export function createTask(prompt: string, description?: string): Task {
  const task = getGlobalTaskRegistry().create(prompt, description);
  persistTaskRuntimeStore();
  return task;
}

export function createTaskFromPacket(packet: TaskPacket): Task {
  const task = getGlobalTaskRegistry().createFromPacket(packet);
  persistTaskRuntimeStore();
  return task;
}

export function stopTask(taskId: string): Task {
  const task = getGlobalTaskRegistry().stop(taskId);
  persistTaskRuntimeStore();
  return task;
}

export function updateTask(taskId: string, message: string): Task {
  const task = getGlobalTaskRegistry().update(taskId, message);
  persistTaskRuntimeStore();
  return task;
}

export function deleteTask(taskId: string): Task {
  const task = getGlobalTaskRegistry().remove(taskId);
  if (!task) {
    throw new Error(`task not found: ${taskId}`);
  }
  persistTaskRuntimeStore();
  return task;
}

export function appendTaskOutput(taskId: string, output: string): void {
  getGlobalTaskRegistry().appendOutput(taskId, output);
  persistTaskRuntimeStore();
}

export function assignTaskTeam(taskId: string, teamId: string): void {
  getGlobalTaskRegistry().assignTeam(taskId, teamId);
  persistTaskRuntimeStore();
}
