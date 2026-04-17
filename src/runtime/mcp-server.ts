import type { Readable, Writable } from "node:stream";

import {
  McpStdioParser,
  encodeStdioMessage,
  type JsonRpcMessage,
  type McpToolDefinition
} from "./mcp-stdio.js";

/** Protocol version this server advertises during `initialize`. Matches the
 * version used by the built-in client in `mcp-stdio.ts` so the two stay in
 * lockstep. */
export const MCP_SERVER_PROTOCOL_VERSION = "2025-03-26";

/** Result type for a tool invocation.
 *
 * Returning `{ isError: false, text }` yields a single `text` content block
 * and `isError: false`. Returning `{ isError: true, text }` or throwing an
 * `Error` yields a `text` block with the error message and `isError: true`,
 * mirroring the error-surfacing convention used elsewhere in the runtime. */
export interface McpToolCallOutcome {
  text: string;
  isError?: boolean;
}

/** Handler invoked for every `tools/call` request.
 *
 * The handler receives the unqualified tool name (as advertised in
 * `tools/list`) and the raw `arguments` value supplied by the client. It may
 * return a string (treated as a success text block), a full
 * {@link McpToolCallOutcome}, or throw an `Error` to surface an error block. */
export type McpServerToolHandler = (
  name: string,
  args: unknown
) => string | McpToolCallOutcome | Promise<string | McpToolCallOutcome>;

/** Configuration for an {@link McpServer} instance.
 *
 * Named `McpServerSpec` rather than `McpServerConfig` to avoid colliding with
 * the existing client-side `McpServerConfig` (which describes *remote* MCP
 * servers the runtime connects to). */
export interface McpServerSpec {
  serverName: string;
  serverVersion: string;
  tools: McpToolDefinition[];
  toolHandler: McpServerToolHandler;
}

/** JSON-RPC 2.0 error codes used by this server. */
export const MCP_SERVER_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603
} as const;

interface DispatchContext {
  id: string | number | null;
  method: string;
  params?: unknown;
}

/** Minimal MCP stdio server.
 *
 * Answers `initialize`, `tools/list`, and `tools/call` requests over
 * LSP-framed JSON-RPC. Framing is compatible with {@link McpStdioParser} so
 * this server can be driven by either an external MCP client or the
 * in-process {@link McpServerManager}. */
export class McpServer {
  constructor(public readonly spec: McpServerSpec) {}

  /** Runs the server until the peer closes `readable`.
   *
   * Resolves on clean EOF; rejects on underlying stream errors so callers
   * can log and exit non-zero. */
  async run(readable: Readable, writable: Writable): Promise<void> {
    const parser = new McpStdioParser();
    const pendingWrites: Promise<void>[] = [];
    let streamError: Error | undefined;

    readable.setEncoding?.("utf8");

    const handleFrame = async (frame: JsonRpcMessage): Promise<void> => {
      const response = await this.dispatchMessage(frame as unknown as Record<string, unknown>);
      if (!response) {
        return;
      }
      await writeMessage(writable, response);
    };

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        streamError = err;
        reject(err);
      };

      readable.on("error", onError);
      writable.on("error", onError);

      readable.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let parsed: JsonRpcMessage[];
        try {
          parsed = parser.pushChunk(text);
        } catch (error) {
          const message: JsonRpcMessage = {
            jsonrpc: "2.0",
            id: 0,
            error: {
              code: MCP_SERVER_ERROR_CODES.parseError,
              message: `parse error: ${(error as Error).message}`
            }
          };
          pendingWrites.push(writeMessage(writable, message));
          return;
        }
        for (const frame of parsed) {
          pendingWrites.push(handleFrame(frame));
        }
      });

      readable.on("end", () => {
        Promise.all(pendingWrites)
          .then(() => {
            if (streamError) {
              reject(streamError);
            } else {
              resolve();
            }
          })
          .catch(reject);
      });
    });
  }

  /** Dispatches a single already-parsed JSON-RPC request/notification.
   *
   * Returns `undefined` for notifications (messages without an `id`), and a
   * response message otherwise. Exposed for unit tests and for callers that
   * want to drive the server without stdio framing. */
  async dispatchMessage(message: Record<string, unknown>): Promise<JsonRpcMessage | undefined> {
    if (!("id" in message) || message.id === undefined) {
      return undefined;
    }
    const id = normalizeId(message.id);
    const method = typeof message.method === "string" ? message.method : undefined;
    if (!method) {
      return errorResponse(id, MCP_SERVER_ERROR_CODES.invalidRequest, "invalid request: missing method");
    }
    const context: DispatchContext = { id, method, params: message.params };

    switch (method) {
      case "initialize":
        return this.handleInitialize(context);
      case "tools/list":
        return this.handleToolsList(context);
      case "tools/call":
        return await this.handleToolsCall(context);
      default:
        return errorResponse(id, MCP_SERVER_ERROR_CODES.methodNotFound, `method not found: ${method}`);
    }
  }

  private handleInitialize(context: DispatchContext): JsonRpcMessage {
    return {
      jsonrpc: "2.0",
      id: context.id as number | string,
      result: {
        protocolVersion: MCP_SERVER_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: this.spec.serverName,
          version: this.spec.serverVersion
        }
      }
    };
  }

  private handleToolsList(context: DispatchContext): JsonRpcMessage {
    return {
      jsonrpc: "2.0",
      id: context.id as number | string,
      result: { tools: [...this.spec.tools] }
    };
  }

  private async handleToolsCall(context: DispatchContext): Promise<JsonRpcMessage> {
    const params = context.params;
    if (!params || typeof params !== "object") {
      return errorResponse(
        context.id,
        MCP_SERVER_ERROR_CODES.invalidParams,
        "missing params for tools/call"
      );
    }
    const callParams = params as { name?: unknown; arguments?: unknown };
    if (typeof callParams.name !== "string" || callParams.name.length === 0) {
      return errorResponse(
        context.id,
        MCP_SERVER_ERROR_CODES.invalidParams,
        "invalid tools/call params: 'name' must be a non-empty string"
      );
    }

    const args = callParams.arguments ?? {};
    let text: string;
    let isError: boolean;
    try {
      const outcome = await this.spec.toolHandler(callParams.name, args);
      if (typeof outcome === "string") {
        text = outcome;
        isError = false;
      } else {
        text = outcome.text;
        isError = outcome.isError === true;
      }
    } catch (error) {
      text = error instanceof Error ? error.message : String(error);
      isError = true;
    }

    return {
      jsonrpc: "2.0",
      id: context.id as number | string,
      result: {
        content: [{ type: "text", text }],
        isError
      }
    };
  }
}

function normalizeId(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: (id ?? 0) as number | string,
    error: { code, message }
  };
}

async function writeMessage(writable: Writable, message: JsonRpcMessage): Promise<void> {
  const frame = encodeStdioMessage(message);
  await new Promise<void>((resolve, reject) => {
    writable.write(frame, (err) => (err ? reject(err) : resolve()));
  });
}
