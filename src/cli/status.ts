import { UsageTracker, Session } from "../runtime/index.js";
import { summarizeMcpStatus } from "./admin";
import { loadPromptHistory, parsePromptHistoryLimit } from "./history";
import type { SessionInfo } from "./session";
import {
  renderCostView,
  renderPromptHistoryView,
  renderStatusView
} from "./views";

const PERMISSION_SLASH_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

export interface StatusCliState {
  cwd: string;
  model: string;
  permissionMode: string;
  outputFormat: string | undefined;
  allowedTools: string | undefined;
}

export function printStatus(
  cli: StatusCliState,
  sessionInfo: SessionInfo | undefined
): void {
  const mcpSummary = summarizeMcpStatus(cli.cwd);
  process.stdout.write(
    renderStatusView({
      model: cli.model,
      permissionMode: cli.permissionMode,
      outputFormat: cli.outputFormat,
      allowedTools: cli.allowedTools,
      sessionPath: sessionInfo?.path,
      messageCount: sessionInfo?.messages.length,
      mcpSummary
    })
  );
}

export function applyPermissionsSlash(cli: { permissionMode: string }, args: string[]): void {
  if (args.length === 0) {
    process.stdout.write(`Permission mode  ${cli.permissionMode}\n`);
    return;
  }
  const mode = args[0]!;
  if (!(PERMISSION_SLASH_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `Unsupported /permissions mode '${mode ?? ""}'. Use read-only, workspace-write, or danger-full-access.`
    );
  }
  if (args.length > 1) {
    throw new Error(
      "Unexpected arguments for /permissions.\n  Usage            /permissions [read-only|workspace-write|danger-full-access]"
    );
  }
  cli.permissionMode = mode;
}

export function printPromptHistory(cwd: string, sessionPath: string | undefined, count: number | undefined): void {
  process.stdout.write(
    renderPromptHistoryView(
      loadPromptHistory(cwd, sessionPath),
      parsePromptHistoryLimit(count)
    )
  );
}

export function printCost(model: string, sessionInfo: SessionInfo | undefined): void {
  process.stdout.write(renderCostView(readCostReport(model, sessionInfo)));
}

function readCostReport(
  model: string,
  sessionInfo: SessionInfo | undefined
): {
  model: string;
  turns: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
} {
  const tracker = sessionInfo
    ? UsageTracker.fromSession(Session.loadFromPath(sessionInfo.path))
    : new UsageTracker();
  return {
    model,
    turns: tracker.turns(),
    usage: tracker.cumulativeUsage()
  };
}
