// /api/mcp/* — endpoints that proxy/inspect the Azure MCP Server.
// Today: tool listing as smoke test. Once the chat endpoint lands the
// tool calls themselves go via Claude, but exposing tools directly is
// useful for debugging and for the frontend to know what's available.

import type { FastifyInstance } from "fastify";
import { getMcpClient } from "../mcp/client.js";
import { getClaudeTools } from "../claude/tool-bridge.js";
import type { ChatStage } from "../claude/tool-stages.js";

export async function mcpRoutes(app: FastifyInstance) {
  // GET /api/mcp/tools
  // Returns the FULL tool list given to Claude — Microsoft's Azure
  // MCP Server tools plus our in-process custom tools (deploy_bicep,
  // etc). Use /api/mcp/tools?upstream=true to see only the MCP server's
  // tools (without our additions).
  app.get<{ Querystring: { upstream?: string; cloud?: string; stage?: string } }>(
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
      // The list Claude sees depends on the lifecycle stage — mutating
      // tools are withheld in read-only stages. Pass ?stage=push (or
      // teardown/view/free) to inspect a specific stage's list; the
      // default mirrors a fresh chat turn.
      const stage: ChatStage = (
        ["build", "view", "push", "teardown", "free"] as ChatStage[]
      ).includes(req.query.stage as ChatStage)
        ? (req.query.stage as ChatStage)
        : "build";
      const tools = await getClaudeTools(cloud, stage);
      return {
        cloud,
        stage,
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
