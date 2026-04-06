import { describe, expect, test } from "vitest";

import {
  EscalationPolicy,
  FailureScenario,
  RecoveryContext,
  RecoveryStep,
  WorkerFailureKind,
  allFailureScenarios,
  attemptRecovery,
  failureScenarioFromWorkerFailureKind,
  recipeFor
} from "../../src/runtime/recovery-recipes.js";

describe("runtime recovery recipes", () => {
  test("ports recovery recipe behavior", async () => {
    for (const scenario of allFailureScenarios()) {
      const recipe = recipeFor(scenario);
      expect(recipe.scenario).toBe(scenario);
      expect(recipe.steps.length).toBeGreaterThan(0);
      expect(recipe.maxAttempts).toBeGreaterThanOrEqual(1);
    }

    const successContext = new RecoveryContext();
    expect(attemptRecovery(FailureScenario.TrustPromptUnresolved, successContext)).toEqual({
      type: "recovered",
      stepsTaken: 1
    });
    expect(successContext.events()).toHaveLength(2);
    expect(successContext.events()[1]).toEqual({ type: "recovery_succeeded" });

    const retryContext = new RecoveryContext();
    expect(attemptRecovery(FailureScenario.PromptMisdelivery, retryContext).type).toBe("recovered");
    const escalated = attemptRecovery(FailureScenario.PromptMisdelivery, retryContext);
    expect(escalated.type).toBe("escalation_required");
    expect(retryContext.attemptCount(FailureScenario.PromptMisdelivery)).toBe(1);
    expect(retryContext.events().some((event) => event.type === "escalated")).toBe(true);

    const partialContext = new RecoveryContext(1);
    const partial = attemptRecovery(FailureScenario.PartialPluginStartup, partialContext);
    expect(partial).toEqual({
      type: "partial_recovery",
      recovered: [{ type: "restart_plugin", name: "stalled" }],
      remaining: [{ type: "retry_mcp_handshake", timeout: 3000 }]
    });

    const firstStepFailureContext = new RecoveryContext(0);
    expect(attemptRecovery(FailureScenario.CompileRedCrossCrate, firstStepFailureContext)).toEqual({
      type: "escalation_required",
      reason: "recovery failed at first step for compile_red_cross_crate"
    });

    expect(recipeFor(FailureScenario.StaleBranch).steps).toEqual([
      RecoveryStep.RebaseBranch,
      RecoveryStep.CleanBuild
    ]);
    expect(recipeFor(FailureScenario.McpHandshakeFailure).escalationPolicy).toBe(EscalationPolicy.Abort);
    expect(recipeFor(FailureScenario.ProviderFailure).steps).toContain(RecoveryStep.RestartWorker);
    expect(failureScenarioFromWorkerFailureKind(WorkerFailureKind.TrustGate)).toBe(
      FailureScenario.TrustPromptUnresolved
    );
    expect(failureScenarioFromWorkerFailureKind(WorkerFailureKind.Protocol)).toBe(
      FailureScenario.McpHandshakeFailure
    );
  });
});
