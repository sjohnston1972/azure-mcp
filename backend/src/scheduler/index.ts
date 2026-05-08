// In-process cron scheduler. On startup we read the schedules table
// and register one cron task per enabled row. When a task fires it
// runs the chat loop non-streaming with the appropriate stage prompt
// (push or teardown). Outcomes get written back to the schedule's
// last_run_* fields and to the deployments table.
//
// The hybrid execution model (per DECISIONS.md): both user-driven and
// scheduled push/teardown go through Claude — only difference is the
// scheduler runs headless (no SSE consumer) and the user-driven path
// streams to the UI.

import * as cron from "node-cron";
import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/pool.js";
import { anthropic } from "../claude/client.js";
import { SYSTEM_PROMPT } from "../claude/system-prompt.js";
import { callMcpTool, getClaudeTools } from "../claude/tool-bridge.js";
import { config } from "../config.js";

type ScheduleRow = {
  id: string;
  project_id: string;
  template_id: string | null;
  action: "push" | "teardown";
  cron: string;
  enabled: boolean;
};

type ProjectRow = { id: string; name: string; description: string | null };
type TemplateRow = { id: string; name: string; bicep: string };

const tasks = new Map<string, cron.ScheduledTask>();

const MAX_TURNS = 25;

function stageGuard(action: "push" | "teardown"): string {
  if (action === "push") {
    return "## Active stage: PUSH (scheduled)\n\nDeploy the architecture described by the Bicep below. Tag every resource with `azure-mcp-project=<project name>`. Emit an updated `<topology>` marker reflecting actual outcome.";
  }
  return "## Active stage: TEAR-DOWN (scheduled)\n\nDelete every Azure resource tagged with `azure-mcp-project=<project name>`. Typically: list resource groups carrying that tag and delete each (cascades). After teardown, emit `<topology>{\"nodes\":[],\"edges\":[]}</topology>`.";
}

