/**
 * Top-level usage for the bundled CLI entry (`runCliEntry` / `dist/index.js`).
 */
export function printCliUsage(): void {
  process.stdout.write(
    [
      "Usage",
      "  clench [options] <prompt>           One-shot prompt (non-interactive)",
      "  clench [options]                    Interactive REPL when stdin is a TTY",
      "  clench [options] --resume <path>    Slash/status session commands",
      "",
      "Options",
      "  --model <id>              Model alias or full id (default: claude-opus-4-6)",
      "  --permission-mode <mode>  read-only | workspace-write | danger-full-access",
      "  --output-format <fmt>     text | json | ndjson",
      "  --allowed-tools <list>    Comma-separated: bash,grep,read_file,write_file,glob",
      "  --resume <ref|latest>     Session file or latest under .clench/sessions",
      "  --session <ref>         Same resolution as --resume (--resume wins if both)",
      "  --persist                 Persist to .clench/sessions/default.jsonl (no prompt)",
      "  -h, --help                Show this help",
      "",
      "REPL",
      "  Type a message and press Enter. Commands: exit, quit",
      ""
    ].join("\n")
  );
}
