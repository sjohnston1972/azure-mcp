// ── Azure MCP client (stdio transport) ────────────────────────────
//
// We run Microsoft's Azure MCP Server as a sibling Docker container,
// talking to it over stdio. The MCP TypeScript SDK keeps the spawned
// process alive for the lifetime of the client; we connect once at
// first use and every subsequent tool call reuses the same connection.
//
// Why stdio (not HTTP) — see DECISIONS.md "Azure MCP transport".

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config.js";

const IMAGE = process.env.AZURE_MCP_IMAGE ?? "mcr.microsoft.com/azure-sdk/azure-mcp:latest";

let clientPromise: Promise<Client> | null = null;

/**
 * Returns the singleton MCP client, connecting on first call.
 * Subsequent callers share the same connection and underlying child
 * process. If the connection is ever lost, the next call rebuilds it.
 */
export function getMcpClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      // Reset the promise so a retry can fix transient failures.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function connect(): Promise<Client> {
  // We pass Azure SP creds via -e flags (not --env-file) because the
  // backend container's /app doesn't have a .env file inside it; the
  // values come in via Compose's env_file → process.env.
  const transport = new StdioClientTransport({
    command: "docker",
    args: [
      "run",
      "-i",
      "--rm",
      "--name",
      `azure-mcp-stdio-${process.pid}`,
      "-e", `AZURE_TENANT_ID=${config.AZURE_TENANT_ID}`,
      "-e", `AZURE_CLIENT_ID=${config.AZURE_CLIENT_ID}`,
      "-e", `AZURE_CLIENT_SECRET=${config.AZURE_CLIENT_SECRET}`,
      "-e", `AZURE_SUBSCRIPTION_ID=${config.AZURE_SUBSCRIPTION_ID}`,
      "-e", "AZURE_MCP_COLLECT_TELEMETRY=false",
      IMAGE,
      "--transport=stdio",
      // mode=namespace (the default) is much cheaper on tokens — ~63
      // namespace-level tools instead of ~319 individual operations.
      // For our flow (inspect via subscription_list/group_list/etc;
      // deploy via our custom deploy_bicep; destroy via destroy_azure)
      // the granular operations aren't needed and bloat every request
      // by ~130k cached tokens. See DECISIONS.md "Token cost".
      // Removed: --mode=all
    ],
    // The MCP server logs to stderr; surface it in the backend log so
    // we can see why something blew up without docker logs gymnastics.
    stderr: "pipe",
  });

  const client = new Client(
    { name: "azure-mcp-backend", version: "0.1.0" },
    { capabilities: {} }
  );

  // Wire stderr through so MCP server diagnostics appear in our logs.
  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[mcp-server] ${chunk.toString()}`);
  });

  await client.connect(transport);
  // eslint-disable-next-line no-console
  console.log("[mcp] connected to azure-mcp via stdio");
  return client;
}

/**
 * Closes the connection and lets the spawned MCP container exit.
 * Used during graceful backend shutdown.
 */
export async function closeMcpClient(): Promise<void> {
  if (!clientPromise) return;
  try {
    const c = await clientPromise;
    await c.close();
  } catch {
    // Best-effort on shutdown.
  } finally {
    clientPromise = null;
  }
}
