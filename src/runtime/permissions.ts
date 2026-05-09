export type PermissionMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
  | "prompt"
  | "allow";

export type PermissionOverride = "allow" | "deny" | "ask";

export interface PermissionRequest {
  toolName: string;
  input: string;
  currentMode: PermissionMode;
  requiredMode: PermissionMode;
  reason?: string;
}

export type PermissionPromptDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string };

export interface PermissionPrompter {
  decide(request: PermissionRequest): PermissionPromptDecision;
}

export type PermissionOutcome =
  | { type: "allow" }
  | { type: "deny"; reason: string };

export interface PermissionContext {
  overrideDecision?: PermissionOverride;
  overrideReason?: string;
}

export class PermissionPolicy {
  private readonly toolRequirements: Map<string, PermissionMode>;
  private readonly allowRules: PermissionRule[];
  private readonly denyRules: PermissionRule[];
  private readonly askRules: PermissionRule[];

  constructor(
    readonly mode: PermissionMode,
    state: {
      toolRequirements?: Map<string, PermissionMode>;
      allowRules?: PermissionRule[];
      denyRules?: PermissionRule[];
      askRules?: PermissionRule[];
    } = {}
  ) {
    this.toolRequirements = state.toolRequirements ?? new Map();
    this.allowRules = state.allowRules ?? [];
    this.denyRules = state.denyRules ?? [];
    this.askRules = state.askRules ?? [];
  }

  withToolRequirement(toolName: string, requiredMode: PermissionMode): PermissionPolicy {
    const next = this.clone();
    next.toolRequirements.set(toolName, requiredMode);
    return next;
  }

  withRules(config: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  }): PermissionPolicy {
    const next = this.clone();
    next.allowRules.push(...(config.allow ?? []).map(parsePermissionRule));
    next.denyRules.push(...(config.deny ?? []).map(parsePermissionRule));
    next.askRules.push(...(config.ask ?? []).map(parsePermissionRule));
    return next;
  }

  authorize(
    toolName: string,
    input: string,
    prompter?: PermissionPrompter
  ): PermissionOutcome {
    return this.authorizeWithContext(toolName, input, {}, prompter);
  }

  authorizeWithContext(
    toolName: string,
    input: string,
    context: PermissionContext,
    prompter?: PermissionPrompter
  ): PermissionOutcome {
    const currentMode = this.mode;
    const requiredMode = this.requiredModeFor(toolName);

    const denyRule = this.findMatchingRule(this.denyRules, toolName, input);
    if (denyRule) {
      return {
        type: "deny",
        reason: `Permission to use ${toolName} has been denied by rule '${denyRule.raw}'`
      };
    }

    if (context.overrideDecision === "deny") {
      return {
        type: "deny",
        reason: context.overrideReason ?? `tool '${toolName}' denied by hook`
      };
    }

    const askRule = this.findMatchingRule(this.askRules, toolName, input);
    const allowRule = this.findMatchingRule(this.allowRules, toolName, input);

    if (context.overrideDecision === "ask") {
      return this.promptOrDeny(
        toolName,
        input,
        currentMode,
        requiredMode,
        context.overrideReason ?? `tool '${toolName}' requires approval due to hook guidance`,
        prompter
      );
    }

    if (askRule) {
      return this.promptOrDeny(
        toolName,
        input,
        currentMode,
        requiredMode,
        `tool '${toolName}' requires approval due to ask rule '${askRule.raw}'`,
        prompter
      );
    }

    const modeAllows =
      currentMode === "allow" ||
      currentMode === requiredMode ||
      permissionRank(currentMode) >= permissionRank(requiredMode);

    if (context.overrideDecision === "allow" && modeAllows) {
      return { type: "allow" };
    }

    if (allowRule || modeAllows) {
      return { type: "allow" };
    }

    if (
      currentMode === "prompt" ||
      (currentMode === "workspace-write" && requiredMode === "danger-full-access")
    ) {
      return this.promptOrDeny(
        toolName,
        input,
        currentMode,
        requiredMode,
        `tool '${toolName}' requires approval to escalate from ${currentMode} to ${requiredMode}`,
        prompter
      );
    }

    return {
      type: "deny",
      reason: `tool '${toolName}' requires ${requiredMode} permission; current mode is ${currentMode}`
    };
  }

  activeMode(): PermissionMode {
    return this.mode;
  }

  requiredModeFor(toolName: string): PermissionMode {
    return this.toolRequirements.get(toolName) ?? "danger-full-access";
  }

  private promptOrDeny(
    toolName: string,
    input: string,
    currentMode: PermissionMode,
    requiredMode: PermissionMode,
    reason: string,
    prompter?: PermissionPrompter
  ): PermissionOutcome {
    if (!prompter) {
      return { type: "deny", reason };
    }

    const decision = prompter.decide({
      toolName,
      input,
      currentMode,
      requiredMode,
      reason
    });
    return decision.type === "allow"
      ? { type: "allow" }
      : { type: "deny", reason: decision.reason };
  }

  private findMatchingRule(
    rules: PermissionRule[],
    toolName: string,
    input: string
  ): PermissionRule | undefined {
    return rules.find((rule) => matchesPermissionRule(rule, toolName, input));
  }

  private clone(): PermissionPolicy {
    return new PermissionPolicy(this.mode, {
      toolRequirements: new Map(this.toolRequirements),
      allowRules: [...this.allowRules],
      denyRules: [...this.denyRules],
      askRules: [...this.askRules]
    });
  }
}

interface PermissionRule {
  raw: string;
  toolName: string;
  matcher: { type: "any" } | { type: "exact"; value: string } | { type: "prefix"; value: string };
}

function parsePermissionRule(raw: string): PermissionRule {
  const trimmed = raw.trim();
  const open = trimmed.indexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open === -1 || close !== trimmed.length - 1) {
    return {
      raw: trimmed,
      toolName: trimmed,
      matcher: { type: "any" }
    };
  }

  const toolName = trimmed.slice(0, open).trim();
  const content = trimmed.slice(open + 1, close);
  if (content === "*" || content === "") {
    return { raw: trimmed, toolName, matcher: { type: "any" } };
  }
  if (content.endsWith(":*")) {
    return {
      raw: trimmed,
      toolName,
      matcher: { type: "prefix", value: content.slice(0, -2) }
    };
  }
  return {
    raw: trimmed,
    toolName,
    matcher: { type: "exact", value: content }
  };
}

function matchesPermissionRule(rule: PermissionRule, toolName: string, input: string): boolean {
  if (rule.toolName !== toolName) {
    return false;
  }

  const subject = extractPermissionSubject(input);
  if (rule.matcher.type === "any") {
    return true;
  }
  if (rule.matcher.type === "exact") {
    return subject === rule.matcher.value;
  }
  return subject.startsWith(rule.matcher.value);
}

function extractPermissionSubject(input: string): string {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    for (const key of [
      "command",
      "path",
      "file_path",
      "filePath",
      "notebook_path",
      "notebookPath",
      "url",
      "pattern",
      "code",
      "message"
    ]) {
      const value = parsed[key];
      if (typeof value === "string") {
        return value;
      }
    }
  } catch {
    // Fall back to the raw string.
  }
  return input;
}

function permissionRank(mode: PermissionMode): number {
  if (mode === "read-only") return 0;
  if (mode === "workspace-write") return 1;
  if (mode === "danger-full-access") return 2;
  if (mode === "prompt") return 3;
  return 4;
}
