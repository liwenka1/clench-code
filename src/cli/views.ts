import type {
  ConfigLoadDiagnostic,
  ConfigValidationResult,
  McpServerConfig,
  McpServerState,
  RemoteMcpSseRuntimeState,
  SandboxStatus,
  TurnSummary
} from "../runtime";
import { estimateCostUsd, formatUsd, pricingForModel, summaryLinesForModel, totalTokens } from "../runtime";
import { canonicalToolName } from "../tools/index.js";
import { renderSlashCommandHelp } from "../commands";
import {
  dim,
  emphasize,
  finishSpinner,
  renderKeyValueRows,
  renderMarkdown,
  renderPanel,
  renderSection,
  summarizeTextBlock,
  type RenderTone
} from "./render";

export interface BannerContext {
  model: string;
  permissionMode: string;
  sessionLabel?: string;
  cwd?: string;
}

export function renderReplBanner(context: BannerContext): string {
  const art = [emphasize("CLENCH"), dim("interactive terminal")].join(" ");
  const meta = renderKeyValueRows([
    { key: "Model", value: context.model },
    { key: "Permissions", value: context.permissionMode },
    { key: "Session", value: context.sessionLabel ?? "ephemeral" },
    { key: "Workspace", value: context.cwd }
  ]);
  return [art, ...meta, dim("Tip: Tab completes commands, Ctrl-C cancels draft, /multiline composes multi-line prompts")].join("\n");
}

export function renderPromptSummary(summary: TurnSummary): string {
  return renderPromptSummaryWithModel(summary);
}

export function renderPromptSummaryWithModel(summary: TurnSummary, model?: string): string {
  const lines: string[] = [];
  for (const msg of summary.assistantMessages) {
    for (const block of msg.blocks) {
      if (block.type === "text") {
        lines.push(renderMarkdown(block.text));
      } else if (block.type === "tool_use") {
        lines.push(renderToolStartPanel(block.name, block.input));
      }
    }
  }
  for (const toolResult of summary.toolResults) {
    const block = toolResult.blocks[0];
    if (block?.type === "tool_result") {
      lines.push(renderToolResultPanel(block.tool_name, block.output, block.is_error));
    }
  }
  const toolTimeline = renderToolTimeline(summary.toolResults);
  if (toolTimeline) {
    lines.push(toolTimeline);
  }
  const autoCompaction = renderAutoCompactionNotice(summary);
  if (autoCompaction) {
    lines.push(autoCompaction);
  }
  if (summary.mcpTurnRuntime) {
    lines.push(renderMcpTurnSummary(summary.mcpTurnRuntime));
  }
  const usageSummary = renderUsageSummary(summary, model);
  if (usageSummary) {
    lines.push(usageSummary);
  }
  return lines.filter(Boolean).join("\n");
}

export function renderMcpTurnSummary(summary: NonNullable<TurnSummary["mcpTurnRuntime"]>): string {
  const lines = [
    `[mcp servers=${summary.configuredServerCount} sse_sessions=${summary.activeSseSessions}/${summary.sseServerCount} reconnects=${summary.totalReconnects}]`
  ];
  for (const activity of summary.activities) {
    lines.push(
      `[mcp activity ${activity.serverName} tools=${activity.toolCallCount} resource_lists=${activity.resourceListCount} resource_reads=${activity.resourceReadCount} errors=${activity.errorCount}${activity.toolNames.length ? ` tool_names=${activity.toolNames.join(",")}` : ""}${activity.resourceUris.length ? ` resource_uris=${activity.resourceUris.join(",")}` : ""}]`
    );
  }
  for (const event of summary.events) {
    lines.push(
      `[mcp event #${event.order} ${event.serverName} ${event.kind} ${event.name} error=${event.isError ? "true" : "false"}]`
    );
  }
  for (const change of summary.sessionChanges) {
    lines.push(
      `[mcp ${change.serverName} session ${change.connectionBefore}->${change.connectionAfter} reconnects ${change.reconnectsBefore}->${change.reconnectsAfter}${change.lastError ? ` error=${change.lastError}` : ""}]`
    );
  }
  return lines.join("\n");
}

export function renderToolStartPanel(toolName: string, input: string): string {
  return renderPanel(`tool ${toolName}`, summarizeToolCall(toolName, input), { tone: "info" });
}

export function renderToolResultPanel(toolName: string, output: string, isError: boolean): string {
  const tone: RenderTone = isError ? "error" : "success";
  const status = isError ? finishSpinner(`tool ${toolName} failed`, "error") : finishSpinner(`tool ${toolName} completed`);
  const lines = [status, ...summarizeToolResult(toolName, output, isError)];
  return renderPanel(`result ${toolName}`, lines, { tone });
}

export function renderToolTimeline(toolResults: TurnSummary["toolResults"]): string | undefined {
  const items = toolResults
    .map((message) => message.blocks[0])
    .filter((block): block is Extract<typeof block, { type: "tool_result" }> => block?.type === "tool_result")
    .map((block) => `${block.is_error ? "x" : "+"} ${block.tool_name}`);
  if (items.length === 0) {
    return undefined;
  }
  return `[tools ${items.join(" | ")}]`;
}

