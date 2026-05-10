import {
  assignTaskTeam,
  createCron,
  createTask,
  createTaskFromPacket,
  createTeam,
  deleteCron,
  deleteTask,
  deleteTeam,
  disableCron,
  getGlobalCronRegistry,
  getGlobalTaskRegistry,
  messageTeam,
  runCron,
  runTeam,
  stopTask,
  type TaskPacket,
  updateTask
} from "../runtime/index.js";

const TASK_TEAM_CRON_TOOLS = new Set([
  "Task",
  "TaskCreate",
  "RunTaskPacket",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TaskUpdate",
  "TaskOutput",
  "TaskMessages",
  "TaskDelete",
  "TeamCreate",
  "TeamDelete",
  "TeamMessage",
  "TeamRun",
  "CronCreate",
  "CronDelete",
  "CronDisable",
  "CronRun",
  "CronList"
]);

export function isTaskTeamCronTool(name: string): boolean {
  return TASK_TEAM_CRON_TOOLS.has(name);
}

export function executeTaskTeamCronTool(name: string, input: Record<string, unknown>): string {
  if (name === "Task") {
    const subagentType = String(input.subagent_type ?? "general-purpose");
    return JSON.stringify({
      subagentType,
      allowedTools: [...allowedToolsForSubagent(subagentType)]
    });
  }
  if (name === "TaskCreate") {
    return JSON.stringify(serializeTaskSummary(createTask(String(input.prompt ?? ""), optionalString(input.description))));
  }
  if (name === "RunTaskPacket") {
    return JSON.stringify(serializeTaskSummary(createTaskFromPacket(normalizeTaskPacketInput(input))));
  }
  if (name === "TaskGet") {
    const taskId = String(input.task_id ?? "");
    const task = getGlobalTaskRegistry().get(taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    return JSON.stringify(serializeTaskDetail(task));
  }
  if (name === "TaskList") {
    const tasks = getGlobalTaskRegistry().list();
    return JSON.stringify({
      tasks: tasks.map((task) => serializeTaskListEntry(task)),
      count: tasks.length
    });
  }
  if (name === "TaskStop") {
    const taskId = String(input.task_id ?? "");
    const task = stopTask(taskId);
    return JSON.stringify({
      task_id: task.taskId,
      status: task.status,
      message: "Task stopped"
    });
  }
  if (name === "TaskUpdate") {
    const taskId = String(input.task_id ?? "");
    const message = String(input.message ?? "");
    const task = updateTask(taskId, message);
    return JSON.stringify({
      task_id: task.taskId,
      status: task.status,
      message_count: task.messages.length,
      last_message: message
    });
  }
  if (name === "TaskOutput") {
    const taskId = String(input.task_id ?? "");
    const output = getGlobalTaskRegistry().output(taskId);
    return JSON.stringify({
      task_id: taskId,
      output,
      has_output: Boolean(output)
    });
  }
  if (name === "TaskMessages") {
    const taskId = String(input.task_id ?? "");
    const task = getGlobalTaskRegistry().get(taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    return JSON.stringify({
      task_id: task.taskId,
      messages: task.messages.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp
      })),
      count: task.messages.length
    });
  }
  if (name === "TaskDelete") {
    const taskId = String(input.task_id ?? "");
    const task = deleteTask(taskId);
    return JSON.stringify({
      task_id: task.taskId,
      status: "deleted",
      message: "Task deleted"
    });
  }
  if (name === "TeamCreate") {
    const taskIds = normalizeTeamTaskIds(input);
    const team = createTeam(String(input.name ?? ""), taskIds);
    for (const taskId of team.taskIds) {
      try {
        assignTaskTeam(taskId, team.teamId);
      } catch {
        // Keep parity with reference behavior: missing tasks don't block team creation.
      }
    }
    return JSON.stringify({
      team_id: team.teamId,
      name: team.name,
      task_count: team.taskIds.length,
      task_ids: [...team.taskIds],
      status: team.status,
      created_at: team.createdAt
    });
  }
  if (name === "TeamDelete") {
    const teamId = String(input.team_id ?? "");
    const team = deleteTeam(teamId);
    return JSON.stringify({
      team_id: team.teamId,
      name: team.name,
      status: team.status,
      message: "Team deleted"
    });
  }
  if (name === "TeamMessage") {
    const teamId = String(input.team_id ?? "");
    const message = String(input.message ?? "");
    const result = messageTeam(teamId, message);
    return JSON.stringify({
      team_id: result.team.teamId,
      status: result.team.status,
      updated_task_ids: result.updatedTasks.map((task) => task.taskId),
      skipped_task_ids: result.skippedTaskIds,
      updated_count: result.updatedTasks.length,
      message: "Team message applied"
    });
  }
  if (name === "TeamRun") {
    const teamId = String(input.team_id ?? "");
    const result = runTeam(teamId);
    return JSON.stringify({
      team_id: result.team.teamId,
      status: result.team.status,
      updated_task_ids: result.updatedTasks.map((task) => task.taskId),
      skipped_task_ids: result.skippedTaskIds,
      updated_count: result.updatedTasks.length,
      message: "Team run started"
    });
  }
  if (name === "CronCreate") {
    const cron = createCron(
      String(input.schedule ?? ""),
      String(input.prompt ?? ""),
      optionalString(input.description),
      optionalString(input.team_id)
    );
    return JSON.stringify({
      cron_id: cron.cronId,
      schedule: cron.schedule,
      prompt: cron.prompt,
      description: cron.description,
      team_id: cron.teamId,
      enabled: cron.enabled,
      created_at: cron.createdAt
    });
  }
  if (name === "CronDelete") {
    const cronId = String(input.cron_id ?? "");
    const cron = deleteCron(cronId);
    return JSON.stringify({
      cron_id: cron.cronId,
      schedule: cron.schedule,
      status: "deleted",
      message: "Cron entry removed"
    });
  }
  if (name === "CronDisable") {
    const cronId = String(input.cron_id ?? "");
    const cron = disableCron(cronId);
    return JSON.stringify({
      cron_id: cron.cronId,
      schedule: cron.schedule,
      enabled: cron.enabled,
      message: "Cron disabled"
    });
  }
  if (name === "CronRun") {
    const cronId = String(input.cron_id ?? "");
    const result = runCron(cronId);
    return JSON.stringify({
      cron_id: result.cron.cronId,
      schedule: result.cron.schedule,
      run_count: result.cron.runCount,
      last_run_at: result.cron.lastRunAt,
      team_id: result.cron.teamId,
      target_type: result.targetType,
      task: result.targetType === "task" ? serializeTaskSummary(result.task) : undefined,
      team: result.targetType === "team"
        ? {
            team_id: result.team.teamId,
            status: result.team.status,
            updated_task_ids: result.updatedTasks.map((task) => task.taskId),
            skipped_task_ids: result.skippedTaskIds
          }
        : undefined,
      message: "Cron run triggered"
    });
  }
  if (name === "CronList") {
    const entries = getGlobalCronRegistry().list(false);
    return JSON.stringify({
      entries: entries.map((entry) => ({
        cron_id: entry.cronId,
        schedule: entry.schedule,
        prompt: entry.prompt,
        description: entry.description,
        team_id: entry.teamId,
        enabled: entry.enabled,
        run_count: entry.runCount,
        last_run_at: entry.lastRunAt,
        created_at: entry.createdAt
      })),
      count: entries.length
    });
  }
  throw new Error(`unknown task/team/cron tool '${name}'`);
}

