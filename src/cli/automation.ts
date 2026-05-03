import {
  assignTaskTeam,
  createCron,
  createTask,
  createTeam,
  deleteCron,
  deleteTask,
  deleteTeam,
  disableCron,
  getGlobalCronRegistry,
  getGlobalTaskRegistry,
  getGlobalTeamRegistry,
  messageTeam,
  runCron,
  runTeam,
  stopTask,
  updateTask
} from "../runtime/index.js";
import {
  renderCronCreateView,
  renderCronDeleteView,
  renderCronDetailView,
  renderCronDisableView,
  renderCronRunView,
  renderCronsListView,
  renderCronsUsageView,
  renderTaskCreateView,
  renderTaskDeleteView,
  renderTaskDetailView,
  renderTaskMessagesView,
  renderTaskOutputView,
  renderTasksListView,
  renderTasksUsageView,
  renderTaskStopView,
  renderTaskUpdateView,
  renderTeamCreateView,
  renderTeamDeleteView,
  renderTeamDetailView,
  renderTeamMessageView,
  renderTeamRunView,
  renderTeamsListView,
  renderTeamsUsageView
} from "./views";

export function printTasks(
  action: "list" | "get" | "stop" | "output" | "create" | "update" | "messages" | "delete" | undefined,
  target: string | undefined,
  options?: { prompt?: string; description?: string; message?: string }
): void {
  const registry = getGlobalTaskRegistry();
  if (!action || action === "list") {
    const tasks = registry.list();
    process.stdout.write(renderTasksListView({
      count: tasks.length,
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        status: task.status,
        prompt: task.prompt,
        description: task.description
      }))
    }));
    return;
  }
  if (action === "create") {
    const prompt = options?.prompt?.trim();
    if (!prompt) {
      process.stdout.write(renderTasksUsageView());
      return;
    }
    const task = createTask(prompt, options?.description?.trim() || undefined);
    process.stdout.write(renderTaskCreateView({
      taskId: task.taskId,
      status: task.status,
      prompt: task.prompt,
      description: task.description
    }));
    return;
  }
  if (action === "update") {
    const message = options?.message?.trim();
    if (!target || !message) {
      process.stdout.write(renderTasksUsageView());
      return;
    }
    const task = updateTask(target, message);
    process.stdout.write(renderTaskUpdateView({
      taskId: task.taskId,
      status: task.status,
      messageCount: task.messages.length,
      message
    }));
    return;
  }
  if (action === "messages") {
    if (!target) {
      process.stdout.write(renderTasksUsageView());
      return;
    }
    const task = registry.get(target);
    if (!task) {
      throw new Error(`task not found: ${target}`);
    }
    process.stdout.write(renderTaskMessagesView({
      taskId: task.taskId,
      messages: task.messages
    }));
    return;
  }
  if (action === "delete") {
    if (!target) {
      process.stdout.write(renderTasksUsageView());
      return;
    }
    const task = deleteTask(target);
    process.stdout.write(renderTaskDeleteView({
      taskId: task.taskId,
      prompt: task.prompt
    }));
    return;
  }
  if (!target) {
    process.stdout.write(renderTasksUsageView());
    return;
  }
  if (action === "get") {
    const task = registry.get(target);
    if (!task) {
      throw new Error(`task not found: ${target}`);
    }
    process.stdout.write(renderTaskDetailView({
      taskId: task.taskId,
      status: task.status,
      prompt: task.prompt,
      description: task.description,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      messageCount: task.messages.length,
      teamId: task.teamId
    }));
    return;
  }
  if (action === "output") {
    const output = registry.output(target);
    process.stdout.write(renderTaskOutputView({
      taskId: target,
      output,
      hasOutput: Boolean(output)
    }));
    return;
  }
  const task = stopTask(target);
  process.stdout.write(renderTaskStopView({
    taskId: task.taskId,
    status: task.status,
    message: "Task stopped"
  }));
}

export function printTeams(
  action: "list" | "get" | "delete" | "create" | "message" | "run" | undefined,
  target: string | undefined,
  options?: { name?: string; taskIds?: string[]; message?: string }
): void {
  const registry = getGlobalTeamRegistry();
  if (!action || action === "list") {
    const teams = registry.list();
    process.stdout.write(renderTeamsListView({
      count: teams.length,
      teams: teams.map((team) => ({
        teamId: team.teamId,
        name: team.name,
        status: team.status,
        taskCount: team.taskIds.length,
        taskStatusSummary: summarizeTeamTaskStatuses(team.taskIds),
        missingTaskCount: countMissingTasks(team.taskIds)
      }))
    }));
    return;
  }
  if (action === "create") {
    const name = options?.name?.trim();
    if (!name) {
      process.stdout.write(renderTeamsUsageView());
      return;
    }
    const team = createTeam(name, options?.taskIds ?? []);
    for (const taskId of team.taskIds) {
      try {
        assignTaskTeam(taskId, team.teamId);
      } catch {
        // Missing tasks do not block team creation.
      }
    }
    process.stdout.write(renderTeamCreateView({
      teamId: team.teamId,
      name: team.name,
      status: team.status,
      taskIds: team.taskIds
    }));
    return;
  }
  if (action === "message") {
    const message = options?.message?.trim();
    if (!target || !message) {
      process.stdout.write(renderTeamsUsageView());
      return;
    }
    const result = messageTeam(target, message);
    process.stdout.write(renderTeamMessageView({
      teamId: result.team.teamId,
      status: result.team.status,
      message,
      updatedCount: result.updatedTasks.length,
      skippedTaskIds: result.skippedTaskIds
    }));
    return;
  }
  if (action === "run") {
    if (!target) {
      process.stdout.write(renderTeamsUsageView());
      return;
    }
    const result = runTeam(target);
    process.stdout.write(renderTeamRunView({
      teamId: result.team.teamId,
      status: result.team.status,
      updatedCount: result.updatedTasks.length,
      skippedTaskIds: result.skippedTaskIds
    }));
    return;
  }
  if (!target) {
    process.stdout.write(renderTeamsUsageView());
    return;
  }
  if (action === "get") {
    const team = registry.get(target);
    if (!team) {
      throw new Error(`team not found: ${target}`);
    }
    const taskSummaries = team.taskIds
      .map((taskId) => getGlobalTaskRegistry().get(taskId))
      .filter((task): task is NonNullable<typeof task> => Boolean(task))
      .map((task) => ({
        taskId: task.taskId,
        status: task.status,
        prompt: task.prompt,
        messageCount: task.messages.length
      }));
    const resolvedTaskIds = new Set(taskSummaries.map((task) => task.taskId));
    process.stdout.write(renderTeamDetailView({
      teamId: team.teamId,
      name: team.name,
      status: team.status,
      taskIds: team.taskIds,
      taskSummaries,
      missingTaskIds: team.taskIds.filter((taskId) => !resolvedTaskIds.has(taskId)),
      createdAt: team.createdAt,
      updatedAt: team.updatedAt
    }));
    return;
  }
  const team = deleteTeam(target);
  process.stdout.write(renderTeamDeleteView({
    teamId: team.teamId,
    name: team.name,
    status: team.status
  }));
}

