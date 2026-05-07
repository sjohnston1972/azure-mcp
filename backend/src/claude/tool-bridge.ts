// Bridge between Anthropic Messages API tool format and MCP tool format.
//
// MCP tool definitions already use JSON Schema, so the conversion is a
// near-1:1 rename of fields. We cache the converted list once at startup
// because:
//   1. Re-fetching tools on every request would burn time on a docker
//      stdio round-trip we don't need.
//   2. The tool list is part of the cached Anthropic prompt prefix —
//      changing it (different ordering, added tools) would invalidate
//      the prompt cache and force a re-write.

import type Anthropic from "@anthropic-ai/sdk";
import { getMcpClient } from "../mcp/client.js";
import { getBicepMcpClient } from "../mcp/bicep-client.js";
import {
  CUSTOM_TOOLS,
  callCustomTool,
  isCustomTool,
} from "./custom-tools.js";

let cachedTools: Anthropic.Tool[] | null = null;
// Track which server owns a given tool name so callMcpTool can route
// the call back to the right child process. Tools are uniquely named
// across both servers in practice.
const toolOwner = new Map<string, "azure" | "bicep">();

/**
 * Returns the combined tool list given to Claude — Microsoft's Azure
 * MCP Server tools, Microsoft's Bicep MCP Server tools, and our
 * custom in-process tools (deploy_bicep, destroy_azure, validate_bicep).
 * Sorted by name so the rendered prompt prefix is byte-stable across
 * backend restarts and the Anthropic prompt cache stays warm.
 */
export async function getClaudeTools(): Promise<Anthropic.Tool[]> {
  if (cachedTools) return cachedTools;

  const azureClient = await getMcpClient();
  const azureResult = await azureClient.listTools();
  const azureTools = azureResult.tools.map<Anthropic.Tool>((t) => {
    toolOwner.set(t.name, "azure");
    return {
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    };
  });

  // Bicep MCP server is best-effort — if its container fails to spawn
  // (e.g. the image hasn't been built yet) we degrade gracefully and
  // give Claude only the Azure MCP tools + our custom ones.
  let bicepTools: Anthropic.Tool[] = [];
  try {
    const bicepClient = await getBicepMcpClient();
    const bicepResult = await bicepClient.listTools();
    bicepTools = bicepResult.tools.map<Anthropic.Tool>((t) => {
      toolOwner.set(t.name, "bicep");
      return {
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      };
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[mcp] bicep-mcp unavailable, continuing without it:",
      err instanceof Error ? err.message : err
    );
  }

  cachedTools = [...azureTools, ...bicepTools, ...CUSTOM_TOOLS].sort(
    (a, b) => a.name.localeCompare(b.name)
  );

  return cachedTools;
}

/**
 * Calls an MCP tool and converts the result into the content shape
 * Anthropic expects in a tool_result block.
 *
 * MCP returns `content: ContentBlock[]` where each block is text/image/
 * resource. Anthropic's tool_result accepts a string OR an array of
 * text/image blocks — same shape for the common case, so we pass it
 * through. If `isError` is set on the MCP response we propagate it.
 */
export async function callMcpTool(
  name: string,
  input: unknown
): Promise<{
  content: string | Anthropic.ToolResultBlockParam["content"];
  is_error: boolean;
}> {
  // In-process custom tool (e.g. deploy_bicep) — handle locally,
  // never round-trip to an MCP server.
  if (isCustomTool(name)) {
    return callCustomTool(name, input);
  }

  // Route to the right MCP server based on which one registered the
  // tool. Falls back to azure-mcp if for some reason the tool wasn't
  // in the owner map (shouldn't happen, but harmless).
  const owner = toolOwner.get(name) ?? "azure";
  try {
    const client =
      owner === "bicep"
        ? await getBicepMcpClient()
        : await getMcpClient();
    const result = await client.callTool({
      name,
      arguments: (input ?? {}) as Record<string, unknown>,
    });
    const content = (result.content ??
      []) as Anthropic.ToolResultBlockParam["content"];
    return { content, is_error: Boolean(result.isError) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `MCP tool '${name}' (${owner}) threw: ${message}`,
      is_error: true,
    };
  }
}
