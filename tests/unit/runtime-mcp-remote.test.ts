import { afterEach, describe, expect, test, vi } from "vitest";

import { mcpClientBootstrapFromScopedConfig } from "../../src/runtime/mcp-client.js";
import { callRemoteMcpTransportOnce, clearRemoteMcpSseSessions, getRemoteMcpSseRuntimeState } from "../../src/runtime/mcp-remote.js";

function streamFromString(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  });
}

function streamFromChunksWithDelayedClose(chunks: string[], closeAfterMs = 20): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      setTimeout(() => {
        try {
          controller.close();
        } catch {
          // Reader may already have cancelled the stream during teardown.
        }
      }, closeAfterMs);
    }
  });
}

describe("runtime mcp remote", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearRemoteMcpSseSessions();
  });

  test("callRemoteMcpTransportOnce_parses_jsonrpc_from_sse_event_stream", async () => {
    const bootstrap = mcpClientBootstrapFromScopedConfig("remote-sse", {
      scope: "local",
      config: {
        type: "sse",
        url: "https://vendor.example/sse",
        headers: { "X-Test": "1" },
        oauth: { clientId: "client-1" }
      }
    });

    let getCalls = 0;
    let postCalls = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        getCalls += 1;
        return new Response(
          streamFromString([
            ": keepalive\n\n",
            "event: message\n",
            'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true,"transport":"sse"}}\n\n'
          ].join("")),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          }
        );
      }
      postCalls += 1;
      return new Response("", {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const message = await callRemoteMcpTransportOnce(bootstrap, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    });

    expect(message).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true, transport: "sse" }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://vendor.example/sse",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          accept: "text/event-stream",
          "X-Test": "1"
        })
      })
    );
    expect(getCalls).toBe(1);
    expect(postCalls).toBe(1);
  });

  test("callRemoteMcpTransportOnce_reuses_sse_session_for_multiple_requests", async () => {
    const bootstrap = mcpClientBootstrapFromScopedConfig("remote-sse", {
      scope: "local",
      config: {
        type: "sse",
        url: "https://vendor.example/sse",
        headers: { "X-Test": "1" },
        oauth: { clientId: "client-1" }
      }
    });

    let getCalls = 0;
    let postCalls = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        getCalls += 1;
        return new Response(
          streamFromChunksWithDelayedClose([
            'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
            'data: {"jsonrpc":"2.0","id":2,"result":{"ok":true,"second":true}}\n\n'
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      postCalls += 1;
      return new Response("", { status: 202, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await callRemoteMcpTransportOnce(bootstrap, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    })).toMatchObject({ id: 1, result: { ok: true } });

    expect(getRemoteMcpSseRuntimeState("remote-sse")).toMatchObject({
      connection: "open",
      reconnectCount: 0,
      pendingRequestCount: 0,
      bufferedMessageCount: 1
    });

    expect(await callRemoteMcpTransportOnce(bootstrap, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    })).toMatchObject({ id: 2, result: { ok: true, second: true } });

    expect(getCalls).toBe(1);
    expect(postCalls).toBe(2);
  });

  test("callRemoteMcpTransportOnce_rebuilds_sse_session_after_stream_closes", async () => {
    const bootstrap = mcpClientBootstrapFromScopedConfig("remote-sse-reconnect", {
      scope: "local",
      config: {
        type: "sse",
        url: "https://vendor.example/sse",
        headers: { "X-Test": "1" },
        oauth: { clientId: "client-1" }
      }
    });

    let getCalls = 0;
    let postCalls = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        getCalls += 1;
        return new Response(
          streamFromString(
            getCalls === 1
              ? 'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'
              : 'data: {"jsonrpc":"2.0","id":2,"result":{"ok":true,"reconnected":true}}\n\n'
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      postCalls += 1;
      return new Response("", { status: 202, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await callRemoteMcpTransportOnce(bootstrap, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    })).toMatchObject({ id: 1, result: { ok: true } });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await callRemoteMcpTransportOnce(bootstrap, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    })).toMatchObject({ id: 2, result: { ok: true, reconnected: true } });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getRemoteMcpSseRuntimeState("remote-sse-reconnect")).toMatchObject({
      connection: "idle",
      reconnectCount: 1,
      pendingRequestCount: 0,
      bufferedMessageCount: 0,
      lastError: "remote MCP SSE session closed"
    });

    expect(getCalls).toBe(2);
    expect(postCalls).toBe(2);
  });
});
