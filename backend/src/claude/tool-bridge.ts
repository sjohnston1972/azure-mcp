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
import {
  CUSTOM_TOOLS,
  callCustomTool,
  isCustomTool,
} from "./custom-tools.js";

let cachedTools: Anthropic.Tool[] | null = null;

/**
 * Returns the combined tool list given to Claude — Microsoft's Azure
 * MCP Server tools plus our custom in-process tools (deploy_bicep,
 * etc). Sorted by name so the rendered prompt prefix is byte-stable
 * across backend restarts and the Anthropic prompt cache stays warm.
 */
export async function getClaudeTools(): Promise<Anthropic.Tool[]> {
  if (cachedTools) return cachedTools;

  const client = await getMcpClient();
  const result = await client.listTools();

  const mcpTools = result.tools.map<Anthropic.Tool>((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));

  cachedTools = [...mcpTools, ...CUSTOM_TOOLS].sort((a, b) =>
    a.name.localeCompare(b.name)
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
  // never round-trip to the upstream MCP server.
  if (isCustomTool(name)) {
    return callCustomTool(name, input);
  }

  const client = await getMcpClient();
  try {
    const result = await client.callTool({
      name,
      arguments: (input ?? {}) as Record<string, unknown>,
    });

    // MCP `content` is an array of { type, text? | data? | resource? }.
    // Anthropic accepts text/image blocks in tool_result content; the
    // shapes line up for our use case (Azure MCP returns text mostly).
    const content = (result.content ?? []) as Anthropic.ToolResultBlockParam["content"];
    return { content, is_error: Boolean(result.isError) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `MCP tool '${name}' threw: ${message}`,
      is_error: true,
    };
  }
}
