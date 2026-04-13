import { TaskPacket, TaskPacketValidationError, validatePacket } from "./task-packet.js";

export type TaskStatus = "created" | "running" | "completed" | "failed" | "stopped";

export interface TaskMessage {
  role: string;
  content: string;
  timestamp: number;
}

export interface Task {
  taskId: string;
  prompt: string;
  description?: string;
  taskPacket?: TaskPacket;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  messages: TaskMessage[];
  output: string;
  teamId?: string;
}

interface RegistryState {
  tasks: Map<string, Task>;
  counter: number;
}

export interface TaskRegistrySnapshot {
  tasks: Task[];
  counter: number;
}

export class TaskRegistry {
  private readonly state: RegistryState;

  constructor(snapshot?: TaskRegistrySnapshot) {
    this.state = {
      tasks: new Map((snapshot?.tasks ?? []).map((task) => [task.taskId, cloneTask(task)])),
      counter: snapshot?.counter ?? 0
    };
  }

  create(prompt: string, description?: string): Task {
    return this.createTask(prompt, description, undefined);
  }

  createFromPacket(packet: TaskPacket): Task {
    let validated;
    try {
      validated = validatePacket(packet).intoInner();
    } catch (error) {
      if (error instanceof TaskPacketValidationError) {
        throw error;
      }
      throw error;
    }

    return this.createTask(validated.objective, validated.scope, validated);
  }

  get(taskId: string): Task | undefined {
    const task = this.state.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  list(statusFilter?: TaskStatus): Task[] {
    return [...this.state.tasks.values()]
      .filter((task) => statusFilter === undefined || task.status === statusFilter)
      .map(cloneTask);
  }

  stop(taskId: string): Task {
    const task = this.mustGetMutable(taskId);
    if (["completed", "failed", "stopped"].includes(task.status)) {
      throw new Error(`task ${taskId} is already in terminal state: ${task.status}`);
    }
    task.status = "stopped";
    task.updatedAt = nowSecs();
    return cloneTask(task);
  }

  update(taskId: string, message: string): Task {
    const task = this.mustGetMutable(taskId);
    task.messages.push({
      role: "user",
      content: message,
      timestamp: nowSecs()
    });
    task.updatedAt = nowSecs();
    return cloneTask(task);
  }

  output(taskId: string): string {
    return this.mustGetMutable(taskId).output;
  }

  appendOutput(taskId: string, output: string): void {
    const task = this.mustGetMutable(taskId);
    task.output += output;
    task.updatedAt = nowSecs();
  }

  setStatus(taskId: string, status: TaskStatus): void {
    const task = this.mustGetMutable(taskId);
    task.status = status;
    task.updatedAt = nowSecs();
  }

  assignTeam(taskId: string, teamId: string): void {
    const task = this.mustGetMutable(taskId);
    task.teamId = teamId;
    task.updatedAt = nowSecs();
  }

  remove(taskId: string): Task | undefined {
    const task = this.state.tasks.get(taskId);
    if (!task) {
      return undefined;
    }
    this.state.tasks.delete(taskId);
    return cloneTask(task);
  }

  len(): number {
    return this.state.tasks.size;
  }

  isEmpty(): boolean {
    return this.state.tasks.size === 0;
  }

  snapshot(): TaskRegistrySnapshot {
    return {
      tasks: [...this.state.tasks.values()].map(cloneTask),
      counter: this.state.counter
    };
  }

  private createTask(prompt: string, description: string | undefined, taskPacket: TaskPacket | undefined): Task {
    this.state.counter += 1;
    const ts = nowSecs();
    const taskId = `task_${ts.toString(16).padStart(8, "0")}_${this.state.counter}`;
    const task: Task = {
      taskId,
      prompt,
      description,
      taskPacket,
      status: "created",
      createdAt: ts,
      updatedAt: ts,
      messages: [],
      output: ""
    };
    this.state.tasks.set(taskId, task);
    return cloneTask(task);
  }

  private mustGetMutable(taskId: string): Task {
    const task = this.state.tasks.get(taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    return task;
  }
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    messages: task.messages.map((message) => ({ ...message })),
    taskPacket: task.taskPacket ? { ...task.taskPacket, acceptanceTests: [...task.taskPacket.acceptanceTests] } : undefined
  };
}
