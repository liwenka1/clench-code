import { resolveCliOutputFormat } from "./args";
import { printPromptSummary, runPromptMode } from "./prompt-run";
import type { SessionInfo } from "./session";
import { resolveSkillsCommand } from "./skills";

export interface SkillsCliState {
  cwd: string;
  model: string;
  permissionMode: string;
  outputFormat: string | undefined;
  allowedTools: string | undefined;
}

export async function printSkills(
  cli: SkillsCliState,
  sessionInfo: SessionInfo | undefined,
  args: string[]
): Promise<void> {
  const resolved = resolveSkillsCommand(cli.cwd, args);
  if (resolved.kind === "local") {
    process.stdout.write(resolved.output);
    return;
  }
  const outputFormat = cli.outputFormat ? resolveCliOutputFormat(cli.outputFormat) : "text";
  const summary = await runPromptMode({
    prompt: resolved.invocation.prompt,
    model: cli.model,
    permissionMode: cli.permissionMode as "read-only" | "workspace-write" | "danger-full-access",
    outputFormat,
    allowedTools: cli.allowedTools?.split(",").map((tool) => tool.trim()).filter(Boolean),
    extraSystemPrompts: [resolved.invocation.systemPrompt],
    resumeSessionPath: sessionInfo?.path
  });
  printPromptSummary(summary, outputFormat, { model: cli.model });
}
