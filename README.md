# clench-code

TypeScript implementation of the Clench CLI agent harness. This project is developed against the repository reference sources and keeps parity behavior covered by unit, integration, and e2e tests.

## Quick Start

```bash
pnpm install
pnpm run build
pnpm run cli -- --help
```

Run a one-shot prompt after building:

```bash
pnpm run cli -- prompt "summarize this workspace"
```

Run the interactive CLI:

```bash
pnpm run cli
```

## Verification

Use the same command locally that CI runs:

```bash
pnpm run verify
```

This runs TypeScript checking, bundles the CLI with esbuild, and executes the Vitest suite.

## Configuration

Runtime configuration is loaded in this order:

1. `$CLENCH_CONFIG_HOME/settings.json`
2. `.clench.json`
3. `.clench/settings.local.json`

Later files override earlier files. Malformed config files are skipped and surfaced through config diagnostics instead of being silently applied. Use the config and doctor surfaces to inspect what was loaded:

```bash
pnpm run cli -- /config
pnpm run cli -- doctor
```

Example:

```json
{
  "model": "sonnet",
  "permissions": {
    "defaultMode": "workspace-write"
  },
  "sandbox": {
    "enabled": false
  }
}
```

## Common Commands

```bash
pnpm run cli -- version
pnpm run cli -- init
pnpm run cli -- doctor
pnpm run cli -- sandbox
pnpm run cli -- prompt "explain src/runtime/conversation.ts"
```

Useful flags:

```bash
--model <model-or-alias>
--permission-mode read-only|workspace-write|danger-full-access
--output-format text|json|ndjson
```

## Project Layout

- `src/api/` - provider clients, streaming, error modeling, and provider selection.
- `src/runtime/` - conversation loop, sessions, permissions, config, MCP, OAuth, tasks, teams, and cron runtime state.
- `src/tools/` - built-in tool definitions and execution helpers.
- `src/commands/` - slash command parsing and help rendering.
- `src/cli/` - process entry routing, REPL, prompt mode, rendering, and command handlers.
- `tests/` - unit, integration, and e2e coverage including parity-oriented scenarios.

## Engineering Notes

Keep behavior-changing work covered by tests close to the changed surface. Prefer sharing parsers and validators over adding new command-specific casts, especially for CLI flags and slash commands.
