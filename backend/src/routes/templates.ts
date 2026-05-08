// /api/templates — user-named Bicep snippets saved from prior deployments.

import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";

type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  bicep: string;
  topology: unknown;
  source_deployment_id: string | null;
  created_at: string;
};

const TEMPLATE_COLS =
  "id, name, description, bicep, topology, source_deployment_id, created_at";

export async function templateRoutes(app: FastifyInstance) {
  app.get("/api/templates", async () => {
    const { rows } = await pool.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLS} FROM templates ORDER BY created_at DESC`
    );
    return rows;
  });

  app.get<{ Params: { id: string } }>(
    "/api/templates/:id",
    async (req, reply) => {
      const { rows } = await pool.query<TemplateRow>(
        `SELECT ${TEMPLATE_COLS} FROM templates WHERE id = $1`,
        [req.params.id]
      );
      if (rows.length === 0) return reply.code(404).send({ error: "not found" });
      return rows[0];
    }
  );

  app.post<{
    Body: {
      name: string;
      description?: string;
      bicep: string;
      topology?: unknown;
      source_deployment_id?: string;
    };
  }>("/api/templates", async (req, reply) => {
    const b = req.body;
    if (!b?.name || !b?.bicep) {
      return reply.code(400).send({ error: "name and bicep are required" });
    }
    if (!/^[a-zA-Z0-9_ -]{1,80}$/.test(b.name)) {
      return reply.code(400).send({
        error: "name must be 1–80 chars, alphanumeric + space/dash/underscore",
      });
    }
    try {
      const { rows } = await pool.query<TemplateRow>(
        `INSERT INTO templates (name, description, bicep, topology, source_deployment_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${TEMPLATE_COLS}`,
        [
          b.name,
          b.description ?? null,
          b.bicep,
          // jsonb column — null when caller didn't capture a canvas.
          b.topology ? JSON.stringify(b.topology) : null,
          b.source_deployment_id ?? null,
        ]
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "template name already exists" });
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/templates/:id",
    async (req, reply) => {
      const { rowCount } = await pool.query(
        "DELETE FROM templates WHERE id = $1",
        [req.params.id]
      );
      if (rowCount === 0) return reply.code(404).send({ error: "not found" });
      return reply.code(204).send();
    }
  );
}
