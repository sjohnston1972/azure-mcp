// /api/topologies — CRUD for per-project topologies.
//
// A topology has a status: draft (designed, not pushed), live
// (successfully pushed and resources tagged in Azure), or destroyed
// (was live, Azure resources have been torn down). Modifications
// (chat-driven topology updates) are PATCHed in place.

import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";

type Status = "draft" | "live" | "failed" | "destroyed";

type TopologyRow = {
  id: string;
  project_id: string;
  name: string;
  status: Status;
  topology: unknown;
  bicep: string | null;
  pushed_at: string | null;
  destroyed_at: string | null;
  pushed_deployment_id: string | null;
  created_at: string;
  updated_at: string;
};

export async function topologyRoutes(app: FastifyInstance) {
  // List topologies for a project.
  app.get<{ Querystring: { project_id?: string } }>(
    "/api/topologies",
    async (req, reply) => {
      if (!req.query.project_id) {
        return reply.code(400).send({ error: "project_id is required" });
      }
      const { rows } = await pool.query<TopologyRow>(
        `SELECT * FROM topologies
         WHERE project_id = $1
         ORDER BY updated_at DESC`,
        [req.query.project_id]
      );
      return rows;
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/topologies/:id",
    async (req, reply) => {
      const { rows } = await pool.query<TopologyRow>(
        "SELECT * FROM topologies WHERE id = $1",
        [req.params.id]
      );
      if (rows.length === 0) return reply.code(404).send({ error: "not found" });
      return rows[0];
    }
  );

  // Create — typically a "new build" starts here.
  app.post<{
    Body: {
      project_id: string;
      name?: string;
      topology?: unknown;
      bicep?: string;
    };
  }>("/api/topologies", async (req, reply) => {
    const b = req.body;
    if (!b?.project_id) {
      return reply.code(400).send({ error: "project_id is required" });
    }
    // Auto-name as "untitled-N" where N is one more than the current
    // count for this project, so users can rename later but always
    // see something useful.
    let name = b.name?.trim();
    if (!name) {
      const { rows } = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM topologies WHERE project_id = $1",
        [b.project_id]
      );
      const count = Number(rows[0]?.count ?? 0);
      name = `untitled-${count + 1}`;
    }
    const { rows } = await pool.query<TopologyRow>(
      `INSERT INTO topologies (project_id, name, topology, bicep)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        b.project_id,
        name,
        b.topology ? JSON.stringify(b.topology) : null,
        b.bicep ?? null,
      ]
    );
    return reply.code(201).send(rows[0]);
  });

  // Patch — used to update topology JSON / bicep mid-design, rename,
  // or transition status (push → live, destroy → destroyed).
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      status?: Status;
      topology?: unknown;
      bicep?: string | null;
      pushed_deployment_id?: string;
    };
  }>("/api/topologies/:id", async (req, reply) => {
    const b = req.body ?? {};
    const sets: string[] = [];
    const vals: unknown[] = [req.params.id];
    if (b.name !== undefined) {
      vals.push(b.name);
      sets.push(`name = $${vals.length}`);
    }
    if (b.status !== undefined) {
      if (!["draft", "live", "failed", "destroyed"].includes(b.status)) {
        return reply.code(400).send({ error: "invalid status" });
      }
      vals.push(b.status);
      sets.push(`status = $${vals.length}`);
      if (b.status === "live") sets.push(`pushed_at = NOW()`);
      if (b.status === "destroyed") sets.push(`destroyed_at = NOW()`);
    }
    if (b.topology !== undefined) {
      vals.push(JSON.stringify(b.topology));
      sets.push(`topology = $${vals.length}`);
    }
    if (b.bicep !== undefined) {
      vals.push(b.bicep);
      sets.push(`bicep = $${vals.length}`);
    }
    if (b.pushed_deployment_id !== undefined) {
      vals.push(b.pushed_deployment_id);
      sets.push(`pushed_deployment_id = $${vals.length}`);
    }
    if (sets.length === 0)
      return reply.code(400).send({ error: "no fields to update" });
    const { rows } = await pool.query<TopologyRow>(
      `UPDATE topologies SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      vals
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    return rows[0];
  });

  // Delete = remove the record only. Azure resources, if live, stay.
  app.delete<{ Params: { id: string } }>(
    "/api/topologies/:id",
    async (req, reply) => {
      const { rowCount } = await pool.query(
        "DELETE FROM topologies WHERE id = $1",
        [req.params.id]
      );
      if (rowCount === 0) return reply.code(404).send({ error: "not found" });
      return reply.code(204).send();
    }
  );
}