export function renderPermissionPanel(request: {
  toolName: string;
  currentMode: string;
  requiredMode: string;
  reason?: string;
  input: string;
}): string {
  return renderPanel(
    `permission ${request.toolName}`,
    [
      ...renderKeyValueRows([
        { key: "Current", value: request.currentMode },
        { key: "Required", value: request.requiredMode },
        { key: "Reason", value: request.reason ?? "tool requested escalation" }
      ]),
      ...summarizeTextBlock(request.input, { maxLines: 6, maxCharsPerLine: 100 }),
      "Allow? [y/N]"
    ],
    { tone: "warning" }
  );
}

export function renderPromptCacheEvents(summary: TurnSummary): string | undefined {
  if (summary.promptCacheEvents.length === 0) {
    return undefined;
  }
  return renderPanel(
    "prompt cache",
    summary.promptCacheEvents.map((event) => `${event.reason} drop=${event.tokenDrop}`),
    { tone: "info" }
  );
}

export function renderAutoCompactionNotice(summary: TurnSummary): string | undefined {
  if (!summary.autoCompaction) {
    return undefined;
  }
  return `[auto-compacted: removed ${summary.autoCompaction.removedMessageCount} messages]`;
}

export function renderUsageSummary(summary: TurnSummary, model?: string): string | undefined {
  if (!summary.usage || summary.usage.input_tokens === 0 && summary.usage.output_tokens === 0 && (summary.usage.cache_creation_input_tokens ?? 0) === 0 && (summary.usage.cache_read_input_tokens ?? 0) === 0) {
    return undefined;
  }
  return renderPanel("usage", summaryLinesForModel("cumulative", summary.usage, model), { tone: "neutral" });
}

export function renderStatusView(input: {
  model: string;
  permissionMode: string;
  outputFormat?: string;
  allowedTools?: string;
  sessionPath?: string;
  messageCount?: number;
  mcpSummary?: {
    serverCount: number;
    sseServerCount: number;
    activeSseSessions: number;
    totalReconnects: number;
  };
}): string {
  const section = renderSection("Status", [
    { key: "Model", value: input.model },
    { key: "Permission mode", value: input.permissionMode },
    { key: "Output format", value: input.outputFormat },
    { key: "Allowed tools", value: input.allowedTools },
    { key: "Messages", value: input.messageCount },
    { key: "Session", value: input.sessionPath },
    { key: "MCP servers", value: input.mcpSummary?.serverCount },
    {
      key: "MCP SSE sessions",
      value: input.mcpSummary
        ? `${input.mcpSummary.activeSseSessions}/${input.mcpSummary.sseServerCount} active`
        : undefined
    },
    { key: "MCP reconnects", value: input.mcpSummary?.totalReconnects }
  ]);
  return `${section}\n`;
}