async function runScheduleOnce(
  app: FastifyInstance,
  schedule: ScheduleRow
): Promise<{ ok: boolean; error?: string }> {
  const startedAt = new Date();
  app.log.info({ schedule_id: schedule.id, action: schedule.action }, "[scheduler] firing");

  // Look up project + (for push) the template's Bicep.
  const projRes = await pool.query<ProjectRow>(
    "SELECT id, name, description FROM projects WHERE id = $1",
    [schedule.project_id]
  );
  const project = projRes.rows[0];
  if (!project) {
    return { ok: false, error: `project ${schedule.project_id} not found` };
  }

  let templateBicep: string | null = null;
  if (schedule.action === "push") {
    if (!schedule.template_id) {
      return { ok: false, error: "push schedule has no template_id" };
    }
    const tmplRes = await pool.query<TemplateRow>(
      "SELECT id, name, bicep FROM templates WHERE id = $1",
      [schedule.template_id]
    );
    const tmpl = tmplRes.rows[0];
    if (!tmpl) {
      return { ok: false, error: `template ${schedule.template_id} not found` };
    }
    templateBicep = tmpl.bicep;
  }

  // Build the user-turn message.
  const userMessage =
    schedule.action === "push"
      ? `Deploy this Bicep template now to project '${project.name}'. Tag every resource with azure-mcp-project=${project.name}. Bicep:\n\n\`\`\`bicep\n${templateBicep}\n\`\`\``
      : `Tear down all Azure resources tagged with azure-mcp-project=${project.name}. Find them via the MCP tools and delete them.`;

  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: stageGuard(schedule.action) },
    {
      type: "text",
      text: `## Active project\n\nThe scheduler is running on behalf of project '${project.name}'.\nTag every Azure resource with azure-mcp-project=${project.name}.`,
    },
  ];

  // Scheduler only runs Azure templates today (templates table doesn't
  // carry a cloud field). Hardcoded — if/when AWS templates get
  // scheduling, look up cloud from the saved template's source.
  const tools = await getClaudeTools("azure");
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];
  const toolCallTrail: unknown[] = [];

  // Run the agentic loop synchronously (no streaming).
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await anthropic.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 16000,
      system: systemBlocks,
      tools,
      messages,
    });

    if (resp.stop_reason === "end_turn" || resp.stop_reason === "stop_sequence") {
      break;
    }

    if (resp.stop_reason === "max_tokens") {
      return { ok: false, error: "Claude hit max_tokens during scheduled run" };
    }

    if (resp.stop_reason !== "tool_use") {
      return {
        ok: false,
        error: `unexpected stop_reason: ${resp.stop_reason}`,
      };
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const r = await callMcpTool(t.name, t.input);
      toolCallTrail.push({
        name: t.name,
        input: t.input,
        is_error: r.is_error,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: t.id,
        content: r.content,
        is_error: r.is_error,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Record a deployment row for the audit trail.
  const status = "success";
  await pool.query(
    `INSERT INTO deployments (project_id, mode, prompt, bicep, tool_calls, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      project.id,
      schedule.action === "push" ? "live-mcp" : "live-mcp",
      `[scheduled ${schedule.action}] ${userMessage.slice(0, 500)}`,
      templateBicep,
      JSON.stringify(toolCallTrail),
      status,
      null,
    ]
  );

  void startedAt;
  return { ok: true };
}

/**
 * Wraps runScheduleOnce with bookkeeping (last_run_* fields) and error
 * capture so a single bad run doesn't crash the cron task.
 */
async function safeFire(app: FastifyInstance, scheduleId: string): Promise<void> {
  try {
    const { rows } = await pool.query<ScheduleRow>(
      "SELECT id, project_id, template_id, action, cron, enabled FROM schedules WHERE id = $1",
      [scheduleId]
    );
    const s = rows[0];
    if (!s || !s.enabled) return; // Got disabled mid-flight.

    const result = await runScheduleOnce(app, s);
    await pool.query(
      `UPDATE schedules SET last_run_at = NOW(),
         last_run_status = $2, last_run_error = $3
       WHERE id = $1`,
      [scheduleId, result.ok ? "success" : "failed", result.error ?? null]
    );
    app.log.info(
      { schedule_id: scheduleId, ok: result.ok, error: result.error },
      "[scheduler] done"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    app.log.error({ schedule_id: scheduleId, err }, "[scheduler] crashed");
    try {
      await pool.query(
        `UPDATE schedules SET last_run_at = NOW(),
           last_run_status = 'crashed', last_run_error = $2
         WHERE id = $1`,
        [scheduleId, msg]
      );
    } catch {
      // pool gone — ignore.
    }
  }
}

/** Drop every registered cron task. Called before reload. */
function clearTasks() {
  for (const [, t] of tasks) {
    try {
      t.stop();
    } catch {}
  }
  tasks.clear();
}

/** Load enabled schedules from the DB and register them with node-cron.
 *  Idempotent: clears and re-registers all tasks. */
export async function reloadSchedules(app: FastifyInstance): Promise<void> {
  clearTasks();
  const { rows } = await pool.query<ScheduleRow>(
    "SELECT id, project_id, template_id, action, cron, enabled FROM schedules WHERE enabled = TRUE"
  );
  for (const s of rows) {
    if (!cron.validate(s.cron)) {
      app.log.warn({ schedule_id: s.id, cron: s.cron }, "[scheduler] invalid cron, skipping");
      continue;
    }
    const task = cron.schedule(
      s.cron,
      () => void safeFire(app, s.id),
      { timezone: "UTC" }
    );
    tasks.set(s.id, task);
    app.log.info(
      { schedule_id: s.id, cron: s.cron, action: s.action },
      "[scheduler] registered"
    );
  }
  app.log.info(`[scheduler] ${rows.length} active schedule(s) registered`);
}

export function shutdownScheduler(): void {
  clearTasks();
}
