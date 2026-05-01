import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  extractBearerToken,
  getCodexMcpContext,
} from "./codex-mcp-context.ts";
import {
  MAX_TIMEOUT_MS,
  killBackground,
  listBackgroundTasksForTool,
  readBackgroundOutput,
  runBashTool,
} from "./bash-mcp.ts";

const route = new Hono();

function createServerForToken(token: string): McpServer {
  const server = new McpServer({
    name: "cc-webui-bash",
    version: "0.1.0",
  });

  const getContext = () => getCodexMcpContext(token);

  server.registerTool(
    "run",
    {
      title: "Run Bash",
      description:
        "Execute a bash command in the project working directory. " +
        "Set run_in_background=true for long-running commands; the returned bashTaskId can be polled with output or killed with kill.",
      inputSchema: {
        command: z.string().describe("The bash command to execute"),
        timeout: z
          .number()
          .int()
          .positive()
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(
            `Optional timeout in ms for foreground runs (max ${MAX_TIMEOUT_MS})`
          ),
        description: z
          .string()
          .optional()
          .describe("Short description of what this command does"),
        run_in_background: z
          .boolean()
          .optional()
          .describe("If true, run asynchronously and return a bashTaskId."),
      },
    },
    async (args, extra) => {
      const ctx = getContext();
      if (!ctx) {
        return {
          content: [{ type: "text", text: "MCP context expired." }],
          isError: true,
        };
      }
      return runBashTool(
        args,
        {
          cwd: ctx.cwd,
          getSessionId: () => ctx.sessionId,
        },
        extra.signal
      );
    }
  );

  server.registerTool(
    "output",
    {
      title: "Read Bash Output",
      description:
        "Retrieve new stdout/stderr output from a background bash task since the last poll, plus current status and exit code.",
      inputSchema: {
        bash_id: z
          .string()
          .describe("The bashTaskId returned by run with run_in_background=true"),
      },
    },
    async ({ bash_id }) => readBackgroundOutput(bash_id)
  );

  server.registerTool(
    "kill",
    {
      title: "Kill Bash Task",
      description: "Kill a running background bash task by bashTaskId.",
      inputSchema: {
        bash_id: z
          .string()
          .describe("The bashTaskId returned by run with run_in_background=true"),
      },
    },
    async ({ bash_id }) => killBackground(bash_id)
  );

  server.registerTool(
    "list",
    {
      title: "List Bash Tasks",
      description:
        "List background bash tasks for this conversation, including id, status and command.",
      inputSchema: {},
    },
    async () => {
      const ctx = getContext();
      if (!ctx) {
        return {
          content: [{ type: "text", text: "MCP context expired." }],
          isError: true,
        };
      }
      return listBackgroundTasksForTool(ctx.sessionId);
    }
  );

  return server;
}

route.all("/bash", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!getCodexMcpContext(token)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createServerForToken(token!);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export { route as mcpBashRoute };
