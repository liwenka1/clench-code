import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface CapturedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface MockResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  body: string;
}

export interface MockAnthropicServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

export async function startMockAnthropicServer(responses: MockResponse[]): Promise<MockAnthropicServer> {
  const requests: CapturedRequest[] = [];
  let responseIndex = 0;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    requests.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8")
    });

    const response = responses[Math.min(responseIndex, responses.length - 1)] ?? {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: "{}"
    };

    responseIndex += 1;

    res.writeHead(response.statusCode ?? 200, response.headers ?? { "content-type": "application/json" });
    res.end(response.body);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    }
  };
}
