// Microsoft's Bicep MCP server (Azure.Bicep.McpServer), spawned as a
// sibling docker container the same way we spawn the broader Azure
// MCP server. Provides authoring helpers Claude calls during build
// turns: list_avm_metadata (so Claude can verify AVM module versions
// before referencing them), get_bicep_file_diagnostics (overlaps with
// our validate_bicep but with structured output), get_az_resource_type_schema,
// format_bicep_file, decompile_arm_*, etc.
//
// Distinct from our azure-mcp client (mcp/client.ts): two separate
// MCP processes, two separate tool registries, both merged by the
// tool-bridge into Claude's tool list.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const IMAGE =
  process.env.AZURE_MCP_BICEP_IMAGE ?? "azure-mcp-bicep-mcp:latest";

let clientPromise: Promise<Client> | null = null;

/**
 * Returns the singleton bicep-mcp client, connecting on first call.
 * Subsequent callers share the same connection.
 */
export function getBicepMcpClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "docker",
    args: [
      "run",
      "-i",
      "--rm",
      "--name",
      `bicep-mcp-stdio-${process.pid}`,
      IMAGE,
    ],
    stderr: "pipe",
  });

  const client = new Client(
    { name: "azure-mcp-backend-bicep", version: "0.1.0" },
    { capabilities: {} }
  );

  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[bicep-mcp] ${chunk.toString()}`);
  });

  await client.connect(transport);
  // eslint-disable-next-line no-console
  console.log("[mcp] connected to bicep-mcp via stdio");
  return client;
}

export async function closeBicepMcpClient(): Promise<void> {
  if (!clientPromise) return;
  try {
    const c = await clientPromise;
    await c.close();
  } catch {
    /* best effort */
  } finally {
    clientPromise = null;
  }
}
