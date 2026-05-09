// /api/topologies — CRUD for per-project topologies.
//
// A topology has a status: draft (designed, not pushed), live
// (successfully pushed and resources tagged in Azure), or destroyed
// (was live, Azure resources have been torn down). Modifications
// (chat-driven topology updates) are PATCHed in place.

import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import {
  ensureRepo,
  GitHubError,
  isGitHubConfigured,
  putFile,
  repoNameForTopology,
  splitMultiFileBicep,
} from "../lib/github.js";
import {
  getAzureResourceDetails,
  getAwsResourceDetails,
  prefetchTopologyDetails,
  type ResourceDetails,
} from "../lib/resource-details.js";

type Status = "draft" | "live" | "failed" | "destroyed";

/** Persisted shape of the live_details JSONB column. _at is the
 *  ISO timestamp of the last prefetch, used to render "last refreshed
 *  X ago" in the modal. Null entries mean we tried and didn't find
 *  the resource (negative cache). */
type LiveDetails = {
  _at: string;
  nodes: Record<string, ResourceDetails | null>;
};

type TopologyRow = {
  id: string;
  project_id: string;
  name: string;
  status: Status;
  cloud: "azure" | "aws";
  topology: unknown;
  bicep: string | null;
  pushed_at: string | null;
  destroyed_at: string | null;
  pushed_deployment_id: string | null;
  github_repo: string | null;
  github_synced_at: string | null;
  live_details: LiveDetails | null;
  created_at: string;
  updated_at: string;
};

const TOPOLOGY_COLS =
  "id, project_id, name, status, cloud, topology, bicep, pushed_at, destroyed_at, " +
  "pushed_deployment_id, github_repo, github_synced_at, live_details, created_at, updated_at";

/** Background prefetch driver. Fires after a successful push so the
 *  modal opens instantly the first time the user clicks any node.
 *  We keep this fire-and-forget — failures are logged but never
 *  surfaced to the PATCH caller (the deploy already succeeded; the
 *  detail endpoint will fall back to a live API call if needed). */
