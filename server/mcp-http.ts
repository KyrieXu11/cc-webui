import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
export async function serveMcp(raw: Request, make: () => McpServer): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = make();
  await server.connect(transport);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // Closing the server closes the transport it is connected to.
    void Promise.resolve(server.close()).catch(() => {});
  };
  let res: Response;
  try {
    res = await transport.handleRequest(raw);
  } catch (err) {
    close();
    throw err;
  }

  // A streaming (SSE) response stays open for the rest of the exchange, so
  // disposal has to wait for the stream to finish rather than for this handler
  // to return.
  if (!res.body) {
    close();
    return res;
  }
  const reader = res.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          close();
        } else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        close();
      }
    }
  });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  });
}
