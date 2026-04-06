import fs from "node:fs";
import path from "node:path";

const TRUST_PROMPT_CUES = [
  "do you trust the files in this folder",
  "trust the files in this folder",
  "trust this folder",
  "allow and continue",
  "yes, proceed"
] as const;

export type TrustPolicy = "auto_trust" | "require_approval" | "deny";

export type TrustEvent =
  | { type: "trust_required"; cwd: string }
  | { type: "trust_resolved"; cwd: string; policy: TrustPolicy }
  | { type: "trust_denied"; cwd: string; reason: string };

export type TrustDecision =
  | { type: "not_required" }
  | { type: "required"; policy: TrustPolicy; events: TrustEvent[] };

export class TrustConfig {
  allowlisted: string[] = [];
  denied: string[] = [];

  withAllowlisted(p: string): this {
    this.allowlisted.push(p);
    return this;
  }

  withDenied(p: string): this {
    this.denied.push(p);
    return this;
  }
}

export class TrustResolver {
  constructor(private readonly config: TrustConfig) {}

  resolve(cwd: string, screenText: string): TrustDecision {
    if (!detectTrustPrompt(screenText)) {
      return { type: "not_required" };
    }

    const events: TrustEvent[] = [{ type: "trust_required", cwd }];

    const deniedMatch = this.config.denied.find((root) => pathMatches(cwd, root));
    if (deniedMatch) {
      const reason = `cwd matches denied trust root: ${deniedMatch}`;
      events.push({ type: "trust_denied", cwd, reason });
      return { type: "required", policy: "deny", events };
    }

    if (this.config.allowlisted.some((root) => pathMatches(cwd, root))) {
      events.push({ type: "trust_resolved", cwd, policy: "auto_trust" });
      return { type: "required", policy: "auto_trust", events };
    }

    return { type: "required", policy: "require_approval", events };
  }

  trusts(cwd: string): boolean {
    return (
      !this.config.denied.some((root) => pathMatches(cwd, root)) &&
      this.config.allowlisted.some((root) => pathMatches(cwd, root))
    );
  }
}

export function trustDecisionPolicy(decision: TrustDecision): TrustPolicy | undefined {
  return decision.type === "required" ? decision.policy : undefined;
}

export function trustDecisionEvents(decision: TrustDecision): TrustEvent[] {
  return decision.type === "required" ? decision.events : [];
}

export function detectTrustPrompt(screenText: string): boolean {
  const lowered = screenText.toLowerCase();
  return TRUST_PROMPT_CUES.some((needle) => lowered.includes(needle));
}

export function pathMatchesTrustedRoot(cwd: string, trustedRoot: string): boolean {
  return pathMatches(cwd, normalizePath(trustedRoot));
}

function pathMatches(candidate: string, root: string): boolean {
  const c = normalizePath(candidate);
  const r = normalizePath(root);
  if (c === r) {
    return true;
  }
  const rel = path.relative(r, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function normalizePath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
