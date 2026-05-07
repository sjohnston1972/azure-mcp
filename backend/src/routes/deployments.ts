// /api/deployments — append-only deployment history.
//
// In v1 the actual deployment is performed by Claude calling MCP tools
// inside /api/chat. This endpoint is for the frontend to *record* a
// deployment after the chat turn ends, and to read the history back.

import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";

type DeploymentRow = {
  id: string;
  project_id: string;
  mode: string;
  prompt: string;
  bicep: string | null;
  tool_calls: unknown;
  status: string;
  error: string | null;
  created_at: string;
};

export async function deploymentRoutes(app: FastifyInstance) {
  // List deployments for a project (or all if no filter).
  app.get<{ Querystring: { project_id?: string; limit?: string } }>(
    "/api/deployments",
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? "50"), 200);
      if (req.query.project_id) {
        const { rows } = await pool.query<DeploymentRow>(
          "SELECT * FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2",
          [req.query.project_id, limit]
        );
        return rows;
      }
      const { rows } = await pool.query<DeploymentRow>(
        "SELECT * FROM deployments ORDER BY created_at DESC LIMIT $1",
        [limit]
      );
      return rows;
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/deployments/:id",
    async (req, reply) => {
      const { rows } = await pool.query<DeploymentRow>(
        "SELECT * FROM deployments WHERE id = $1",
        [req.params.id]
      );
      if (rows.length === 0) return reply.code(404).send({ error: "not found" });
      return rows[0];
    }
  );

  // Record a deployment outcome from the frontend (called after a chat
  // turn that resulted in an actual deployment).
  app.post<{
    Body: {
      project_id: string;
      mode: "bicep-reviewed" | "live-mcp";
      prompt: string;
      bicep?: string | null;
      tool_calls?: unknown;
      status: "pending" | "success" | "failed" | "partial";
      error?: string | null;
    };
  }>("/api/deployments", async (req, reply) => {
    const b = req.body;
    if (!b?.project_id || !b?.mode || !b?.prompt || !b?.status) {
      return reply.code(400).send({ error: "missing required fields" });
    }
    const { rows } = await pool.query<DeploymentRow>(
      `INSERT INTO deployments (project_id, mode, prompt, bicep, tool_calls, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        b.project_id,
        b.mode,
        b.prompt,
        b.bicep ?? null,
        b.tool_calls ? JSON.stringify(b.tool_calls) : null,
        b.status,
        b.error ?? null,
      ]
    );
    return reply.code(201).send(rows[0]);
  });
}
