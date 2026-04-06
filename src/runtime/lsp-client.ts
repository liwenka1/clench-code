export type LspAction =
  | "diagnostics"
  | "hover"
  | "definition"
  | "references"
  | "completion"
  | "symbols"
  | "format";

export interface LspDiagnostic {
  path: string;
  line: number;
  character: number;
  severity: string;
  message: string;
  source?: string;
}

export interface LspServerState {
  language: string;
  status: "connected" | "disconnected" | "starting" | "error";
  rootPath?: string;
  capabilities: string[];
  diagnostics: LspDiagnostic[];
}

export function lspActionFromString(input: string): LspAction | undefined {
  switch (input) {
    case "diagnostics":
      return "diagnostics";
    case "hover":
      return "hover";
    case "definition":
    case "goto_definition":
      return "definition";
    case "references":
    case "find_references":
      return "references";
    case "completion":
    case "completions":
      return "completion";
    case "symbols":
    case "document_symbols":
      return "symbols";
    case "format":
    case "formatting":
      return "format";
    default:
      return undefined;
  }
}

export class LspRegistry {
  private readonly servers = new Map<string, LspServerState>();

  register(
    language: string,
    status: LspServerState["status"],
    rootPath: string | undefined,
    capabilities: string[]
  ): void {
    this.servers.set(language, {
      language,
      status,
      rootPath,
      capabilities: [...capabilities],
      diagnostics: []
    });
  }

  get(language: string): LspServerState | undefined {
    const server = this.servers.get(language);
    return server ? cloneServer(server) : undefined;
  }

  findServerForPath(path: string): LspServerState | undefined {
    const ext = path.split(".").pop() ?? "";
    const language =
      {
        rs: "rust",
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        py: "python",
        go: "go",
        java: "java",
        c: "c",
        h: "c",
        cpp: "cpp",
        hpp: "cpp",
        cc: "cpp",
        rb: "ruby",
        lua: "lua"
      }[ext];

    return language ? this.get(language) : undefined;
  }

  listServers(): LspServerState[] {
    return [...this.servers.values()].map(cloneServer);
  }

  addDiagnostics(language: string, diagnostics: LspDiagnostic[]): void {
    const server = this.mustGet(language);
    server.diagnostics.push(...diagnostics.map((item) => ({ ...item })));
  }

  getDiagnostics(path: string): LspDiagnostic[] {
    return [...this.servers.values()]
      .flatMap((server) => server.diagnostics)
      .filter((diagnostic) => diagnostic.path === path)
      .map((diagnostic) => ({ ...diagnostic }));
  }

  clearDiagnostics(language: string): void {
    this.mustGet(language).diagnostics = [];
  }

  disconnect(language: string): LspServerState | undefined {
    const server = this.servers.get(language);
    if (!server) {
      return undefined;
    }
    this.servers.delete(language);
    return cloneServer(server);
  }

  len(): number {
    return this.servers.size;
  }

  isEmpty(): boolean {
    return this.servers.size === 0;
  }

  dispatch(
    action: string,
    path?: string,
    line?: number,
    character?: number,
    query?: string
  ): Record<string, unknown> {
    const resolved = lspActionFromString(action);
    if (!resolved) {
      throw new Error(`unknown LSP action: ${action}`);
    }

    if (resolved === "diagnostics") {
      const diagnostics = path
        ? this.getDiagnostics(path)
        : [...this.servers.values()].flatMap((server) => server.diagnostics).map((item) => ({ ...item }));
      return {
        action: "diagnostics",
        ...(path ? { path } : {}),
        diagnostics,
        count: diagnostics.length
      };
    }

    if (!path) {
      throw new Error("path is required for this LSP action");
    }
    const server = this.findServerForPath(path);
    if (!server) {
      throw new Error(`no LSP server available for path: ${path}`);
    }
    if (server.status !== "connected") {
      throw new Error(`LSP server for '${server.language}' is not connected (status: ${server.status})`);
    }

    return {
      action: resolved,
      path,
      line,
      character,
      query,
      language: server.language,
      status: "dispatched",
      message: `LSP ${resolved} dispatched to ${server.language} server`
    };
  }

  private mustGet(language: string): LspServerState {
    const server = this.servers.get(language);
    if (!server) {
      throw new Error(`LSP server not found for language: ${language}`);
    }
    return server;
  }
}

function cloneServer(server: LspServerState): LspServerState {
  return {
    ...server,
    capabilities: [...server.capabilities],
    diagnostics: server.diagnostics.map((item) => ({ ...item }))
  };
}
