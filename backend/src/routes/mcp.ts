// /api/mcp/* — endpoints that proxy/inspect the Azure MCP Server.
// Today: tool listing as smoke test. Once the chat endpoint lands the
// tool calls themselves go via Claude, but exposing tools directly is
// useful for debugging and for the frontend to know what's available.

import type { FastifyInstance } from "fastify";
import { getMcpClient } from "../mcp/client.js";
import { getClaudeTools } from "../claude/tool-bridge.js";

export async function mcpRoutes(app: FastifyInstance) {
  // GET /api/mcp/tools
  // Returns the FULL tool list given to Claude — Microsoft's Azure
  // MCP Server tools plus our in-process custom tools (deploy_bicep,
  // etc). Use /api/mcp/tools?upstream=true to see only the MCP server's
  // tools (without our additions).
  app.get<{ Querystring: { upstream?: string; cloud?: string } }>(
    "/api/mcp/tools",
    async (req) => {
      if (req.query.upstream === "true") {
        const client = await getMcpClient();
        const result = await client.listTools();
        return {
          count: result.tools.length,
          tools: result.tools.map((t) => ({
            name: t.name,
            description: t.description,
            hasInputSchema: Boolean(t.inputSchema),
          })),
        };
      }
      // Default to azure for the smoke test endpoint; pass ?cloud=aws
      // to see the AWS-side tool list.
      const cloud =
        req.query.cloud === "aws" ? "aws" : ("azure" as "azure" | "aws");
      const tools = await getClaudeTools(cloud);
      return {
        cloud,
        count: tools.length,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          hasInputSchema: Boolean(t.input_schema),
        })),
      };
    }
  );

  // GET /api/mcp/health
  // Cheap "is the MCP child process up" check. Triggers connect on
  // first call so it doubles as a warm-up.
  app.get("/api/mcp/health", async () => {
    const client = await getMcpClient();
    // listTools is the lightest request we can make to confirm round-trip.
    const result = await client.listTools();
    return { ok: true, tool_count: result.tools.length };
  });
}
