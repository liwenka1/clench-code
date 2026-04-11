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
      "  clench doctor                       Print environment and auth diagnostics",
      "  clench sandbox                      Print resolved sandbox status",
      "  clench dump-manifests               Print porting workspace manifest JSON",
      "  clench bootstrap-plan <query>       Print a bootstrapped runtime session plan",
      "",
      "Options",
      "  --model <id>              Model alias or full id (default: claude-opus-4-6)",
      "  --permission-mode <mode>  read-only | workspace-write | danger-full-access",
      "  --output-format <fmt>     text | json | ndjson",
      "  --allowed-tools <list>    Comma-separated: bash,grep,glob,read_file,write_file",
      "  --compact                 Print final assistant text only",
      "  --resume <ref|latest>     Session file or latest under .clench/sessions",
      "  --session <ref>         Same resolution as --resume (--resume wins if both)",
      "  --persist                 Persist to .clench/sessions/default.jsonl (no prompt)",
      "  -h, --help                Show this help",
      "",
      "REPL",
      "  Type a message and press Enter. Commands: exit, quit",
      "  History: /history [count] prints recent prompts",
      "  Multi-line: /multiline to start, /submit to send, /cancel to discard",
      "  Shortcut: end a line with \\ to enter multi-line compose mode",
      "  Ctrl-C: cancel current draft or multi-line compose; press again on empty prompt to exit",
      ""
    ].join("\n")
  );
}
