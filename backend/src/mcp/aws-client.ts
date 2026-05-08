// ── AWS MCP client (stdio transport) ──────────────────────────────
//
// Mirror of mcp/client.ts but talks to AWS Labs' aws-api-mcp-server
// instead of Microsoft's Azure MCP. Same singleton + lazy-connect
// pattern; same docker-as-stdio-source spawn shape. Auth via the
// host's mounted ~/.aws (SSO session) — exactly the same path
// the aws-cli sidecar uses for deploys, so the user only has to
// `aws sso login` once.
//
// We connect lazily and only when the active project is an AWS
// project. Azure-only sessions never spin this up.
//
// Why stdio (not HTTP) — same reasoning as the Azure side: the
// transport is unauthenticated by default on http and the auth-
// disable flag is unreliable. stdio sidesteps all of it.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const IMAGE = process.env.AWS_MCP_IMAGE ?? "azure-mcp-aws-mcp:latest";

// AWS auth — same dual-path setup as custom-tools.ts:
//   1. Long-lived IAM access keys (preferred — homelab default).
//   2. Mounted ~/.aws (SSO session) — fallback.
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "";
const AWS_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN ?? "";
const AWS_HOST_CONFIG_PATH = process.env.AWS_HOST_CONFIG_PATH ?? "";
const AWS_DEFAULT_REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const AWS_PROFILE = process.env.AWS_PROFILE ?? "";

const HAS_KEYS = Boolean(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY);
const HAS_SSO = Boolean(AWS_HOST_CONFIG_PATH);

let clientPromise: Promise<Client> | null = null;

/**
 * Returns the singleton AWS MCP client, connecting on first call.
 * Subsequent callers share the same connection. If the connection
 * is ever lost, the next call rebuilds it.
 */
export function getAwsMcpClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function connect(): Promise<Client> {
  if (!HAS_KEYS && !HAS_SSO) {
    throw new Error(
      "AWS auth not configured — set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY " +
        "(or AWS_HOST_CONFIG_PATH for SSO) in the backend's .env then restart."
    );
  }

  const dockerArgs = [
    "run",
    "-i",
    "--rm",
    "--name",
    `aws-mcp-stdio-${process.pid}`,
  ];
  // Auth path 1: pass access keys via env. Takes precedence when set.
  if (HAS_KEYS) {
    dockerArgs.push("-e", `AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}`);
    dockerArgs.push("-e", `AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}`);
    if (AWS_SESSION_TOKEN) {
      dockerArgs.push("-e", `AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN}`);
    }
  } else {
    // Auth path 2: mount ~/.aws for SSO sessions.
    dockerArgs.push("-v", `${AWS_HOST_CONFIG_PATH}:/root/.aws:ro`);
    if (AWS_PROFILE) {
      dockerArgs.push("-e", `AWS_PROFILE=${AWS_PROFILE}`);
    }
  }
  dockerArgs.push(
    "-e",
    `AWS_REGION=${AWS_DEFAULT_REGION}`,
    "-e",
    `AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION}`
  );
  dockerArgs.push(IMAGE);

  const transport = new StdioClientTransport({
    command: "docker",
    args: dockerArgs,
    stderr: "pipe",
  });

  const client = new Client(
    { name: "azure-mcp-backend-aws", version: "0.1.0" },
    { capabilities: {} }
  );

  // Surface MCP server diagnostics in the backend log.
  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[aws-mcp-server] ${chunk.toString()}`);
  });

  await client.connect(transport);
  // eslint-disable-next-line no-console
  console.log("[mcp] connected to aws-mcp via stdio");
  return client;
}

/**
 * Closes the connection and lets the spawned MCP container exit.
 * Used during graceful backend shutdown.
 */
export async function closeAwsMcpClient(): Promise<void> {
  if (!clientPromise) return;
  try {
    const c = await clientPromise;
    await c.close();
  } catch {
    /* best-effort on shutdown */
  } finally {
    clientPromise = null;
  }
}