function kickOffPrefetch(t: TopologyRow): void {
  const topo = t.topology as TopologyJson | null;
  if (!topo?.nodes || topo.nodes.length === 0) return;
  void (async () => {
    try {
      const map = await prefetchTopologyDetails({
        topologyId: t.id,
        cloud: t.cloud,
        nodes: topo.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.label,
        })),
      });
      const payload: LiveDetails = { _at: new Date().toISOString(), nodes: map };
      await pool.query(
        "UPDATE topologies SET live_details = $1 WHERE id = $2",
        [JSON.stringify(payload), t.id]
      );
      // eslint-disable-next-line no-console
      console.log(
        `[prefetch] topology=${t.id} cached ${Object.keys(map).length} nodes`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[prefetch] topology=${t.id} failed: ${msg}`);
    }
  })();
}

export async function topologyRoutes(app: FastifyInstance) {
  // List topologies for a project.
  app.get<{ Querystring: { project_id?: string } }>(
    "/api/topologies",
    async (req, reply) => {
      if (!req.query.project_id) {
        return reply.code(400).send({ error: "project_id is required" });
      }
      const { rows } = await pool.query<TopologyRow>(
        `SELECT ${TOPOLOGY_COLS} FROM topologies
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
        "SELECT ${TOPOLOGY_COLS} FROM topologies WHERE id = $1",
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
    // Inherit cloud from the parent project so each topology row
    // self-describes its cloud — handy for the rail filter and for
    // routing chat turns to the right system prompt.
    const projRes = await pool.query<{ cloud: "azure" | "aws" }>(
      "SELECT cloud FROM projects WHERE id = $1",
      [b.project_id]
    );
    const projectCloud = projRes.rows[0]?.cloud ?? "azure";

    const { rows } = await pool.query<TopologyRow>(
      `INSERT INTO topologies (project_id, name, cloud, topology, bicep)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${TOPOLOGY_COLS}`,
      [
        b.project_id,
        name,
        projectCloud,
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
    // When transitioning to status='live' we also clear any stale
    // live_details cache from a previous deploy — the prefetch we
    // kick off after the UPDATE will repopulate it.
    if (b.status === "live") sets.push(`live_details = NULL`);
    const { rows } = await pool.query<TopologyRow>(
      `UPDATE topologies SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      vals
    );
    const updated = rows[0];
    if (!updated) return reply.code(404).send({ error: "not found" });
    // Fire-and-forget prefetch when the topology transitioned to live —
    // the user's first click on a node should then hit the DB cache
    // (sub-50ms) instead of waiting ~17-30s for the cloud CLI.
    if (b.status === "live") kickOffPrefetch(updated);
    return updated;
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

  // ── GitHub sync (per-topology) ────────────────────────────────────
  // Each topology gets its own repo: azure-mcp-<slug>-<topology-uuid8>.
  // Repo content: the Bicep (split if multi-file), topology.json (the
  // canvas state), README.md, and an optional screenshot.png the
  // frontend captures from the React Flow canvas before posting.
  //
  // Screenshot rides along as a base64-encoded PNG in the JSON body
  // (`screenshot_png_base64` field). Avoids a multipart-plugin
  // dependency; canvas screenshots are typically <500KB encoded.
  app.post<{
    Params: { id: string };
    Body?: { screenshot_png_base64?: string };
  }>(
    "/api/topologies/:id/github/push",
    async (req, reply) => {
      if (!isGitHubConfigured()) {
        return reply.code(400).send({
          error: "GitHub is not configured (set GH_TOKEN and GH_OWNER in .env)",
        });
      }

      let screenshot: Buffer | null = null;
      const b64 = req.body?.screenshot_png_base64;
      if (b64 && typeof b64 === "string") {
        // Strip the data-URL prefix if the client included it.
        const stripped = b64.replace(/^data:image\/png;base64,/, "");
        try {
          screenshot = Buffer.from(stripped, "base64");
          // Sanity cap — refuse over 5 MB to avoid abuse / memory blow-up.
          if (screenshot.byteLength > 5 * 1024 * 1024) {
            return reply
              .code(413)
              .send({ error: "screenshot exceeds 5MB limit" });
          }
        } catch {
          screenshot = null;
        }
      }

      const topoRes = await pool.query<
        TopologyRow & {
          project_name: string;
          project_description: string | null;
        }
      >(
        `SELECT t.${TOPOLOGY_COLS.replace(/, /g, ", t.")},
                p.name AS project_name, p.description AS project_description
         FROM topologies t
         JOIN projects p ON p.id = t.project_id
         WHERE t.id = $1`,
        [req.params.id]
      );
      const t = topoRes.rows[0];
      if (!t) return reply.code(404).send({ error: "topology not found" });

      // Reuse existing repo name on re-sync, generate a new one with
      // the topology's UUID short suffix on first sync.
      let repoName: string;
      if (t.github_repo) {
        const slash = t.github_repo.indexOf("/");
        repoName = slash >= 0 ? t.github_repo.slice(slash + 1) : t.github_repo;
      } else {
        repoName = repoNameForTopology(t.name, t.id);
      }
      const owner = config.GH_OWNER;

      try {
        const { default_branch, created } = await ensureRepo({
          owner,
          name: repoName,
          description: `azure-mcp topology '${t.name}' (project '${t.project_name}')`,
          isPrivate: config.GH_REPO_VISIBILITY === "private",
        });

        // 1. README — generated.
        const readme = renderTopologyReadme(
          t,
          owner,
          repoName,
          !!screenshot,
          t.topology as TopologyJson | null
        );
        await putFile({
          owner,
          repo: repoName,
          path: "README.md",
          content: readme,
          message: `azure-mcp: sync topology '${t.name}'`,
          branch: default_branch,
        });

        // 2. Bicep — split into one file per source if multi-file marker
        // present, otherwise main.bicep.
        let bicepFileCount = 0;
        if (t.bicep) {
          const files = splitMultiFileBicep(t.bicep);
          for (const [name, content] of Object.entries(files)) {
            await putFile({
              owner,
              repo: repoName,
              path: `bicep/${name}`,
              content,
              message: `azure-mcp: bicep ${name}`,
              branch: default_branch,
            });
            bicepFileCount++;
          }
        }

        // 3. topology.json — the canvas state. Write only when we have
        // something to write so a brand-new topology doesn't ship null.
        if (t.topology) {
          await putFile({
            owner,
            repo: repoName,
            path: "topology.json",
            content: JSON.stringify(t.topology, null, 2) + "\n",
            message: "azure-mcp: topology canvas state",
            branch: default_branch,
          });
        }

        // 4. screenshot.png (binary) when supplied.
        if (screenshot) {
          await putFile({
            owner,
            repo: repoName,
            path: "screenshot.png",
            content: screenshot,
            message: "azure-mcp: canvas screenshot",
            branch: default_branch,
          });
        }

        const githubRepo = `${owner}/${repoName}`;
        await pool.query(
          `UPDATE topologies
           SET github_repo = $2, github_synced_at = NOW()
           WHERE id = $1`,
          [t.id, githubRepo]
        );
        const updated = await pool.query<TopologyRow>(
          `SELECT ${TOPOLOGY_COLS} FROM topologies WHERE id = $1`,
          [t.id]
        );

        return {
          ok: true,
          repo: githubRepo,
          repo_url: `https://github.com/${githubRepo}`,
          repo_was_created: created,
          bicep_files_synced: bicepFileCount,
          screenshot_synced: !!screenshot,
          topology: updated.rows[0],
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

  // ── Live resource details (per-node click on the canvas) ─────────
  // Frontend sends the topology id + node id, we look up the matching
  // live cloud resource via the topology's mcp-topology-id tag, then
  // dispatch to the right kind-specific fetcher. Only meaningful for
  // 'live' or 'destroyed' topologies — drafts return 404.
  app.get<{ Params: { id: string; nodeId: string } }>(
    "/api/topologies/:id/details/:nodeId",
    async (req, reply) => {
      const topoRes = await pool.query<TopologyRow>(
        `SELECT ${TOPOLOGY_COLS} FROM topologies WHERE id = $1`,
        [req.params.id]
      );
      const t = topoRes.rows[0];
      if (!t) return reply.code(404).send({ error: "topology not found" });
      if (t.status !== "live") {
        return reply.code(404).send({
          error: "topology is not live — deploy it first to see resource details",
          status: t.status,
        });
      }
      const topo = t.topology as TopologyJson | null;
      const node = topo?.nodes.find((n) => n.id === req.params.nodeId);
      if (!node) return reply.code(404).send({ error: "node not found in topology" });

      // Fast path: serve from the post-deploy prefetch cache. Cache is
      // populated by kickOffPrefetch when the topology transitions to
      // live — first click should hit this and return in <50ms instead
      // of paying the ~17-30s CLI spawn cost.
      const cached = t.live_details?.nodes?.[req.params.nodeId];
      if (cached !== undefined) {
        if (cached === null) {
          return reply.code(404).send({
            error:
              "no live resource matched this node — check the topology was deployed cleanly",
            cached: true,
            cached_at: t.live_details?._at,
          });
        }
        return { ...cached, _cached_at: t.live_details?._at };
      }

      // Fall through to the live API. This happens for older topologies
      // deployed before the prefetch column existed, or while the
      // background prefetch is still in flight.
      try {
        const details =
          t.cloud === "aws"
            ? await getAwsResourceDetails({
                topologyId: t.id,
                nodeKind: node.kind,
                nodeLabel: node.label,
              })
            : await getAzureResourceDetails({
                topologyId: t.id,
                nodeKind: node.kind,
                nodeLabel: node.label,
              });
        if (!details) {
          return reply.code(404).send({
            error:
              "no live resource matched this node — check the topology was deployed cleanly",
          });
        }
        return details;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply
          .code(502)
          .send({ error: "failed to fetch live resource details", detail: message });
      }
    }
  );

  // POST /api/topologies/:id/details/refresh — force a synchronous
  // re-fetch of every node's details. Used by the modal's refresh
  // button when the user wants up-to-the-minute data (e.g. after
  // making out-of-band changes in the Azure portal).
  app.post<{ Params: { id: string } }>(
    "/api/topologies/:id/details/refresh",
    async (req, reply) => {
      const topoRes = await pool.query<TopologyRow>(
        `SELECT ${TOPOLOGY_COLS} FROM topologies WHERE id = $1`,
        [req.params.id]
      );
      const t = topoRes.rows[0];
      if (!t) return reply.code(404).send({ error: "topology not found" });
      if (t.status !== "live") {
        return reply
          .code(400)
          .send({ error: "topology is not live", status: t.status });
      }
      const topo = t.topology as TopologyJson | null;
      if (!topo?.nodes || topo.nodes.length === 0) {
        return reply.code(400).send({ error: "topology has no nodes" });
      }
      try {
        const map = await prefetchTopologyDetails({
          topologyId: t.id,
          cloud: t.cloud,
          nodes: topo.nodes.map((n) => ({
            id: n.id,
            kind: n.kind,
            label: n.label,
          })),
          // Bypass the in-memory 30s cache — this is an explicit refresh.
          force: true,
        });
        const payload: LiveDetails = {
          _at: new Date().toISOString(),
          nodes: map,
        };
        await pool.query(
          "UPDATE topologies SET live_details = $1 WHERE id = $2",
          [JSON.stringify(payload), t.id]
        );
        return {
          ok: true,
          refreshed_at: payload._at,
          node_count: Object.keys(map).length,
          hits: Object.values(map).filter((v) => v !== null).length,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply
          .code(502)
          .send({ error: "refresh failed", detail: message });
      }
    }
  );
}

type TopologyJson = {
  nodes: Array<{
    id: string;
    label: string;
    kind: string;
    sublabel?: string | null;
    status?: string | null;
  }>;
  edges: Array<{ id: string; source: string; target: string }>;
};

/** Group nodes by kind, returning [{ kind, count, items }] sorted by
 *  the canonical Azure layering (RG first, networking next, compute,
 *  data, identity, AI/ML, then everything else). The README uses this
 *  to render both a counts-by-kind summary line and a per-resource
 *  table — at-a-glance "what's deployed" without reading the Bicep. */
const KIND_ORDER = [
  "resource-group",
  "vnet",
  "subnet",
  "nsg",
  "public-ip",
  "load-balancer",
  "firewall",
  "private-endpoint",
  "vm",
  "vm-scale-set",
  "app-service",
  "container-app",
  "aks",
  "function-app",
  "storage",
  "sql",
  "cosmos",
  "key-vault",
  "managed-identity",
  "rbac",
  "openai",
  "ai-foundry",
  "cognitive",
  "log-analytics",
  "app-insights",
  "generic",
];

const KIND_LABEL: Record<string, string> = {
  "resource-group": "Resource group",
  vnet: "VNet",
  subnet: "Subnet",
  nsg: "NSG",
  "public-ip": "Public IP",
  "load-balancer": "Load Balancer",
  firewall: "Azure Firewall",
  "private-endpoint": "Private Endpoint",
  vm: "Virtual Machine",
  "vm-scale-set": "VM Scale Set",
  "app-service": "App Service",
  "container-app": "Container App",
  aks: "AKS cluster",
  "function-app": "Function App",
  storage: "Storage Account",
  sql: "Azure SQL",
  cosmos: "Cosmos DB",
  "key-vault": "Key Vault",
  "managed-identity": "Managed Identity",
  rbac: "RBAC role assignment",
  openai: "Azure OpenAI",
  "ai-foundry": "AI Foundry hub",
  cognitive: "Cognitive Services",
  "log-analytics": "Log Analytics",
  "app-insights": "Application Insights",
  generic: "Resource",
};

function renderTopologyReadme(
  t: {
    id: string;
    name: string;
    status: string;
    pushed_at: string | null;
    destroyed_at: string | null;
    bicep: string | null;
  } & { project_name: string; project_description: string | null },
  owner: string,
  repoName: string,
  hasScreenshot: boolean,
  topology: TopologyJson | null
): string {
  const lines: string[] = [];
  lines.push(`# ${t.name}`);
  lines.push("");
  lines.push(
    `Topology in azure-mcp project **${t.project_name}**${
      t.project_description ? ` — ${t.project_description}` : ""
    }.`
  );
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| Status | \`${t.status}\` |`);
  lines.push(`| Topology id | \`${t.id}\` |`);
  if (t.pushed_at) lines.push(`| Last pushed | \`${t.pushed_at}\` |`);
  if (t.destroyed_at) lines.push(`| Destroyed | \`${t.destroyed_at}\` |`);
  if (topology) {
    lines.push(`| Resources | ${topology.nodes.length} |`);
    lines.push(`| Connections | ${topology.edges.length} |`);
  }
  lines.push("");

  if (hasScreenshot) {
    // Cache-bust the image URL with the sync timestamp. GitHub serves
    // README images via raw.githubusercontent.com which honours query
    // strings — without this, the markdown renderer can show a stale
    // CDN-cached PNG for a few minutes after a re-sync even though
    // the underlying file was overwritten.
    const v = new Date().toISOString().replace(/[:.]/g, "-");
    lines.push("## Canvas");
    lines.push("");
    lines.push(`![topology canvas](./screenshot.png?v=${v})`);
    lines.push("");
  }

  // ── Resource breakdown ──────────────────────────────────────────
  // Two views: a one-line counts-by-kind summary (great for skim
  // reading on the GitHub repo card), and a full table with each
  // resource's name + sublabel (region/CIDR/SKU).
  if (topology && topology.nodes.length > 0) {
    const byKind = new Map<string, typeof topology.nodes>();
    for (const n of topology.nodes) {
      const arr = byKind.get(n.kind) ?? [];
      arr.push(n);
      byKind.set(n.kind, arr);
    }
    const sortedKinds = [...byKind.keys()].sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a);
      const bi = KIND_ORDER.indexOf(b);
      // Unknown kinds sort to the bottom, alphabetically.
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    const summary = sortedKinds
      .map((k) => {
        const count = byKind.get(k)!.length;
        const label = KIND_LABEL[k] ?? k;
        return `${count} ${label}${count === 1 ? "" : "s"}`;
      })
      .join(" • ");

    lines.push("## What's deployed");
    lines.push("");
    lines.push(summary);
    lines.push("");
    lines.push("| Type | Name | Detail |");
    lines.push("|---|---|---|");
    for (const k of sortedKinds) {
      const items = byKind.get(k)!;
      const label = KIND_LABEL[k] ?? k;
      for (const n of items) {
        const detail = (n.sublabel ?? "").trim() || "—";
        // Escape pipe characters in user-supplied strings so we don't
        // break the markdown table.
        const safeName = n.label.replace(/\|/g, "\\|");
        const safeDetail = detail.replace(/\|/g, "\\|");
        lines.push(`| ${label} | \`${safeName}\` | ${safeDetail} |`);
      }
    }
    lines.push("");

    if (topology.edges.length > 0) {
      // Build a quick lookup so the connections table can render
      // resource NAMES rather than internal node ids.
      const nameOf = new Map<string, string>();
      for (const n of topology.nodes) nameOf.set(n.id, n.label);
      lines.push("## Connections");
      lines.push("");
      lines.push("| From | → | To |");
      lines.push("|---|---|---|");
      for (const e of topology.edges) {
        const src = nameOf.get(e.source) ?? e.source;
        const dst = nameOf.get(e.target) ?? e.target;
        lines.push(`| \`${src}\` | → | \`${dst}\` |`);
      }
      lines.push("");
    }
  }

  lines.push("## Repo contents");
  lines.push("");
  lines.push(
    "- `bicep/` — the deployable Bicep template (multi-file when the design crosses scopes)."
  );
  lines.push(
    "- `topology.json` — the canvas state (nodes + edges), parseable by azure-mcp's React Flow renderer."
  );
  if (hasScreenshot) {
    lines.push(
      "- `screenshot.png` — canvas snapshot at the time of the last sync."
    );
  }
  lines.push("");
  lines.push("## Redeploy from this Bicep");
  lines.push("");
  lines.push("```bash");
  lines.push(
    "az deployment sub create --location <region> --template-file bicep/main.bicep"
  );
  lines.push("```");
  lines.push("");
  lines.push(
    `_Synced from [azure-mcp](https://github.com/${owner}/${repoName}) on ${new Date().toISOString()}._`
  );
  return lines.join("\n") + "\n";
}
