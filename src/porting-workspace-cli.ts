import {
  QueryEnginePort,
  bootstrapSession,
  buildPortManifest,
  execCommand,
  execTool,
  showCommand,
  showTool
} from "./porting-workspace/index";

function parseLimit(args: string[]): number {
  const index = args.indexOf("--limit");
  if (index === -1 || !args[index + 1]) {
    return 5;
  }
  return Number.parseInt(args[index + 1]!, 10) || 5;
}

export function runPortingWorkspaceCli(): void {
  const [, , command, ...args] = process.argv;
  const engine = QueryEnginePort.fromWorkspace();

  switch (command) {
    case "summary":
      console.log(engine.renderSummary());
      break;
    case "manifest": {
      const manifest = buildPortManifest();
      console.log(JSON.stringify(manifest));
      break;
    }
    case "route": {
      const query = args.filter((arg) => !arg.startsWith("--")).join(" ");
      const limit = parseLimit(args);
      console.log(
        engine
          .route(query, limit)
          .map((match) => `${match.kind}: ${match.name}`)
          .join("\n")
      );
      break;
    }
    case "show-command":
      console.log(showCommand(args[0] || "review"));
      break;
    case "show-tool":
      console.log(showTool(args[0] || "MCPTool"));
      break;
    case "bootstrap": {
      const query = args.filter((arg) => !arg.startsWith("--")).join(" ");
      const limit = parseLimit(args);
      console.log(bootstrapSession(query, limit).output);
      break;
    }
    case "exec-command":
      console.log(execCommand(args[0] || "review", args.slice(1).join(" ")));
      break;
    case "exec-tool":
      console.log(execTool(args[0] || "MCPTool", args.slice(1).join(" ")));
      break;
    default:
      console.error(`Unknown command: ${command ?? "(none)"}`);
      process.exit(1);
  }
}

runPortingWorkspaceCli();
