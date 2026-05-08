// POST /api/chat — streaming chat endpoint.
//
// Wire shape (Server-Sent Events on the response):
//   event: text         data: {"delta": "..."}
//   event: tool_use     data: {"id":"...","name":"...","input":{...}}
//   event: tool_result  data: {"id":"...","is_error":false}
//   event: error        data: {"message":"..."}
//   event: done         data: {"stop_reason":"end_turn"}
//
// Request body:
//   {
//     "messages": Anthropic.MessageParam[],   // full conversation so far
//     "project_id"?: string                    // for tagging future deploys
//   }
//
// The agentic tool-use loop runs server-side: when Claude requests an
// Azure tool we forward the call to the MCP server, feed the result
// back, and continue streaming. The frontend only sees a single SSE
// stream containing text deltas plus tool-use markers.

import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../claude/client.js";
import {
  SYSTEM_PROMPT,
  systemPromptFor,
  type Cloud,
} from "../claude/system-prompt.js";
import { callMcpTool, getClaudeTools } from "../claude/tool-bridge.js";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

type ChatStage = "build" | "view" | "push" | "teardown" | "free";

type ChatBody = {
  messages: Anthropic.MessageParam[];
  project_id?: string;
  /** Active topology id. When set, Claude tags resources with both
   *  azure-mcp-project AND azure-mcp-topology-id, and per-topology
   *  destroy filters by both tags. */
  topology_id?: string;
  /** Lifecycle stage. Defaults to "build". */
  stage?: ChatStage;
};

const STAGE_GUARD: Record<ChatStage, string> = {
  build:
    "## Active stage: BUILD\n\nThe user is designing — propose only. Do NOT call any mutating Azure MCP tools. End your response with `<topology>{...}</topology>` and `<bicep>...</bicep>` markers describing what you're proposing.",
  view:
    "## Active stage: VIEW\n\nThe user is reviewing the design. Same rules as BUILD — no mutations. If they ask for changes, refresh the topology and bicep markers.",
  push:
    "## Active stage: PUSH\n\nDeploy the architecture you previously designed. Use Azure MCP tools to execute the Bicep, or call the underlying create/deploy tools directly. Tag every resource with `azure-mcp-project=<project name>`. After the deployment finishes, emit an updated `<topology>` marker with `status` reflecting actual outcomes (`success` or `failed`).",
  teardown:
    "## Active stage: TEAR-DOWN\n\nDelete the targeted Azure resources. Find them via MCP tag-query tools and remove them. Typically the cleanest path is to delete the resource group(s) carrying the matching tag(s), since deletion cascades. After teardown, emit `<topology>{\"nodes\":[],\"edges\":[]}</topology>`. The active project block tells you whether this is a project-wide tear-down (filter by `azure-mcp-project` only) or a per-topology destroy (filter by BOTH `azure-mcp-project` AND `azure-mcp-topology-id`).",
  free:
    "## Active stage: FREE\n\nThe user is asking an ad-hoc question outside the build/push lifecycle. Default to read-only — only mutate Azure if they explicitly ask. Topology and Bicep markers are not required.",
};

// Maximum number of agentic loop turns. Stops a runaway tool spiral.
const MAX_TURNS = 25;

// Cap the tool-result content preview pushed over SSE to the browser.
// The FULL result still goes back to Claude — this just keeps the UI
// payload manageable. ~6 KB fits long BCP error lists comfortably.
const TOOL_RESULT_PREVIEW_LIMIT = 6000;

