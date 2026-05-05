import { parseSlashCommand, SlashCommandParseError, type SlashCommand } from "../commands/index.js";

export function parseSlashCommandOrThrow(command: { name: string; args: string[] }): SlashCommand {
  try {
    const parsed = parseSlashCommand([command.name, ...command.args.map(quoteSlashArgIfNeeded)].join(" "));
    if (!parsed) {
      failUnknownSlashCommand(command.name);
    }
    return parsed;
  } catch (error) {
    if (error instanceof SlashCommandParseError && error.message.startsWith("Unknown slash command")) {
      failUnknownSlashCommand(command.name);
    }
    throw error;
  }
}

export function failUnknownSlashCommand(command: string): never {
  const suggestion = "/status";
  throw new Error(`unknown slash command outside the REPL: ${command}\nDid you mean ${suggestion}?`);
}

function quoteSlashArgIfNeeded(value: string): string {
  if (!/[\s"'\\]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
