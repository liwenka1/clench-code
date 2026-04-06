export const FailureScenario = {
  TrustPromptUnresolved: "trust_prompt_unresolved",
  PromptMisdelivery: "prompt_misdelivery",
  StaleBranch: "stale_branch",
  CompileRedCrossCrate: "compile_red_cross_crate",
  McpHandshakeFailure: "mcp_handshake_failure",
  PartialPluginStartup: "partial_plugin_startup",
  ProviderFailure: "provider_failure"
} as const;

export const RecoveryStep = {
  AcceptTrustPrompt: "accept_trust_prompt",
  RedirectPromptToAgent: "redirect_prompt_to_agent",
  RebaseBranch: "rebase_branch",
  CleanBuild: "clean_build",
  RestartWorker: "restart_worker"
} as const;

export const EscalationPolicy = {
  AlertHuman: "alert_human",
  LogAndContinue: "log_and_continue",
  Abort: "abort"
} as const;

export const WorkerFailureKind = {
  TrustGate: "trust_gate",
  PromptDelivery: "prompt_delivery",
  Protocol: "protocol",
  Provider: "provider"
} as const;

export type FailureScenarioValue = (typeof FailureScenario)[keyof typeof FailureScenario];
export type RecoveryStepValue = (typeof RecoveryStep)[keyof typeof RecoveryStep];
export type EscalationPolicyValue = (typeof EscalationPolicy)[keyof typeof EscalationPolicy];
export type WorkerFailureKindValue = (typeof WorkerFailureKind)[keyof typeof WorkerFailureKind];

export type RecoveryStepDescriptor =
  | RecoveryStepValue
  | { type: "retry_mcp_handshake"; timeout: number }
  | { type: "restart_plugin"; name: string }
  | { type: "escalate_to_human"; reason: string };

export interface RecoveryRecipe {
  scenario: FailureScenarioValue;
  steps: RecoveryStepDescriptor[];
  maxAttempts: number;
  escalationPolicy: EscalationPolicyValue;
}

export type RecoveryResult =
  | { type: "recovered"; stepsTaken: number }
  | { type: "partial_recovery"; recovered: RecoveryStepDescriptor[]; remaining: RecoveryStepDescriptor[] }
  | { type: "escalation_required"; reason: string };

export type RecoveryEvent =
  | { type: "recovery_attempted"; scenario: FailureScenarioValue; recipe: RecoveryRecipe; result: RecoveryResult }
  | { type: "recovery_succeeded" }
  | { type: "recovery_failed" }
  | { type: "escalated" };

export class RecoveryContext {
  private attempts = new Map<FailureScenarioValue, number>();
  private eventLog: RecoveryEvent[] = [];

  constructor(private readonly failAtStep?: number) {}

  events(): RecoveryEvent[] {
    return [...this.eventLog];
  }

  attemptCount(scenario: FailureScenarioValue): number {
    return this.attempts.get(scenario) ?? 0;
  }

  recordAttempt(event: RecoveryEvent): void {
    this.eventLog.push(event);
  }

  recordTerminal(event: RecoveryEvent): void {
    this.eventLog.push(event);
  }

  shouldFailAt(stepIndex: number): boolean {
    return this.failAtStep === stepIndex;
  }

  incrementAttempts(scenario: FailureScenarioValue): number {
    const next = (this.attempts.get(scenario) ?? 0) + 1;
    this.attempts.set(scenario, next);
    return next;
  }
}

export function allFailureScenarios(): FailureScenarioValue[] {
  return Object.values(FailureScenario);
}

export function failureScenarioFromWorkerFailureKind(kind: WorkerFailureKindValue): FailureScenarioValue {
  if (kind === WorkerFailureKind.TrustGate) {
    return FailureScenario.TrustPromptUnresolved;
  }
  if (kind === WorkerFailureKind.PromptDelivery) {
    return FailureScenario.PromptMisdelivery;
  }
  if (kind === WorkerFailureKind.Protocol) {
    return FailureScenario.McpHandshakeFailure;
  }
  return FailureScenario.ProviderFailure;
}

export function recipeFor(scenario: FailureScenarioValue): RecoveryRecipe {
  switch (scenario) {
    case FailureScenario.TrustPromptUnresolved:
      return {
        scenario,
        steps: [RecoveryStep.AcceptTrustPrompt],
        maxAttempts: 1,
        escalationPolicy: EscalationPolicy.AlertHuman
      };
    case FailureScenario.PromptMisdelivery:
      return {
        scenario,
        steps: [RecoveryStep.RedirectPromptToAgent],
        maxAttempts: 1,
        escalationPolicy: EscalationPolicy.AlertHuman
      };
    case FailureScenario.StaleBranch:
      return {
        scenario,
        steps: [RecoveryStep.RebaseBranch, RecoveryStep.CleanBuild],
        maxAttempts: 1,
        escalationPolicy: EscalationPolicy.AlertHuman
      };
    case FailureScenario.CompileRedCrossCrate:
      return {
        scenario,
        steps: [RecoveryStep.CleanBuild],
        maxAttempts: 1,
        escalationPolicy: EscalationPolicy.AlertHuman
      };
    case FailureScenario.McpHandshakeFailure:
      return {
        scenario,
        steps: [{ type: "retry_mcp_handshake", timeout: 5000 }],
        maxAttempts: 1,
        escalationPolicy: EscalationPolicy.Abort
      };
    case FailureScenario.PartialPluginStartup:
      return {
        scenario,
        steps: [{ type: "restart_plugin", name: "stalled" }, { type: "retry_mcp_handshake", timeout: 3000 }],
        maxAttempts: 1,
        escalationPolicy: EscalationPolicy.LogAndContinue
      };
    case FailureScenario.ProviderFailure:
      return {
        scenario,
        steps: [RecoveryStep.RestartWorker],
        maxAttempts: 1,
        escalationPolicy: EscalationPolicy.AlertHuman
      };
  }
}

export function attemptRecovery(
  scenario: FailureScenarioValue,
  context: RecoveryContext
): RecoveryResult {
  const recipe = recipeFor(scenario);
  if (context.attemptCount(scenario) >= recipe.maxAttempts) {
    const result: RecoveryResult = {
      type: "escalation_required",
      reason: `max recovery attempts (${recipe.maxAttempts}) exceeded for ${scenario}`
    };
    context.recordAttempt({ type: "recovery_attempted", scenario, recipe, result });
    context.recordTerminal({ type: "escalated" });
    return result;
  }

  context.incrementAttempts(scenario);
  const recovered: RecoveryStepDescriptor[] = [];
  let failed = false;

  for (const [index, step] of recipe.steps.entries()) {
    if (context.shouldFailAt(index)) {
      failed = true;
      break;
    }
    recovered.push(step);
  }

  let result: RecoveryResult;
  if (!failed) {
    result = { type: "recovered", stepsTaken: recipe.steps.length };
  } else if (recovered.length === 0) {
    result = { type: "escalation_required", reason: `recovery failed at first step for ${scenario}` };
  } else {
    result = {
      type: "partial_recovery",
      recovered,
      remaining: recipe.steps.slice(recovered.length)
    };
  }

  context.recordAttempt({ type: "recovery_attempted", scenario, recipe, result });
  if (result.type === "recovered") {
    context.recordTerminal({ type: "recovery_succeeded" });
  } else if (result.type === "partial_recovery") {
    context.recordTerminal({ type: "recovery_failed" });
  } else {
    context.recordTerminal({ type: "escalated" });
  }
  return result;
}
