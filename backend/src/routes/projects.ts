// /api/projects — CRUD for the named workspaces. The project name
// becomes the `azure-mcp-project` Azure tag on every resource we deploy.

import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import {
  ensureRepo,
  isGitHubConfigured,
  putFile,
  repoNameForProject,
  GitHubError,
} from "../lib/github.js";

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  github_repo: string | null;
  github_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

const PROJECT_COLS =
  "id, name, description, github_repo, github_synced_at, created_at, updated_at";

export async function projectRoutes(app: FastifyInstance) {
  // List projects, newest-first.
  app.get("/api/projects", async () => {
    const { rows } = await pool.query<ProjectRow>(
      `SELECT ${PROJECT_COLS} FROM projects ORDER BY updated_at DESC`
    );
    return rows;
  });

  // Get one project.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (req, reply) => {
      const { rows } = await pool.query<ProjectRow>(
        `SELECT ${PROJECT_COLS} FROM projects WHERE id = $1`,
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
          `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING ${PROJECT_COLS}`,
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
        `UPDATE projects SET description = $2 WHERE id = $1 RETURNING ${PROJECT_COLS}`,
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

  // ── GitHub config + sync ──────────────────────────────────────────
  // Tells the frontend whether the GitHub feature is even available
  // (i.e. GH_TOKEN + GH_OWNER are configured in the env).
  app.get("/api/github/status", async () => ({
    configured: isGitHubConfigured(),
    owner: config.GH_OWNER || null,
    visibility: config.GH_REPO_VISIBILITY,
  }));

  // Push a project to GitHub: ensure the repo exists, write a README
  // and one .bicep file per topology, update github_repo +
  // github_synced_at on the project.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/github/push",
    async (req, reply) => {
      if (!isGitHubConfigured()) {
        return reply.code(400).send({
          error: "GitHub is not configured (set GH_TOKEN and GH_OWNER in .env)",
        });
      }

      const projRes = await pool.query<ProjectRow>(
        `SELECT ${PROJECT_COLS} FROM projects WHERE id = $1`,
        [req.params.id]
      );
      const project = projRes.rows[0];
      if (!project) return reply.code(404).send({ error: "project not found" });

      const topoRes = await pool.query<{
        id: string;
        name: string;
        status: string;
        bicep: string | null;
        topology: unknown;
        pushed_at: string | null;
        destroyed_at: string | null;
      }>(
        `SELECT id, name, status, bicep, topology, pushed_at, destroyed_at
         FROM topologies WHERE project_id = $1 ORDER BY updated_at DESC`,
        [project.id]
      );
      const topologies = topoRes.rows;

      // If the project has been synced before, keep the same repo name
      // (the user may have starred / forked / pinned it). For first-time
      // syncs, generate a fresh name with the project UUID short suffix
      // so two projects with the same display name don't collide.
      let repoName: string;
      if (project.github_repo) {
        const slash = project.github_repo.indexOf("/");
        repoName =
          slash >= 0 ? project.github_repo.slice(slash + 1) : project.github_repo;
      } else {
        repoName = repoNameForProject(project.name, project.id);
      }
      const owner = config.GH_OWNER;

      try {
        const { default_branch, created } = await ensureRepo({
          owner,
          name: repoName,
          description: project.description ?? `azure-mcp project '${project.name}'`,
          isPrivate: config.GH_REPO_VISIBILITY === "private",
        });

        // README — generated, lists topologies + status.
        const readme = renderReadme(project.name, project.description, topologies);
        await putFile({
          owner,
          repo: repoName,
          path: "README.md",
          content: readme,
          message: `azure-mcp: sync project '${project.name}'`,
          branch: default_branch,
        });

        // One .bicep per topology that has a template. Sanitised
        // filename so weird names don't break the path.
        let bicepCount = 0;
        for (const t of topologies) {
          if (!t.bicep) continue;
          const safeName = t.name
            .replace(/[^a-zA-Z0-9_.-]/g, "-")
            .slice(0, 80);
          await putFile({
            owner,
            repo: repoName,
            path: `topologies/${safeName}.bicep`,
            content: t.bicep,
            message: `azure-mcp: sync topology '${t.name}' (${t.status})`,
            branch: default_branch,
          });
          bicepCount++;
        }

        // Persist the new state.
        const githubRepo = `${owner}/${repoName}`;
        await pool.query(
          `UPDATE projects SET github_repo = $2, github_synced_at = NOW() WHERE id = $1`,
          [project.id, githubRepo]
        );
        const updated = await pool.query<ProjectRow>(
          `SELECT ${PROJECT_COLS} FROM projects WHERE id = $1`,
          [project.id]
        );

        return {
          ok: true,
          repo: githubRepo,
          repo_url: `https://github.com/${githubRepo}`,
          repo_was_created: created,
          topologies_synced: bicepCount,
          project: updated.rows[0],
        };
      } catch (err) {
        if (err instanceof GitHubError) {
          return reply.code(502).send({
            error: "github sync failed",
            status: err.status,
            detail: err.body.slice(0, 1000),
          });
        }
        throw err;
      }
    }
  );
}

function renderReadme(
  name: string,
  description: string | null,
  topologies: ReadonlyArray<{
    name: string;
    status: string;
    pushed_at: string | null;
    destroyed_at: string | null;
  }>
): string {
  const lines: string[] = [
    `# ${name}`,
    "",
    description ? `> ${description}\n` : "",
    `_Synced from [azure-mcp](https://github.com/sjohnston1972/azure-mcp) on ${new Date().toISOString()}._`,
    "",
    "## Topologies",
    "",
  ];
  if (topologies.length === 0) {
    lines.push("_No topologies designed yet._");
  } else {
    lines.push("| Name | Status | Pushed | Destroyed |");
    lines.push("|---|---|---|---|");
    for (const t of topologies) {
      const file = `topologies/${t.name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80)}.bicep`;
      lines.push(
        `| [\`${t.name}\`](${file}) | \`${t.status}\` | ${t.pushed_at ? new Date(t.pushed_at).toISOString().slice(0, 10) : "—"} | ${t.destroyed_at ? new Date(t.destroyed_at).toISOString().slice(0, 10) : "—"} |`
      );
    }
  }
  lines.push("", "## Tagging scheme", "", "Every Azure resource deployed under this project is tagged with:", "", "- `mcp-project = " + name + "`", "- `mcp-topology-id = <uuid>` (per topology)", "- `mcp-deployment-id = <uuid>` (per deployment)", "- `mcp-deployed-at = <utc timestamp>`", "");
  return lines.filter((l) => l !== undefined).join("\n");
}
