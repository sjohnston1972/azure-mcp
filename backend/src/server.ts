// Fastify entry point.
//
// Routes registered today (skeleton):
//   GET  /health        — docker healthcheck (always 200, no auth)
//   GET  /api/whoami    — echoes the asserted Cloudflare Access email
//   GET  /api/db/ping   — verifies Postgres is reachable
//
// More routes come in later build steps:
//   /api/mcp/tools, /api/chat (streaming), /api/projects, /api/deploy,
//   /api/templates, /api/history.

import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { trustedEmail } from "./plugins/trustedEmail.js";
import { mcpRoutes } from "./routes/mcp.js";
import { chatRoutes } from "./routes/chat.js";
import { projectRoutes } from "./routes/projects.js";
import { deploymentRoutes } from "./routes/deployments.js";
import { templateRoutes } from "./routes/templates.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { topologyRoutes } from "./routes/topologies.js";
import { azureRoutes } from "./routes/azure.js";
import { closeMcpClient } from "./mcp/client.js";
import { closeBicepMcpClient } from "./mcp/bicep-client.js";
import { migrate } from "./db/migrate.js";
import { reloadSchedules, shutdownScheduler } from "./scheduler/index.js";

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
  },
  // Default body limit is 1 MiB. The topology-sync endpoint accepts a
  // base64-encoded canvas screenshot (typically <500 KB encoded but
  // can be a couple MB on a busy canvas), so bump to 8 MiB here. The
  // route itself enforces a 5 MB cap on the decoded PNG.
  bodyLimit: 8 * 1024 * 1024,
});

// Same-origin in production (nginx serves frontend + proxies /api). CORS
// is permissive in dev so `vite dev` on a different port can call us.
await app.register(cors, {
  origin: process.env.NODE_ENV === "production" ? false : true,
});

await app.register(trustedEmail);
await app.register(mcpRoutes);
await app.register(chatRoutes);
await app.register(projectRoutes);
await app.register(deploymentRoutes);
await app.register(templateRoutes);
await app.register(scheduleRoutes);
await app.register(topologyRoutes);
await app.register(azureRoutes);

// Idempotent migrations + scheduler bootstrap. Migrations run BEFORE
// the cron loader so the schedules table is guaranteed to exist when
// reloadSchedules queries it.
await migrate();
await reloadSchedules(app);

// Clean up the MCP child process and cron tasks on shutdown so docker
// doesn't leak orphaned containers between restarts.
const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  shutdownScheduler();
  await closeMcpClient();
  await closeBicepMcpClient();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// ── Health (no auth) ──────────────────────────────────────────────
app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

// ── Whoami (proves auth header is flowing through) ────────────────
app.get("/api/whoami", async (req) => {
  const email = req.headers["cf-access-authenticated-user-email"] ?? null;
  return { email, expected: config.TRUSTED_USER_EMAIL };
});

// ── DB ping (proves Postgres is reachable + schema applied) ───────
app.get("/api/db/ping", async () => {
  const { rows } = await pool.query<{ now: string; project_count: number }>(
    "SELECT NOW() AS now, (SELECT COUNT(*) FROM projects)::int AS project_count"
  );
  return rows[0];
});

const port = config.PORT_BACKEND;
const host = "0.0.0.0";

try {
  await app.listen({ port, host });
  app.log.info(`azure-mcp-backend up on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
