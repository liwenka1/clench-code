export type McpLifecyclePhase =
  | "config_load"
  | "server_registration"
  | "spawn_connect"
  | "initialize_handshake"
  | "tool_discovery"
  | "resource_discovery"
  | "ready"
  | "invocation"
  | "error_surfacing"
  | "shutdown"
  | "cleanup";

export interface McpErrorSurface {
  phase: McpLifecyclePhase;
  serverName?: string;
  message: string;
  context: Record<string, string>;
  recoverable: boolean;
  timestamp: number;
}

export type McpPhaseResult =
  | { type: "success"; phase: McpLifecyclePhase; durationMs: number }
  | { type: "failure"; phase: McpLifecyclePhase; error: McpErrorSurface }
  | { type: "timeout"; phase: McpLifecyclePhase; waitedMs: number; error: McpErrorSurface };

export interface McpFailedServer {
  serverName: string;
  phase: McpLifecyclePhase;
  error: McpErrorSurface;
}

export interface McpDegradedReport {
  workingServers: string[];
  failedServers: McpFailedServer[];
  availableTools: string[];
  missingTools: string[];
}

const ALL_PHASES: McpLifecyclePhase[] = [
  "config_load",
  "server_registration",
  "spawn_connect",
  "initialize_handshake",
  "tool_discovery",
  "resource_discovery",
  "ready",
  "invocation",
  "error_surfacing",
  "shutdown",
  "cleanup"
];

export function allMcpLifecyclePhases(): McpLifecyclePhase[] {
  return [...ALL_PHASES];
}

export function mcpErrorSurface(
  phase: McpLifecyclePhase,
  message: string,
  options: {
    serverName?: string;
    context?: Record<string, string>;
    recoverable?: boolean;
  } = {}
): McpErrorSurface {
  return {
    phase,
    serverName: options.serverName,
    message,
    context: options.context ?? {},
    recoverable: options.recoverable ?? false,
    timestamp: Math.floor(Date.now() / 1000)
  };
}

export function formatMcpErrorSurface(error: McpErrorSurface): string {
  const server = error.serverName ? ` (server: ${error.serverName})` : "";
  const context = Object.keys(error.context).length > 0 ? ` with context ${JSON.stringify(error.context)}` : "";
  const recoverable = error.recoverable ? " [recoverable]" : "";
  return `MCP lifecycle error during ${error.phase}: ${error.message}${server}${context}${recoverable}`;
}

export class McpLifecycleState {
  currentPhase?: McpLifecyclePhase;
  readonly phaseErrors = new Map<McpLifecyclePhase, McpErrorSurface[]>();
  readonly phaseTimestamps = new Map<McpLifecyclePhase, number>();
  readonly phaseResults: McpPhaseResult[] = [];

  errorsForPhase(phase: McpLifecyclePhase): McpErrorSurface[] {
    return [...(this.phaseErrors.get(phase) ?? [])];
  }

  phaseTimestamp(phase: McpLifecyclePhase): number | undefined {
    return this.phaseTimestamps.get(phase);
  }
}

export class McpLifecycleValidator {
  readonly state = new McpLifecycleState();

  static validatePhaseTransition(from: McpLifecyclePhase, to: McpLifecyclePhase): boolean {
    const valid = new Set([
      "config_load->server_registration",
      "server_registration->spawn_connect",
      "spawn_connect->initialize_handshake",
      "initialize_handshake->tool_discovery",
      "tool_discovery->resource_discovery",
      "tool_discovery->ready",
      "resource_discovery->ready",
      "ready->invocation",
      "invocation->ready",
      "error_surfacing->ready",
      "error_surfacing->shutdown",
      "shutdown->cleanup"
    ]);
    return (
      valid.has(`${from}->${to}`) ||
      (to === "shutdown" && from !== "cleanup") ||
      (to === "error_surfacing" && from !== "cleanup" && from !== "shutdown")
    );
  }

  runPhase(phase: McpLifecyclePhase): McpPhaseResult {
    if (this.state.currentPhase) {
      if (
        this.state.currentPhase === "error_surfacing" &&
        phase === "ready" &&
        !this.canResumeAfterError()
      ) {
        return this.recordFailure(
          mcpErrorSurface("ready", "cannot return to ready after a non-recoverable MCP lifecycle failure", {
            context: { from: this.state.currentPhase, to: phase }
          })
        );
      }

      if (!McpLifecycleValidator.validatePhaseTransition(this.state.currentPhase, phase)) {
        return this.recordFailure(
          mcpErrorSurface(phase, `invalid MCP lifecycle transition from ${this.state.currentPhase} to ${phase}`, {
            context: { from: this.state.currentPhase, to: phase }
          })
        );
      }
    } else if (phase !== "config_load") {
      return this.recordFailure(
        mcpErrorSurface(phase, `invalid initial MCP lifecycle phase ${phase}`, {
          context: { phase }
        })
      );
    }

    this.recordPhase(phase);
    const result: McpPhaseResult = { type: "success", phase, durationMs: 0 };
    this.state.phaseResults.push(result);
    return result;
  }

  recordFailure(error: McpErrorSurface): McpPhaseResult {
    this.recordError(error);
    this.recordPhase("error_surfacing");
    const result: McpPhaseResult = { type: "failure", phase: error.phase, error };
    this.state.phaseResults.push(result);
    return result;
  }

  recordTimeout(
    phase: McpLifecyclePhase,
    waitedMs: number,
    serverName?: string,
    context: Record<string, string> = {}
  ): McpPhaseResult {
    const error = mcpErrorSurface(phase, `MCP lifecycle phase ${phase} timed out after ${waitedMs} ms`, {
      serverName,
      context: { ...context, waited_ms: String(waitedMs) },
      recoverable: true
    });
    this.recordError(error);
    this.recordPhase("error_surfacing");
    const result: McpPhaseResult = { type: "timeout", phase, waitedMs, error };
    this.state.phaseResults.push(result);
    return result;
  }

  private recordPhase(phase: McpLifecyclePhase): void {
    this.state.currentPhase = phase;
    this.state.phaseTimestamps.set(phase, Math.floor(Date.now() / 1000));
  }

  private recordError(error: McpErrorSurface): void {
    const errors = this.state.phaseErrors.get(error.phase) ?? [];
    errors.push(error);
    this.state.phaseErrors.set(error.phase, errors);
  }

  private canResumeAfterError(): boolean {
    const last = this.state.phaseResults.at(-1);
    if (!last) {
      return false;
    }
    if (last.type === "failure" || last.type === "timeout") {
      return last.error.recoverable;
    }
    return false;
  }
}

export function mcpDegradedReport(
  workingServers: string[],
  failedServers: McpFailedServer[],
  availableTools: string[],
  expectedTools: string[]
): McpDegradedReport {
  const dedupedWorking = [...new Set(workingServers)].sort();
  const dedupedAvailable = [...new Set(availableTools)].sort();
  const availableSet = new Set(dedupedAvailable);
  const missingTools = [...new Set(expectedTools)].sort().filter((tool) => !availableSet.has(tool));
  return {
    workingServers: dedupedWorking,
    failedServers,
    availableTools: dedupedAvailable,
    missingTools
  };
}