function previewToolContent(
  content: string | Anthropic.ToolResultBlockParam["content"]
): string {
  if (typeof content === "string") {
    return content.length > TOOL_RESULT_PREVIEW_LIMIT
      ? content.slice(0, TOOL_RESULT_PREVIEW_LIMIT) + "\n…[truncated]"
      : content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b) {
          return (b as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return text.length > TOOL_RESULT_PREVIEW_LIMIT
      ? text.slice(0, TOOL_RESULT_PREVIEW_LIMIT) + "\n…[truncated]"
      : text;
  }
  return "";
}

// Anthropic SDK call timeout — single API turn (one streamed response
// from Claude). Hub-and-spoke planning + Bicep generation is the
// largest case we've seen; 5 minutes is generous.
const ANTHROPIC_TIMEOUT_MS = 5 * 60 * 1000;

// Hard ceiling on the entire chat loop (all turns + all tool calls).
// deploy_bicep and destroy_azure can take several minutes each.
const TOTAL_TURN_TIMEOUT_MS = 30 * 60 * 1000;

// SSE keepalive interval — empty comment lines that nginx / browsers
// won't time out on. SSE comments (lines starting with `:`) are
// silently ignored by parsers.
const KEEPALIVE_MS = 15_000;

export async function chatRoutes(app: FastifyInstance) {
  app.post<{ Body: ChatBody }>("/api/chat", async (req, reply) => {
    const body = req.body;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send({ error: "body.messages must be a non-empty array" });
    }

    // ── SSE setup ────────────────────────────────────────────────
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering for the streaming proxy
    });

    const sse = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // ── Keepalive heartbeat ──────────────────────────────────────
    // SSE comments (lines starting with `:`) are silently ignored by
    // parsers but keep nginx, Cloudflare, and the browser fetch alive
    // during long quiet periods (e.g. while deploy_bicep is running
    // a 2-3 minute az deployment). Without this, intermediate proxies
    // can drop the connection and the user sees a cryptic "Error in
    // input stream".
    const keepalive = setInterval(() => {
      try {
        reply.raw.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        /* connection already gone */
      }
    }, KEEPALIVE_MS);

    // ── Hard total-turn timeout ──────────────────────────────────
    // If the loop hangs (Anthropic SDK stuck, MCP child wedged,
    // anything else), forcibly abort after TOTAL_TURN_TIMEOUT_MS so
    // the request finishes with a clear error rather than sitting
    // forever and accumulating dead handlers.
    const turnAbort = new AbortController();
    const turnTimeout = setTimeout(() => {
      app.log.error(
        { request_url: req.url },
        `[chat] hard timeout after ${TOTAL_TURN_TIMEOUT_MS}ms — aborting`
      );
      turnAbort.abort();
    }, TOTAL_TURN_TIMEOUT_MS);

    // Clean up both timers no matter how the request ends.
    const cleanup = () => {
      clearInterval(keepalive);
      clearTimeout(turnTimeout);
    };
    reply.raw.on("close", cleanup);
    reply.raw.on("finish", cleanup);

    // Local mutable copy of the conversation; we append assistant turns
    // and tool-result user turns as the agentic loop progresses.
    const messages: Anthropic.MessageParam[] = [...body.messages];

    // Look up project's cloud first so we can pick BOTH the right
    // system prompt AND the right MCP tool set. Each cloud has its
    // own frozen prompt + cached tool list — they're independent,
    // so flipping clouds in the toggle doesn't pollute the other
    // cloud's prompt cache. Default to azure when no project.
    let projectCloud: Cloud = "azure";
    if (body.project_id) {
      try {
        const { rows } = await pool.query<{ cloud: Cloud }>(
          "SELECT cloud FROM projects WHERE id = $1",
          [body.project_id]
        );
        if (rows[0]?.cloud) projectCloud = rows[0].cloud;
      } catch {
        // ignore — fall back to azure default
      }
    }

    let tools: Anthropic.Tool[];
    try {
      tools = await getClaudeTools(projectCloud);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sse("error", { message: `failed to load MCP tools: ${message}` });
      reply.raw.end();
      return reply;
    }

    // Cache breakpoint goes on the FIRST system block (tools render
    // before system, so this caches both tools and system together).
    // The per-project context goes in a SECOND system block AFTER the
    // breakpoint — so changing project doesn't invalidate the cached
    // prefix (tools + frozen system prompt), only the small tail.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: systemPromptFor(projectCloud),
        cache_control: { type: "ephemeral" },
      },
    ];

    // Per-request stage guard. Goes after the cache breakpoint so
    // changing stage doesn't invalidate the cached prefix.
    const stage: ChatStage = body.stage ?? "build";
    systemBlocks.push({ type: "text", text: STAGE_GUARD[stage] });

    if (body.project_id) {
      try {
        const { rows } = await pool.query<{ name: string; description: string | null }>(
          "SELECT name, description FROM projects WHERE id = $1",
          [body.project_id]
        );
        if (rows.length > 0) {
          const p = rows[0];
          if (p) {
            const teardownNote =
              stage === "teardown"
                ? body.topology_id
                  ? `\n**This is a per-topology destroy.** Call \`destroy_azure\` with \`tag_filters: { "mcp-project": "${p.name}", "mcp-topology-id": "${body.topology_id}" }\`. Do NOT delete resources that lack the mcp-topology-id tag — they belong to other topologies in this project.\n`
                  : `\n**This is a project-wide tear-down.** Call \`destroy_azure\` with \`tag_filters: { "mcp-project": "${p.name}" }\`.\n`
                : "";
            systemBlocks.push({
              type: "text",
              text:
                `## Active project\n\n` +
                `The user is currently working in project '${p.name}'.\n` +
                (p.description ? `\nProject description: ${p.description}\n\n` : "\n") +
                `**Critical: tag every Azure resource with the EXACT tag NAMES below — verbatim. The destroy / scheduler tools query by these exact key strings, and a mismatch leaves orphan resources that won't be cleaned up.**\n\n` +
                `Required tags on every deployed resource:\n` +
                "```\n" +
                `mcp-project        = ${p.name}\n` +
                (body.topology_id
                  ? `mcp-topology-id    = ${body.topology_id}\n`
                  : "") +
                `mcp-deployment-id  = <a UUID you generate per deployment>\n` +
                `mcp-deployed-at    = <UTC ISO-8601 timestamp at deploy time>\n` +
                "```\n\n" +
                `Notes on tag naming:\n` +
                `- Use the \`mcp-\` prefix (NOT \`azure-mcp-\`). Some Azure resource providers reject the \`azure-\` prefix on user tags — this scheme is the one verified to work across resource types.\n` +
                `- In Bicep, prefer setting these as a single \`tags\` object on the resource group; child resources inherit it.\n` +
                `- Do NOT invent shorter, longer, or alternative tag keys.\n` +
                teardownNote,
            });
          }
        }
      } catch (err) {
        app.log.warn({ err }, "failed to load project for chat");
      }
    }

    try {
      let stopReason: Anthropic.Message["stop_reason"] = null;

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (turnAbort.signal.aborted) {
          sse("error", {
            message: `Chat turn aborted after ${TOTAL_TURN_TIMEOUT_MS / 1000}s — see backend logs.`,
          });
          break;
        }

        // Per-call abort so a single Anthropic stream that wedges
        // (rare but observed) doesn't take down the whole turn.
        const callAbort = new AbortController();
        const callTimeout = setTimeout(
          () => callAbort.abort(),
          ANTHROPIC_TIMEOUT_MS
        );
        // Bridge the parent abort so a hard timeout aborts mid-call.
        const onParentAbort = () => callAbort.abort();
        turnAbort.signal.addEventListener("abort", onParentAbort, {
          once: true,
        });

        const stream = anthropic.messages.stream(
          {
            model: config.ANTHROPIC_MODEL,
            max_tokens: 16000,
            system: systemBlocks,
            tools,
            messages,
          },
          { signal: callAbort.signal }
        );

        // Forward text deltas to the client as they arrive.
        stream.on("text", (delta) => sse("text", { delta }));

        let message;
        try {
          message = await stream.finalMessage();
        } finally {
          clearTimeout(callTimeout);
          turnAbort.signal.removeEventListener("abort", onParentAbort);
        }
        stopReason = message.stop_reason;

        if (stopReason === "end_turn" || stopReason === "stop_sequence") {
          break;
        }

        if (stopReason === "max_tokens") {
          sse("error", {
            message:
              "Claude hit max_tokens mid-response. Increase max_tokens or split the request.",
          });
          break;
        }

        if (stopReason !== "tool_use") {
          // Anything we don't explicitly handle (refusal, pause_turn,
          // null) — surface as an error and stop the loop. The SDK's
          // type widens to `string | null` over time as the API adds
          // new stop_reason values, so we treat anything unfamiliar
          // as a non-recoverable end.
          sse("error", { message: `unexpected stop_reason: ${stopReason}` });
          break;
        }

        // ── Tool-use turn: dispatch each requested tool to MCP ────
        messages.push({ role: "assistant", content: message.content });

        const toolUses = message.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );

        // Dispatch tools sequentially to keep MCP stdio happy and to
        // give the user a readable progress trail in the SSE stream.
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const t of toolUses) {
          sse("tool_use", { id: t.id, name: t.name, input: t.input });
          const r = await callMcpTool(t.name, t.input);

          // Send a content preview to the frontend so the user can
          // expand the tool block and see what actually came back.
          // Truncate to keep SSE payloads sane; the FULL content still
          // goes to Claude via toolResults below.
          const preview = previewToolContent(r.content);
          sse("tool_result", {
            id: t.id,
            is_error: r.is_error,
            content_preview: preview,
          });

          // Also log failures to backend stdout so `docker compose logs`
          // shows the BCP errors / az output without needing the chat UI.
          if (r.is_error) {
            app.log.warn(
              { tool: t.name, preview: preview.slice(0, 1500) },
              `[chat] tool '${t.name}' returned is_error`
            );
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: t.id,
            content: r.content,
            is_error: r.is_error,
          });
        }

        messages.push({ role: "user", content: toolResults });
      }

      sse("done", { stop_reason: stopReason });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = turnAbort.signal.aborted
        ? `Hard timeout (${TOTAL_TURN_TIMEOUT_MS / 1000}s) — ${message}`
        : message;
      app.log.error({ err }, "chat loop failed");
      sse("error", { message: detail });
    } finally {
      cleanup();
      try {
        reply.raw.end();
      } catch {
        /* connection may already be closed */
      }
    }

    return reply;
  });
}