export function allowedToolsForSubagent(subagentType: string): Set<string> {
  const normalized = subagentType.trim().toLowerCase();
  if (normalized === "explore") {
    return new Set([
      "read_file",
      "grep_search",
      "glob_search",
      "ToolSearch",
      "Config",
      "ListMcpResources",
      "ReadMcpResource"
    ]);
  }
  if (normalized === "plan") {
    return new Set(["read_file", "grep_search", "glob_search", "Config"]);
  }
  if (normalized === "verification") {
    return new Set(["read_file", "grep_search", "bash"]);
  }
  return new Set([
    "read_file",
    "grep_search",
    "glob_search",
    "write_file",
    "bash",
    "Config",
    "MCP",
    "ListMcpResources",
    "ReadMcpResource",
    "ToolSearch"
  ]);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeTaskPacketInput(input: Record<string, unknown>): TaskPacket {
  return {
    objective: String(input.objective ?? ""),
    scope: String(input.scope ?? ""),
    repo: String(input.repo ?? ""),
    branchPolicy: String(input.branchPolicy ?? input.branch_policy ?? ""),
    acceptanceTests: Array.isArray(input.acceptanceTests)
      ? input.acceptanceTests.map((value) => String(value))
      : Array.isArray(input.acceptance_tests)
        ? input.acceptance_tests.map((value) => String(value))
        : [],
    commitPolicy: String(input.commitPolicy ?? input.commit_policy ?? ""),
    reportingContract: String(input.reportingContract ?? input.reporting_contract ?? ""),
    escalationPolicy: String(input.escalationPolicy ?? input.escalation_policy ?? "")
  };
}

function normalizeTeamTaskIds(input: Record<string, unknown>): string[] {
  const taskValues = Array.isArray(input.tasks) ? input.tasks : [];
  const fromObjects = taskValues
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => optionalString(value.task_id))
    .filter((value): value is string => Boolean(value));
  if (fromObjects.length > 0) {
    return fromObjects;
  }
  return Array.isArray(input.task_ids)
    ? input.task_ids.map((value) => String(value)).filter((value) => value.trim().length > 0)
    : [];
}

function serializeTaskSummary(task: {
  taskId: string;
  status: string;
  prompt: string;
  description?: string;
  taskPacket?: TaskPacket;
  createdAt: number;
}) {
  return {
    task_id: task.taskId,
    status: task.status,
    prompt: task.prompt,
    description: task.description,
    task_packet: task.taskPacket ? serializeTaskPacket(task.taskPacket) : undefined,
    created_at: task.createdAt
  };
}

function serializeTaskListEntry(task: {
  taskId: string;
  status: string;
  prompt: string;
  description?: string;
  taskPacket?: TaskPacket;
  createdAt: number;
  updatedAt: number;
  teamId?: string;
}) {
  return {
    ...serializeTaskSummary(task),
    updated_at: task.updatedAt,
    team_id: task.teamId
  };
}

function serializeTaskDetail(task: {
  taskId: string;
  status: string;
  prompt: string;
  description?: string;
  taskPacket?: TaskPacket;
  createdAt: number;
  updatedAt: number;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  teamId?: string;
}) {
  return {
    ...serializeTaskListEntry(task),
    messages: task.messages.map((message) => ({ ...message }))
  };
}

function serializeTaskPacket(packet: TaskPacket) {
  return {
    objective: packet.objective,
    scope: packet.scope,
    repo: packet.repo,
    branch_policy: packet.branchPolicy,
    acceptance_tests: [...packet.acceptanceTests],
    commit_policy: packet.commitPolicy,
    reporting_contract: packet.reportingContract,
    escalation_policy: packet.escalationPolicy
  };
}
