export interface HookContext {
  toolName: string;
  input: string;
}

export type HookResult =
  | { type: "allow"; message?: string }
  | { type: "deny"; reason: string };

export type RuntimeHook = (context: HookContext) => HookResult | Promise<HookResult>;

export interface HookRunSummary {
  allowed: boolean;
  blockedBy?: string;
  feedback: string[];
}

export async function runHooks(
  hooks: RuntimeHook[],
  context: HookContext
): Promise<HookRunSummary> {
  const feedback: string[] = [];

  for (const hook of hooks) {
    const result = await hook(context);
    if (result.type === "allow") {
      if (result.message) {
        feedback.push(result.message);
      }
      continue;
    }

    feedback.push(result.reason);
    return {
      allowed: false,
      blockedBy: result.reason,
      feedback
    };
  }

  return {
    allowed: true,
    feedback
  };
}
