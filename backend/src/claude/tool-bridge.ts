// Bridge between Anthropic Messages API tool format and MCP tool format.
//
// Multi-cloud aware: when the active project is Azure, Claude gets
// the Azure MCP tools + Bicep MCP tools + custom tools. When AWS,
// the AWS MCP tools + custom tools. The cache is keyed per-cloud
// so flipping the toggle doesn't invalidate the other side's cache.
//
// MCP tool definitions already use JSON Schema, so the conversion is a
// near-1:1 rename of fields. We cache the converted list once per
// cloud because:
//   1. Re-fetching tools on every request would burn time on a docker
//      stdio round-trip we don't need.
//   2. The tool list is part of the cached Anthropic prompt prefix —
//      changing it (different ordering, added tools) would invalidate
//      the prompt cache and force a re-write.

import type Anthropic from "@anthropic-ai/sdk";
import { getMcpClient } from "../mcp/client.js";
import { getBicepMcpClient } from "../mcp/bicep-client.js";
import { getAwsMcpClient } from "../mcp/aws-client.js";
import type { Cloud } from "./system-prompt.js";
import {
  CUSTOM_TOOLS,
  callCustomTool,
  isCustomTool,
} from "./custom-tools.js";

type ToolOwner = "azure" | "bicep" | "aws";

const cachedToolsByCloud: Record<Cloud, Anthropic.Tool[] | null> = {
  azure: null,
  aws: null,
};
// Track which server owns a given tool name so callMcpTool can route
// the call back to the right child process. Names are unique across
// the union of Azure-MCP, Bicep-MCP, and AWS-MCP — we route on first
// hit and the map persists across requests.
const toolOwner = new Map<string, ToolOwner>();

// Custom tools split by cloud. The Azure trio
// (deploy_bicep / destroy_azure / validate_bicep) is irrelevant on
// AWS chats, and vice versa — including them just bloats the prompt
// prefix and tempts the model into picking the wrong tool.
function splitCustomToolsByCloud(): {
  azure: Anthropic.Tool[];
  aws: Anthropic.Tool[];
  shared: Anthropic.Tool[];
} {
  const azure: Anthropic.Tool[] = [];
  const aws: Anthropic.Tool[] = [];
  const shared: Anthropic.Tool[] = [];
  for (const t of CUSTOM_TOOLS) {
    if (
      t.name === "deploy_bicep" ||
      t.name === "destroy_azure" ||
      t.name === "validate_bicep" ||
      t.name === "list_vm_skus"
    ) {
      azure.push(t);
    } else if (
      t.name === "deploy_cloudformation" ||
      t.name === "destroy_aws" ||
      t.name === "validate_cloudformation" ||
      t.name === "list_ec2_types"
    ) {
      aws.push(t);
    } else {
      shared.push(t);
    }
  }
  return { azure, aws, shared };
}

/**
 * Returns the combined tool list given to Claude for the requested
 * cloud. Sorted by name so the rendered prompt prefix is byte-stable
 * across backend restarts and the Anthropic prompt cache stays warm.
 */
export async function getClaudeTools(cloud: Cloud): Promise<Anthropic.Tool[]> {
  const cached = cachedToolsByCloud[cloud];
  if (cached) return cached;

  const { azure: azureCustom, aws: awsCustom, shared } = splitCustomToolsByCloud();

  if (cloud === "aws") {
    // AWS Labs MCP server is best-effort — if its container fails to
    // spawn (image not built, ~/.aws not mounted, no SSO session) we
    // degrade gracefully and give Claude only the AWS custom tools.
    let awsTools: Anthropic.Tool[] = [];
    try {
      const awsClient = await getAwsMcpClient();
      const awsResult = await awsClient.listTools();
      awsTools = awsResult.tools.map<Anthropic.Tool>((t) => {
        toolOwner.set(t.name, "aws");
        return {
          name: t.name,
          description: t.description ?? "",
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        };
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[mcp] aws-mcp unavailable, continuing without it:",
        err instanceof Error ? err.message : err
      );
    }
    const list = [...awsTools, ...awsCustom, ...shared].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    cachedToolsByCloud.aws = list;
    return list;
  }

  // Azure path (default).
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

  const list = [
    ...azureTools,
    ...bicepTools,
    ...azureCustom,
    ...shared,
  ].sort((a, b) => a.name.localeCompare(b.name));
  cachedToolsByCloud.azure = list;
  return list;
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
  // In-process custom tool (e.g. deploy_bicep, deploy_cloudformation)
  // — handle locally, never round-trip to an MCP server.
  if (isCustomTool(name)) {
    return callCustomTool(name, input);
  }

  // Route to the right MCP server based on which one registered the
  // tool. Falls back to azure-mcp if for some reason the tool wasn't
  // in the owner map (shouldn't happen, but harmless).
  const owner: ToolOwner = toolOwner.get(name) ?? "azure";
  try {
    const client =
      owner === "bicep"
        ? await getBicepMcpClient()
        : owner === "aws"
          ? await getAwsMcpClient()
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
