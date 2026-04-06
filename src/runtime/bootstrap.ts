export type BootstrapPhase =
  | "cli_entry"
  | "fast_path_version"
  | "startup_profiler"
  | "system_prompt_fast_path"
  | "chrome_mcp_fast_path"
  | "daemon_worker_fast_path"
  | "bridge_fast_path"
  | "daemon_fast_path"
  | "background_session_fast_path"
  | "template_fast_path"
  | "environment_runner_fast_path"
  | "main_runtime";

const DEFAULT_BOOTSTRAP_PHASES: BootstrapPhase[] = [
  "cli_entry",
  "fast_path_version",
  "startup_profiler",
  "system_prompt_fast_path",
  "chrome_mcp_fast_path",
  "daemon_worker_fast_path",
  "bridge_fast_path",
  "daemon_fast_path",
  "background_session_fast_path",
  "template_fast_path",
  "environment_runner_fast_path",
  "main_runtime"
];

export class BootstrapPlan {
  constructor(private readonly orderedPhases: BootstrapPhase[]) {}

  static claudeCodeDefault(): BootstrapPlan {
    return BootstrapPlan.fromPhases(DEFAULT_BOOTSTRAP_PHASES);
  }

  static fromPhases(phases: BootstrapPhase[]): BootstrapPlan {
    const deduped: BootstrapPhase[] = [];
    for (const phase of phases) {
      if (!deduped.includes(phase)) {
        deduped.push(phase);
      }
    }
    return new BootstrapPlan(deduped);
  }

  phases(): BootstrapPhase[] {
    return [...this.orderedPhases];
  }
}