export interface DoctorCheckView {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export function renderInitView(input: {
  projectRoot: string;
  artifacts: Array<{ name: string; status: "created" | "updated" | "skipped" }>;
}): string {
  const lines = [
    renderSection("Init", [{ key: "Project", value: input.projectRoot }]),
    ...input.artifacts.map((artifact) => `  ${artifact.name.padEnd(16, " ")} ${renderInitStatus(artifact.status)}`),
    "  Next step        Review and tailor the generated guidance"
  ];
  return `${lines.join("\n")}\n`;
}

export function renderVersionView(input: { version: string }): string {
  return `${renderSection("Clench Code", [{ key: "Version", value: input.version }])}\n`;
}

export function renderModelView(input: {
  current: string;
  previous?: string;
}): string {
  return `${renderSection("Model", [
    { key: "Current", value: input.current },
    { key: "Previous", value: input.previous }
  ])}\n`;
}

export function renderModelListView(input: {
  current: string;
  defaultModel: string;
  currentProvider?: string;
  currentBaseUrl?: string;
  providers: Array<{
    id: string;
    kind: string;
    baseUrl: string;
    defaultModel?: string;
    current?: boolean;
  }>;
}): string {
  const sections = [
    renderSection("Model", [
      { key: "Current", value: input.current },
      { key: "Default", value: input.defaultModel },
      { key: "Provider", value: input.currentProvider },
      { key: "Base URL", value: input.currentBaseUrl },
      { key: "Providers", value: input.providers.length }
    ])
  ];

  const providerLines =
    input.providers.length > 0
      ? input.providers.map((provider) => {
          const segments = [
            provider.current ? `* ${provider.id}` : `  ${provider.id}`,
            `kind=${provider.kind}`,
            `base_url=${provider.baseUrl}`
          ];
          if (provider.defaultModel) {
            segments.push(`default_model=${provider.defaultModel}`);
          }
          return segments.join("  ");
        })
      : [dim("no configured providers")];

  sections.push(renderPanel("Configured providers", providerLines, { tone: "neutral" }));
  return `${sections.join("\n")}\n`;
}

export function renderCostView(input: {
  model: string;
  turns: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}): string {
  const pricing = pricingForModel(input.model);
  const estimate = pricing ? estimateCostUsd(input.usage, pricing) : estimateCostUsd(input.usage);
  return `${renderSection("Cost", [
    { key: "Model", value: input.model },
    { key: "Turns", value: input.turns },
    { key: "Input tokens", value: input.usage.input_tokens },
    { key: "Output tokens", value: input.usage.output_tokens },
    { key: "Cache create", value: input.usage.cache_creation_input_tokens ?? 0 },
    { key: "Cache read", value: input.usage.cache_read_input_tokens ?? 0 },
    { key: "Total tokens", value: totalTokens(input.usage) },
    { key: "Estimated cost", value: formatUsd(estimate.totalCostUsd) },
    { key: "Pricing", value: pricing ? "model-specific" : "estimated-default" }
  ])}\n`;
}

export function renderDiffView(input: {
  result: "no_git_repo" | "clean" | "changes";
  detail?: string;
  staged?: string;
  unstaged?: string;
}): string {
  if (input.result === "no_git_repo") {
    return `${renderSection("Diff", [
      { key: "Result", value: "no git repository" },
      { key: "Detail", value: input.detail }
    ])}\n`;
  }
  if (input.result === "clean") {
    return `${renderSection("Diff", [
      { key: "Result", value: "clean working tree" },
      { key: "Detail", value: input.detail ?? "no current changes" }
    ])}\n`;
  }
  const sections = [renderSection("Diff", [{ key: "Result", value: "changes" }])];
  if (input.staged?.trim()) {
    sections.push(renderPanel("Staged changes", input.staged.trimEnd().split("\n"), { tone: "neutral" }));
  }
  if (input.unstaged?.trim()) {
    sections.push(renderPanel("Unstaged changes", input.unstaged.trimEnd().split("\n"), { tone: "neutral" }));
  }
  return `${sections.join("\n\n")}\n`;
}

export function renderMemoryView(input: {
  cwd: string;
  files: Array<{ path: string; lines: number; preview: string }>;
}): string {
  const lines = [
    renderSection("Memory", [
      { key: "Workspace", value: input.cwd },
      { key: "Instruction files", value: input.files.length }
    ])
  ];
  if (input.files.length === 0) {
    lines.push("  No CLAUDE instruction files discovered in the current directory ancestry.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("Discovered files");
  for (const [index, file] of input.files.entries()) {
    lines.push(`  ${index + 1}. ${file.path}`);
    lines.push(`     lines=${file.lines} preview=${file.preview || "<empty>"}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderTasksUsageView(): string {
  return `${renderSection("Tasks", [
    {
      key: "Usage",
      value: "/tasks [list|get <task-id>|stop <task-id>|output <task-id>|messages <task-id>|delete <task-id>|create <prompt> [description]|update <task-id> <message>]"
    },
    {
      key: "Direct CLI",
      value: "clench tasks [list|get <task-id>|stop <task-id>|output <task-id>|messages <task-id>|delete <task-id>|create <prompt> [description]|update <task-id> <message>]"
    }
  ])}\n`;
}

export function renderTasksListView(input: {
  count: number;
  tasks: Array<{
    taskId: string;
    status: string;
    prompt: string;
    description?: string;
  }>;
}): string {
  const lines = [renderSection("Tasks", [{ key: "Count", value: input.count }])];
  if (input.tasks.length === 0) {
    lines.push("  No tasks created in this process.");
    return `${lines.join("\n")}\n`;
  }
  for (const task of input.tasks) {
    lines.push(`  ${task.taskId}  ${task.status}`);
    lines.push(`     prompt=${task.prompt}`);
    if (task.description) {
      lines.push(`     description=${task.description}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderTaskDetailView(input: {
  taskId: string;
  status: string;
  prompt: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  teamId?: string;
}): string {
  return `${renderSection("Task", [
    { key: "Task", value: input.taskId },
    { key: "Status", value: input.status },
    { key: "Prompt", value: input.prompt },
    { key: "Description", value: input.description },
    { key: "Created at", value: input.createdAt },
    { key: "Updated at", value: input.updatedAt },
    { key: "Messages", value: input.messageCount },
    { key: "Team", value: input.teamId }
  ])}\n`;
}

export function renderTaskStopView(input: {
  taskId: string;
  status: string;
  message: string;
}): string {
  return `${renderSection("Tasks", [
    { key: "Task", value: input.taskId },
    { key: "Status", value: input.status },
    { key: "Result", value: input.message }
  ])}\n`;
}

export function renderTaskCreateView(input: {
  taskId: string;
  status: string;
  prompt: string;
  description?: string;
}): string {
  return `${renderSection("Tasks", [
    { key: "Task", value: input.taskId },
    { key: "Status", value: input.status },
    { key: "Prompt", value: input.prompt },
    { key: "Description", value: input.description },
    { key: "Result", value: "Task created" }
  ])}\n`;
}

export function renderTaskUpdateView(input: {
  taskId: string;
  status: string;
  messageCount: number;
  message: string;
}): string {
  return `${renderSection("Tasks", [
    { key: "Task", value: input.taskId },
    { key: "Status", value: input.status },
    { key: "Messages", value: input.messageCount },
    { key: "Last message", value: input.message },
    { key: "Result", value: "Task updated" }
  ])}\n`;
}

export function renderTaskMessagesView(input: {
  taskId: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: number;
  }>;
}): string {
  const lines = [renderSection("Task Messages", [
    { key: "Task", value: input.taskId },
    { key: "Count", value: input.messages.length }
  ])];
  if (input.messages.length === 0) {
    lines.push("  No messages recorded for this task.");
    return `${lines.join("\n")}\n`;
  }
  for (const [index, message] of input.messages.entries()) {
    lines.push(`  ${index + 1}. ${message.role} @ ${message.timestamp}`);
    lines.push(`     ${message.content}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderTaskDeleteView(input: {
  taskId: string;
  prompt: string;
}): string {
  return `${renderSection("Tasks", [
    { key: "Task", value: input.taskId },
    { key: "Prompt", value: input.prompt },
    { key: "Result", value: "Task deleted" }
  ])}\n`;
}

export function renderTaskOutputView(input: {
  taskId: string;
  output: string;
  hasOutput: boolean;
}): string {
  const lines = [renderSection("Task Output", [
    { key: "Task", value: input.taskId },
    { key: "Has output", value: input.hasOutput }
  ])];
  if (!input.hasOutput) {
    lines.push("  No output recorded for this task.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(renderPanel("Output", input.output.trimEnd().split("\n"), { tone: "neutral" }));
  return `${lines.join("\n\n")}\n`;
}

export function renderTeamsUsageView(): string {
  return `${renderSection("Teams", [
    { key: "Usage", value: "/teams [list|get <team-id>|delete <team-id>|create <name> [task-id...]|message <team-id> <message>|run <team-id>]" },
    { key: "Direct CLI", value: "clench teams [list|get <team-id>|delete <team-id>|create <name> [task-id...]|message <team-id> <message>|run <team-id>]" }
  ])}\n`;
}

export function renderTeamsListView(input: {
  count: number;
  teams: Array<{
    teamId: string;
    name: string;
    status: string;
    taskCount: number;
    taskStatusSummary?: string;
    missingTaskCount?: number;
  }>;
}): string {
  const lines = [renderSection("Teams", [{ key: "Count", value: input.count }])];
  if (input.teams.length === 0) {
    lines.push("  No teams created in this process.");
    return `${lines.join("\n")}\n`;
  }
  for (const team of input.teams) {
    lines.push(`  ${team.teamId}  ${team.status}`);
    lines.push(`     name=${team.name}`);
    lines.push(`     tasks=${team.taskCount}`);
    if (team.taskStatusSummary) {
      lines.push(`     task_statuses=${team.taskStatusSummary}`);
    }
    if (team.missingTaskCount) {
      lines.push(`     missing_tasks=${team.missingTaskCount}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderTeamDetailView(input: {
  teamId: string;
  name: string;
  status: string;
  taskIds: string[];
  taskSummaries: Array<{
    taskId: string;
    status: string;
    prompt: string;
    messageCount: number;
  }>;
  missingTaskIds?: string[];
  createdAt: number;
  updatedAt: number;
}): string {
  const lines = [renderSection("Team", [
    { key: "Team", value: input.teamId },
    { key: "Name", value: input.name },
    { key: "Status", value: input.status },
    { key: "Tasks", value: input.taskIds.length },
    { key: "Task IDs", value: input.taskIds.join(", ") || "<none>" },
    { key: "Resolved tasks", value: input.taskSummaries.length },
    { key: "Missing tasks", value: input.missingTaskIds?.length ?? 0 },
    { key: "Created at", value: input.createdAt },
    { key: "Updated at", value: input.updatedAt }
  ])];
  if (input.taskSummaries.length > 0) {
    lines.push("  Linked tasks");
    for (const task of input.taskSummaries) {
      lines.push(`    ${task.taskId}  ${task.status}`);
      lines.push(`      prompt=${task.prompt}`);
      lines.push(`      messages=${task.messageCount}`);
    }
  }
  if ((input.missingTaskIds?.length ?? 0) > 0) {
    lines.push(`  Missing tasks  ${input.missingTaskIds!.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderTeamDeleteView(input: {
  teamId: string;
  name: string;
  status: string;
}): string {
  return `${renderSection("Teams", [
    { key: "Team", value: input.teamId },
    { key: "Name", value: input.name },
    { key: "Status", value: input.status },
    { key: "Result", value: "Team deleted" }
  ])}\n`;
}

export function renderTeamCreateView(input: {
  teamId: string;
  name: string;
  status: string;
  taskIds: string[];
}): string {
  return `${renderSection("Teams", [
    { key: "Team", value: input.teamId },
    { key: "Name", value: input.name },
    { key: "Status", value: input.status },
    { key: "Tasks", value: input.taskIds.length },
    { key: "Task IDs", value: input.taskIds.join(", ") || "<none>" },
    { key: "Result", value: "Team created" }
  ])}\n`;
}

export function renderTeamMessageView(input: {
  teamId: string;
  status: string;
  message: string;
  updatedCount: number;
  skippedTaskIds: string[];
}): string {
  return `${renderSection("Teams", [
    { key: "Team", value: input.teamId },
    { key: "Status", value: input.status },
    { key: "Message", value: input.message },
    { key: "Updated tasks", value: input.updatedCount },
    { key: "Skipped tasks", value: input.skippedTaskIds.join(", ") || "<none>" },
    { key: "Result", value: "Team message applied" }
  ])}\n`;
}

export function renderTeamRunView(input: {
  teamId: string;
  status: string;
  updatedCount: number;
  skippedTaskIds: string[];
}): string {
  return `${renderSection("Teams", [
    { key: "Team", value: input.teamId },
    { key: "Status", value: input.status },
    { key: "Updated tasks", value: input.updatedCount },
    { key: "Skipped tasks", value: input.skippedTaskIds.join(", ") || "<none>" },
    { key: "Result", value: "Team run started" }
  ])}\n`;
}

export function renderCronsUsageView(): string {
  return `${renderSection("Crons", [
    {
      key: "Usage",
      value: "/crons [list|get <cron-id>|delete <cron-id>|create \"<schedule>\" \"<prompt>\" [description]|create-team \"<schedule>\" <team-id> [description]|disable <cron-id>|run <cron-id>]"
    },
    {
      key: "Direct CLI",
      value: "clench crons [list|get <cron-id>|delete <cron-id>|create \"<schedule>\" \"<prompt>\" [description]|create-team \"<schedule>\" <team-id> [description]|disable <cron-id>|run <cron-id>]"
    }
  ])}\n`;
}

export function renderCronsListView(input: {
  count: number;
  crons: Array<{
    cronId: string;
    schedule: string;
    enabled: boolean;
    runCount: number;
    description?: string;
    teamId?: string;
  }>;
}): string {
  const lines = [renderSection("Crons", [{ key: "Count", value: input.count }])];
  if (input.crons.length === 0) {
    lines.push("  No cron entries created in this process.");
    return `${lines.join("\n")}\n`;
  }
  for (const cron of input.crons) {
    lines.push(`  ${cron.cronId}  enabled=${cron.enabled}`);
    lines.push(`     schedule=${cron.schedule}`);
    lines.push(`     run_count=${cron.runCount}`);
    if (cron.teamId) {
      lines.push(`     team=${cron.teamId}`);
    }
    if (cron.description) {
      lines.push(`     description=${cron.description}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderCronDetailView(input: {
  cronId: string;
  schedule: string;
  prompt: string;
  description?: string;
  teamId?: string;
  enabled: boolean;
  runCount: number;
  lastRunAt?: number;
  createdAt: number;
  updatedAt: number;
}): string {
  return `${renderSection("Cron", [
    { key: "Cron", value: input.cronId },
    { key: "Schedule", value: input.schedule },
    { key: "Prompt", value: input.prompt },
    { key: "Description", value: input.description },
    { key: "Team", value: input.teamId },
    { key: "Enabled", value: input.enabled },
    { key: "Run count", value: input.runCount },
    { key: "Last run", value: input.lastRunAt },
    { key: "Created at", value: input.createdAt },
    { key: "Updated at", value: input.updatedAt }
  ])}\n`;
}

export function renderCronDeleteView(input: {
  cronId: string;
  schedule: string;
}): string {
  return `${renderSection("Crons", [
    { key: "Cron", value: input.cronId },
    { key: "Schedule", value: input.schedule },
    { key: "Result", value: "Cron entry removed" }
  ])}\n`;
}

export function renderCronDisableView(input: {
  cronId: string;
  schedule: string;
  enabled: boolean;
}): string {
  return `${renderSection("Crons", [
    { key: "Cron", value: input.cronId },
    { key: "Schedule", value: input.schedule },
    { key: "Enabled", value: input.enabled },
    { key: "Result", value: "Cron disabled" }
  ])}\n`;
}

export function renderCronCreateView(input: {
  cronId: string;
  schedule: string;
  prompt: string;
  description?: string;
  teamId?: string;
  enabled: boolean;
}): string {
  return `${renderSection("Crons", [
    { key: "Cron", value: input.cronId },
    { key: "Schedule", value: input.schedule },
    { key: "Prompt", value: input.prompt },
    { key: "Description", value: input.description },
    { key: "Team", value: input.teamId },
    { key: "Enabled", value: input.enabled },
    { key: "Result", value: "Cron created" }
  ])}\n`;
}

export function renderCronRunView(input: {
  cronId: string;
  schedule: string;
  runCount: number;
  targetType: "task" | "team";
  taskId?: string;
  taskPrompt?: string;
  teamId?: string;
  updatedCount?: number;
  skippedTaskIds?: string[];
}): string {
  return `${renderSection("Cron Run", [
    { key: "Cron", value: input.cronId },
    { key: "Schedule", value: input.schedule },
    { key: "Run count", value: input.runCount },
    { key: "Target", value: input.targetType },
    { key: "Task", value: input.taskId },
    { key: "Task prompt", value: input.taskPrompt },
    { key: "Team", value: input.teamId },
    { key: "Updated tasks", value: input.updatedCount },
    { key: "Skipped tasks", value: input.skippedTaskIds?.join(", ") || undefined },
    { key: "Result", value: "Cron run triggered" }
  ])}\n`;
}

export function renderDoctorView(input: {
  cwd: string;
  model: string;
  provider: string;
  configFiles: string[];
  checks: DoctorCheckView[];
}): string {
  const counts = {
    pass: input.checks.filter((check) => check.status === "pass").length,
    warn: input.checks.filter((check) => check.status === "warn").length,
    fail: input.checks.filter((check) => check.status === "fail").length
  };
  const lines = [
    renderSection("Doctor", [
      { key: "Workspace", value: input.cwd },
      { key: "Model", value: input.model },
      { key: "Provider", value: input.provider },
      { key: "Config files", value: input.configFiles.length },
      { key: "Checks", value: `${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail` }
    ]),
    ...input.configFiles.map((file) => `  config ${file}`),
    ...input.checks.map((check) => `  ${check.status.toUpperCase().padEnd(4, " ")} ${check.name}: ${check.message}`)
  ];
  return `${lines.join("\n")}\n`;
}

function renderInitStatus(status: "created" | "updated" | "skipped"): string {
  if (status === "skipped") {
    return "skipped (already exists)";
  }
  return status;
}

export function renderSandboxStatusView(status: SandboxStatus): string {
  const rows = renderKeyValueRows([
    { key: "Enabled", value: status.enabled },
    { key: "Active", value: status.active },
    { key: "Supported", value: status.supported },
    { key: "Namespace", value: `${status.namespaceActive ? "active" : "inactive"} / supported=${status.namespaceSupported}` },
    { key: "Network", value: `${status.networkActive ? "active" : "inactive"} / supported=${status.networkSupported}` },
    { key: "Filesystem", value: `${status.filesystemMode} / active=${status.filesystemActive}` },
    { key: "Container", value: status.inContainer },
    { key: "Mounts", value: status.allowedMounts.join(", ") || "<none>" },
    { key: "Fallback", value: status.fallbackReason }
  ]);
  const markers = status.containerMarkers.map((marker) => `  marker ${marker}`);
  return `${[emphasize("Sandbox"), ...rows, ...markers].join("\n")}\n`;
}

export function renderLoginBootstrapView(input: {
  authorizeUrl: string;
  callbackPort: number;
  redirectUri: string;
  credentialsPath: string;
  configSource: string;
  manualRedirectUrl?: string;
}): string {
  return `${renderSection("Login", [
    { key: "Authorize URL", value: input.authorizeUrl },
    { key: "Redirect URI", value: input.redirectUri },
    { key: "Callback port", value: input.callbackPort },
    { key: "Config source", value: input.configSource },
    { key: "Manual redirect", value: input.manualRedirectUrl },
    { key: "Credentials", value: input.credentialsPath }
  ])}\n`;
}

export function renderLogoutView(credentialsFile: string): string {
  return `${renderSection("Logout", [
    { key: "Credentials", value: credentialsFile },
    { key: "Result", value: "Claude OAuth credentials cleared" }
  ])}\n`;
}

export function renderHelpView(): string {
  return `${emphasize("Interactive slash commands:")}\n${renderSlashCommandHelp()}\n`;
}

export function renderConfigView(
  loadedFiles: string[],
  section: string | undefined,
  mergedValue: unknown,
  diagnostics: {
    loadDiagnostics?: ConfigLoadDiagnostic[];
    validation?: Record<string, ConfigValidationResult>;
  } = {}
): string {
  const lines = ["Config", `  Loaded files      ${loadedFiles.length}`, ...loadedFiles.map((file) => `  ${file}`)];
  const diagnosticLines = renderRuntimeConfigDiagnostics(diagnostics);
  if (diagnosticLines.length > 0) {
    lines.push("  Diagnostics");
    lines.push(...diagnosticLines.map((line) => `  ${line}`));
  }
  if (section) {
    lines.push(`  Merged section: ${section}`);
    const rendered = mergedValue === undefined
      ? "<undefined>"
      : typeof mergedValue === "string"
        ? mergedValue
        : JSON.stringify(mergedValue, null, 2);
    lines.push(...rendered.split("\n").map((line) => `  ${line}`));
  }
  return `${lines.join("\n")}\n`;
}

function renderRuntimeConfigDiagnostics(diagnostics: {
  loadDiagnostics?: ConfigLoadDiagnostic[];
  validation?: Record<string, ConfigValidationResult>;
}): string[] {
  const lines: string[] = [];
  for (const diagnostic of diagnostics.loadDiagnostics ?? []) {
    lines.push(`error: ${diagnostic.path}: ${diagnostic.kind}: ${diagnostic.message}`);
  }
  for (const [file, result] of Object.entries(diagnostics.validation ?? {})) {
    for (const warning of result.warnings) {
      lines.push(`warning: ${file}: ${warning.field}`);
    }
    for (const error of result.errors) {
      lines.push(`error: ${file}: ${error.field}`);
    }
  }
  return lines;
}

export function renderCompactView(removedMessageCount: number, summaryPreview?: string): string {
  return `${renderSection("Compact", [
    { key: "removed messages", value: removedMessageCount },
    { key: "summary preview", value: summaryPreview }
  ])}\n`;
}

export function renderSessionsView(sessionPaths: string[]): string {
  return `${[renderSection("Sessions", [{ key: "count", value: sessionPaths.length }]), ...sessionPaths.map((file) => `  ${file}`)].join("\n")}\n`;
}

export function renderPromptHistoryView(entries: string[], limit: number): string {
  if (entries.length === 0) {
    return `${renderSection("Prompt history", [{ key: "result", value: "no prompts recorded yet" }])}\n`;
  }
  const shown = entries.slice(-limit);
  const lines = [
    renderSection("Prompt history", [
      { key: "count", value: entries.length },
      { key: "showing", value: shown.length }
    ]),
    ...shown.map((entry, index) => `  ${String(index + 1).padStart(2, " ")}  ${entry.replace(/\n/g, "\\n")}`)
  ];
  return `${lines.join("\n")}\n`;
}

export function renderResumeUsageView(): string {
  return `${renderSection("Resume", [
    { key: "Usage", value: "/resume <session-path|session-id|latest>" },
    { key: "Auto-save", value: ".clench/sessions/<session-id>.jsonl" },
    { key: "Tip", value: "use /session list to inspect saved sessions" }
  ])}\n`;
}

export function renderSessionChangeView(input: {
  action: "switched" | "forked" | "resumed" | "deleted";
  path: string;
  messages?: number;
  branch?: string;
}): string {
  return `${renderSection("Session", [
    { key: input.action, value: input.path },
    { key: "messages", value: input.messages },
    { key: "branch", value: input.branch }
  ])}\n`;
}

export function renderMcpListView(states: McpServerState[]): string {
  const lines = [renderSection("MCP", [{ key: "servers", value: states.length }])];
  for (const state of states) {
    const bits = [
      `${state.serverName} status=${state.status}`,
      state.serverInfo ? `info=${state.serverInfo}` : undefined,
      state.runtimeSession ? `session=${state.runtimeSession.connection}` : undefined,
      state.runtimeSession ? `reconnects=${state.runtimeSession.reconnectCount}` : undefined,
      state.errorMessage ? `error=${state.errorMessage}` : undefined,
      state.runtimeSession?.lastError ? `session_error=${state.runtimeSession.lastError}` : undefined
    ].filter(Boolean);
    lines.push(`  ${bits.join(" ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderMcpHelpView(): string {
  return `${renderSection("MCP", [])}\n  Use /mcp list to view configured servers.\n  Use /mcp show <server> to print one configured server.\n`;
}

export function renderMcpServerView(
  serverName: string,
  state: McpServerState,
  config: McpServerConfig
): string {
  const rows = renderKeyValueRows([
    { key: "server", value: serverName },
    { key: "status", value: state.status },
    { key: "info", value: state.serverInfo ?? "" },
    { key: "error", value: state.errorMessage },
    { key: "session", value: state.runtimeSession?.connection },
    { key: "reconnects", value: state.runtimeSession?.reconnectCount },
    { key: "pending requests", value: state.runtimeSession?.pendingRequestCount },
    { key: "buffered events", value: state.runtimeSession?.bufferedMessageCount },
    { key: "session error", value: state.runtimeSession?.lastError },
    { key: "config", value: JSON.stringify(config) }
  ]);
  return `${[emphasize("MCP"), ...rows].join("\n")}\n`;
}

export function renderPluginListView(
  plugins: Record<string, { enabled?: boolean; health?: string; version?: string; toolCount?: number }>
): string {
  const lines = [renderSection("Plugins", [{ key: "count", value: Object.keys(plugins).length }])];
  for (const [name, state] of Object.entries(plugins)) {
    lines.push(
      `  ${name} enabled=${state.enabled ? "true" : "false"} health=${state.health ?? "unconfigured"} version=${state.version ?? "unknown"} tools=${state.toolCount ?? 0}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderPluginActionView(title: string, entries: Array<{ key: string; value: string | number | boolean | undefined }>): string {
  return `${renderSection(title, entries)}\n`;
}

export function renderExportView(exportPath: string): string {
  return `Export\n  wrote transcript  ${exportPath}\n`;
}

export function renderClearSessionView(input: {
  mode: string;
  previousSession: string;
  resumePrevious: string;
  backupPath: string;
  sessionFile: string;
}): string {
  return `${emphasize("Session cleared")}\n${renderKeyValueRows([
    { key: "Mode", value: input.mode },
    { key: "Previous session", value: input.previousSession },
    { key: "Resume previous", value: input.resumePrevious },
    { key: "Backup", value: input.backupPath },
    { key: "Session file", value: input.sessionFile }
  ]).join("\n")}\n`;
}

export function renderRuntimeSessionLine(serverName: string, session: RemoteMcpSseRuntimeState): string {
  return `${serverName} session=${session.connection} reconnects=${session.reconnectCount}`;
}

function summarizeToolInput(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [dim("no input")];
  }
  try {
    return summarizeTextBlock(JSON.stringify(JSON.parse(trimmed), null, 2), {
      maxLines: 8,
      maxCharsPerLine: 100
    });
  } catch {
    return summarizeTextBlock(trimmed, { maxLines: 8, maxCharsPerLine: 100 });
  }
}

function summarizeToolCall(toolName: string, input: string): string[] {
  const canonicalName = canonicalToolName(toolName);
  const parsed = parseJsonRecord(input);
  if (canonicalName === "bash") {
    return parsed?.command
      ? [dim("command"), String(parsed.command), ...optionalLine("timeout", parsed.timeout ?? parsed.timeout_ms)]
      : summarizeToolInput(input);
  }
  if (canonicalName === "read_file" || canonicalName === "write_file") {
    return parsed?.path
      ? [dim("path"), String(parsed.path)]
      : summarizeToolInput(input);
  }
  if (canonicalName === "grep_search") {
    return [
      ...optionalPair("pattern", parsed?.pattern),
      ...optionalPair("path", parsed?.path),
      ...fallbackSummary(parsed, input)
    ];
  }
  if (canonicalName === "glob_search") {
    return [
      ...optionalPair("glob", parsed?.glob_pattern ?? parsed?.pattern),
      ...optionalPair("path", parsed?.path),
      ...fallbackSummary(parsed, input)
    ];
  }
  return summarizeToolInput(input);
}

function summarizeToolResult(toolName: string, output: string, isError: boolean): string[] {
  const canonicalName = canonicalToolName(toolName);
  const parsed = parseJsonRecord(output);
  if (canonicalName === "bash" && parsed) {
    const lines: string[] = [];
    if (parsed.returnCodeInterpretation) {
      lines.push(`exit ${String(parsed.returnCodeInterpretation)}`);
    }
    if (parsed.backgroundTaskId) {
      lines.push(`background task ${String(parsed.backgroundTaskId)}`);
    }
    if (parsed.stdout) {
      lines.push(dim("stdout"));
      lines.push(...summarizeTextBlock(renderMarkdown(String(parsed.stdout)), { maxLines: 10, maxCharsPerLine: 120 }));
    }
    if (parsed.stderr) {
      lines.push(dim("stderr"));
      lines.push(...summarizeTextBlock(renderMarkdown(String(parsed.stderr)), { maxLines: 10, maxCharsPerLine: 120 }));
    }
    if (lines.length > 0) {
      return lines;
    }
  }
  if ((canonicalName === "grep_search" || canonicalName === "glob_search") && parsed) {
    const counts = [
      ...optionalPair("matches", parsed.num_matches ?? parsed.match_count ?? parsed.total_matches),
      ...optionalPair("files", parsed.num_files ?? parsed.file_count)
    ];
    const resultLines =
      canonicalName === "grep_search"
        ? summarizeGrepMatches(parsed.matches)
        : summarizeGlobMatches(parsed.matches);
    if (counts.length > 0 || resultLines.length > 0) {
      return [...counts, ...resultLines];
    }
  }
  if ((canonicalName === "read_file" || canonicalName === "write_file") && parsed) {
    const lines = [...optionalPair("path", parsed.path)];
    if (parsed.content) {
      lines.push(...summarizeTextBlock(renderMarkdown(String(parsed.content)), { maxLines: 10, maxCharsPerLine: 120 }));
    }
    if (lines.length > 0) {
      return lines;
    }
  }
  if ((canonicalName === "read_file" || canonicalName === "write_file") && output.trim()) {
    return [dim("path"), output.trim()];
  }
  return summarizeTextBlock(renderMarkdown(output), { maxLines: 12, maxCharsPerLine: 120 });
}

function summarizeGlobMatches(matches: unknown): string[] {
  if (!Array.isArray(matches) || matches.length === 0) {
    return [];
  }
  return [
    dim("matched paths"),
    ...summarizeTextBlock(matches.slice(0, 10).map((match) => String(match)).join("\n"), {
      maxLines: 10,
      maxCharsPerLine: 120
    })
  ];
}

function summarizeGrepMatches(matches: unknown): string[] {
  if (!Array.isArray(matches) || matches.length === 0) {
    return [];
  }
  const lines = matches.slice(0, 10).map((match) => {
    if (!match || typeof match !== "object") {
      return String(match);
    }
    const record = match as Record<string, unknown>;
    const location = [record.path, record.line_number ?? record.line].filter((value) => value !== undefined && value !== null).join(":");
    const text = record.text ?? record.line ?? record.match ?? "";
    return location ? `${location}: ${String(text)}` : String(text);
  });
  return [
    dim("matched lines"),
    ...summarizeTextBlock(lines.join("\n"), {
      maxLines: 10,
      maxCharsPerLine: 120
    })
  ];
}

function parseJsonRecord(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function optionalPair(label: string, value: unknown): string[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return [dim(label), String(value)];
}

function optionalLine(label: string, value: unknown): string[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return [`${dim(label)} ${String(value)}`];
}

function fallbackSummary(parsed: Record<string, unknown> | undefined, input: string): string[] {
  return parsed ? [] : summarizeToolInput(input);
}
