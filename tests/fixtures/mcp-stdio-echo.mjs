/**
 * Minimal MCP-style stdio peer.
 * Supports initialize, tools/list, resources/list, and tools/call for test bootstrap flows.
 */
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const sep = buffer.indexOf("\r\n\r\n");
  if (sep === -1) {
    return;
  }
  const match = buffer.slice(0, sep).match(/Content-Length:\s*(\d+)/i);
  if (!match) {
    process.exit(2);
  }
  const length = Number(match[1]);
  const bodyStart = sep + 4;
  if (buffer.length < bodyStart + length) {
    return;
  }
  const body = buffer.slice(bodyStart, bodyStart + length);
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    process.exit(3);
  }
  const reply = JSON.stringify({
    jsonrpc: "2.0",
    id: msg.id,
    result: resultFor(msg)
  });
  const frame = `Content-Length: ${Buffer.byteLength(reply, "utf8")}\r\n\r\n${reply}`;
  process.stdout.write(frame);
  process.exit(0);
});

function resultFor(msg) {
  if (msg.method === "initialize") {
    return {
      ok: true,
      method: msg.method ?? null,
      serverInfo: { name: "echo-stdio", version: "1.0.0" }
    };
  }
  if (msg.method === "tools/list") {
    return {
      tools: [
        {
          name: "echo",
          description: "Echo input text",
          inputSchema: { type: "object", properties: { text: { type: "string" } } }
        }
      ]
    };
  }
  if (msg.method === "resources/list") {
    return {
      resources: [
        {
          uri: "resource://echo",
          name: "Echo Resource",
          mimeType: "application/json"
        }
      ]
    };
  }
  if (msg.method === "tools/call") {
    const toolName = msg.params?.name ?? null;
    const text = msg.params?.arguments?.text ?? "";
    return {
      content: [{ type: "text", text: `echo:${text}` }],
      structuredContent: { server: "echo-stdio", tool: toolName, echoed: text },
      isError: false
    };
  }
  return { ok: true, method: msg.method ?? null };
}
