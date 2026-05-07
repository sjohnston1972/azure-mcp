// /api/projects — CRUD for the named workspaces. The project name
// becomes the `azure-mcp-project` Azure tag on every resource we deploy.

import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export async function projectRoutes(app: FastifyInstance) {
  // List projects, newest-first.
  app.get("/api/projects", async () => {
    const { rows } = await pool.query<ProjectRow>(
      "SELECT id, name, description, created_at, updated_at FROM projects ORDER BY updated_at DESC"
    );
    return rows;
  });

  // Get one project.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (req, reply) => {
      const { rows } = await pool.query<ProjectRow>(
        "SELECT id, name, description, created_at, updated_at FROM projects WHERE id = $1",
        [req.params.id]
      );
      if (rows.length === 0) return reply.code(404).send({ error: "not found" });
      return rows[0];
    }
  );

  // Create.
  app.post<{ Body: { name: string; description?: string } }>(
    "/api/projects",
    async (req, reply) => {
      const { name, description } = req.body ?? {};
      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return reply.code(400).send({ error: "name is required" });
      }
      // Project names go into Azure tags — restrict to characters that
      // are safe there. Azure tag names allow most printable chars but
      // the conservative subset is alphanumeric + dash/underscore.
      if (!/^[a-zA-Z0-9_-]{1,60}$/.test(name)) {
        return reply.code(400).send({
          error: "name must be 1–60 chars, alphanumeric + dash/underscore only",
        });
      }
      try {
        const { rows } = await pool.query<ProjectRow>(
          "INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id, name, description, created_at, updated_at",
          [name, description ?? null]
        );
        return reply.code(201).send(rows[0]);
      } catch (err) {
        // Duplicate name → 409.
        if ((err as { code?: string }).code === "23505") {
          return reply.code(409).send({ error: "project name already exists" });
        }
        throw err;
      }
    }
  );

  // Patch (description only — renaming a project after resources have
  // been tagged with the old name would orphan them).
  app.patch<{ Params: { id: string }; Body: { description?: string | null } }>(
    "/api/projects/:id",
    async (req, reply) => {
      const { rows } = await pool.query<ProjectRow>(
        "UPDATE projects SET description = $2 WHERE id = $1 RETURNING id, name, description, created_at, updated_at",
        [req.params.id, req.body?.description ?? null]
      );
      if (rows.length === 0) return reply.code(404).send({ error: "not found" });
      return rows[0];
    }
  );

  // Delete. Cascade removes deployments via FK ON DELETE CASCADE; the
  // Azure-side resources are NOT cleaned up — that's a deliberate v1
  // simplification. Resources stay tagged with the (now orphaned)
  // project name and can be cleaned up out-of-band.
  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (req, reply) => {
      const { rowCount } = await pool.query(
        "DELETE FROM projects WHERE id = $1",
        [req.params.id]
      );
      if (rowCount === 0) return reply.code(404).send({ error: "not found" });
      return reply.code(204).send();
    }
  );
}
