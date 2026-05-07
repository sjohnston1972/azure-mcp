// /api/schedules — CRUD for cron-driven push/teardown of templates.
//
// On every create/update/delete we re-register the in-memory cron jobs
// so the change takes effect immediately (no backend restart needed).

import type { FastifyInstance } from "fastify";
import * as cron from "node-cron";
import { pool } from "../db/pool.js";
import { reloadSchedules } from "../scheduler/index.js";

export type ScheduleAction = "push" | "teardown";

export type ScheduleRow = {
  id: string;
  project_id: string;
  template_id: string | null;
  action: ScheduleAction;
  cron: string;
  enabled: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  next_run_at: string | null;
  created_at: string;
};

export async function scheduleRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { project_id?: string } }>(
    "/api/schedules",
    async (req) => {
      if (req.query.project_id) {
        const { rows } = await pool.query<ScheduleRow>(
          "SELECT * FROM schedules WHERE project_id = $1 ORDER BY created_at DESC",
          [req.query.project_id]
        );
        return rows;
      }
      const { rows } = await pool.query<ScheduleRow>(
        "SELECT * FROM schedules ORDER BY created_at DESC"
      );
      return rows;
    }
  );

  app.post<{
    Body: {
      project_id: string;
      template_id?: string;
      action: ScheduleAction;
      cron: string;
      enabled?: boolean;
    };
  }>("/api/schedules", async (req, reply) => {
    const b = req.body;
    if (!b?.project_id || !b?.action || !b?.cron) {
      return reply.code(400).send({
        error: "project_id, action, cron are required",
      });
    }
    if (b.action !== "push" && b.action !== "teardown") {
      return reply.code(400).send({ error: "action must be push or teardown" });
    }
    if (b.action === "push" && !b.template_id) {
      return reply.code(400).send({
        error: "template_id is required when action=push",
      });
    }
    if (!cron.validate(b.cron)) {
      return reply.code(400).send({
        error: `invalid cron expression: '${b.cron}'`,
      });
    }
    const { rows } = await pool.query<ScheduleRow>(
      `INSERT INTO schedules (project_id, template_id, action, cron, enabled)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        b.project_id,
        b.template_id ?? null,
        b.action,
        b.cron,
        b.enabled ?? true,
      ]
    );
    await reloadSchedules(app);
    return reply.code(201).send(rows[0]);
  });

  app.patch<{
    Params: { id: string };
    Body: { enabled?: boolean; cron?: string };
  }>("/api/schedules/:id", async (req, reply) => {
    const b = req.body ?? {};
    if (b.cron !== undefined && !cron.validate(b.cron)) {
      return reply.code(400).send({
        error: `invalid cron expression: '${b.cron}'`,
      });
    }
    const sets: string[] = [];
    const vals: unknown[] = [req.params.id];
    if (b.enabled !== undefined) {
      vals.push(b.enabled);
      sets.push(`enabled = $${vals.length}`);
    }
    if (b.cron !== undefined) {
      vals.push(b.cron);
      sets.push(`cron = $${vals.length}`);
    }
    if (sets.length === 0)
      return reply.code(400).send({ error: "no fields to update" });
    const { rows } = await pool.query<ScheduleRow>(
      `UPDATE schedules SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      vals
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    await reloadSchedules(app);
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>(
    "/api/schedules/:id",
    async (req, reply) => {
      const { rowCount } = await pool.query(
        "DELETE FROM schedules WHERE id = $1",
        [req.params.id]
      );
      if (rowCount === 0) return reply.code(404).send({ error: "not found" });
      await reloadSchedules(app);
      return reply.code(204).send();
    }
  );
}