export function printCrons(
  action: "list" | "get" | "delete" | "create" | "create-team" | "disable" | "run" | undefined,
  target: string | undefined,
  options?: { schedule?: string; prompt?: string; description?: string; teamId?: string }
): void {
  const registry = getGlobalCronRegistry();
  if (!action || action === "list") {
    const entries = registry.list(false);
    process.stdout.write(renderCronsListView({
      count: entries.length,
      crons: entries.map((entry) => ({
        cronId: entry.cronId,
        schedule: entry.schedule,
        enabled: entry.enabled,
        runCount: entry.runCount,
        description: entry.description,
        teamId: entry.teamId
      }))
    }));
    return;
  }
  if (action === "create") {
    const schedule = options?.schedule?.trim();
    const prompt = options?.prompt?.trim();
    if (!schedule || !prompt) {
      process.stdout.write(renderCronsUsageView());
      return;
    }
    const cron = createCron(schedule, prompt, options?.description?.trim() || undefined);
    process.stdout.write(renderCronCreateView({
      cronId: cron.cronId,
      schedule: cron.schedule,
      prompt: cron.prompt,
      description: cron.description,
      teamId: cron.teamId,
      enabled: cron.enabled
    }));
    return;
  }
  if (action === "create-team") {
    const schedule = options?.schedule?.trim();
    const teamId = options?.teamId?.trim();
    if (!schedule || !teamId) {
      process.stdout.write(renderCronsUsageView());
      return;
    }
    const cron = createCron(schedule, `Run team ${teamId}`, options?.description?.trim() || undefined, teamId);
    process.stdout.write(renderCronCreateView({
      cronId: cron.cronId,
      schedule: cron.schedule,
      prompt: cron.prompt,
      description: cron.description,
      teamId: cron.teamId,
      enabled: cron.enabled
    }));
    return;
  }
  if (action === "disable") {
    if (!target) {
      process.stdout.write(renderCronsUsageView());
      return;
    }
    const cron = disableCron(target);
    process.stdout.write(renderCronDisableView({
      cronId: cron.cronId,
      schedule: cron.schedule,
      enabled: cron.enabled
    }));
    return;
  }
  if (action === "run") {
    if (!target) {
      process.stdout.write(renderCronsUsageView());
      return;
    }
    const result = runCron(target);
    process.stdout.write(renderCronRunView({
      cronId: result.cron.cronId,
      schedule: result.cron.schedule,
      runCount: result.cron.runCount,
      targetType: result.targetType,
      taskId: result.targetType === "task" ? result.task.taskId : undefined,
      taskPrompt: result.targetType === "task" ? result.task.prompt : undefined,
      teamId: result.targetType === "team" ? result.team.teamId : undefined,
      updatedCount: result.targetType === "team" ? result.updatedTasks.length : undefined,
      skippedTaskIds: result.targetType === "team" ? result.skippedTaskIds : undefined
    }));
    return;
  }
  if (!target) {
    process.stdout.write(renderCronsUsageView());
    return;
  }
  if (action === "get") {
    const cron = registry.get(target);
    if (!cron) {
      throw new Error(`cron not found: ${target}`);
    }
    process.stdout.write(renderCronDetailView({
      cronId: cron.cronId,
      schedule: cron.schedule,
      prompt: cron.prompt,
      description: cron.description,
      teamId: cron.teamId,
      enabled: cron.enabled,
      runCount: cron.runCount,
      lastRunAt: cron.lastRunAt,
      createdAt: cron.createdAt,
      updatedAt: cron.updatedAt
    }));
    return;
  }
  const cron = deleteCron(target);
  process.stdout.write(renderCronDeleteView({
    cronId: cron.cronId,
    schedule: cron.schedule
  }));
}

function summarizeTeamTaskStatuses(taskIds: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const taskId of taskIds) {
    const task = getGlobalTaskRegistry().get(taskId);
    if (!task) {
      continue;
    }
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return undefined;
  }
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
}

function countMissingTasks(taskIds: string[]): number {
  return taskIds.filter((taskId) => !getGlobalTaskRegistry().get(taskId)).length;
}
