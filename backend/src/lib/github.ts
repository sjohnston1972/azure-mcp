// Minimal GitHub Contents API client. Just enough to (1) ensure a
// repo exists (creating it if not), and (2) write/update files in it.
// No deps — uses fetch directly.
//
// The tokens used here come from `.env` (GH_TOKEN). They're plain
// text in the environment — fine for a single-user homelab tool
// behind Cloudflare Access. If you ever multi-tenant this, move to
// per-project encrypted credentials.

import { config } from "../config.js";

const API = "https://api.github.com";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "azure-mcp-homelab",
  };
}

export function isGitHubConfigured(): boolean {
  return Boolean(config.GH_TOKEN && config.GH_OWNER);
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

async function gh(
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...headers(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
  }
  return { status: res.status, json, text };
}

/** Look up a repo. Returns null if 404, throws on other errors. */
export async function getRepo(
  owner: string,
  repo: string
): Promise<{ default_branch: string } | null> {
  const r = await gh("GET", `/repos/${owner}/${repo}`);
  if (r.status === 404) return null;
  if (r.status >= 400) {
    throw new GitHubError(
      `GET /repos/${owner}/${repo} → ${r.status}`,
      r.status,
      r.text
    );
  }
  return r.json as { default_branch: string };
}

/** Create a repo under the authenticated user. Auto-init so we have a
 *  default branch the Contents API can target. */
export async function createUserRepo(input: {
  name: string;
  description?: string;
  private?: boolean;
}): Promise<{ default_branch: string }> {
  const r = await gh("POST", "/user/repos", {
    name: input.name,
    description: input.description ?? "azure-mcp project",
    private: input.private ?? true,
    auto_init: true,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
  });
  if (r.status >= 400) {
    throw new GitHubError(
      `POST /user/repos → ${r.status}: ${r.text.slice(0, 300)}`,
      r.status,
      r.text
    );
  }
  return r.json as { default_branch: string };
}

/** Ensure the repo exists. Creates it if missing. Returns the repo
 *  name (just the bare name) and default branch. */
export async function ensureRepo(input: {
  owner: string;
  name: string;
  description?: string;
  isPrivate: boolean;
}): Promise<{ default_branch: string; created: boolean }> {
  const existing = await getRepo(input.owner, input.name);
  if (existing) return { default_branch: existing.default_branch, created: false };
  const created = await createUserRepo({
    name: input.name,
    description: input.description,
    private: input.isPrivate,
  });
  return { default_branch: created.default_branch, created: true };
}

/** PUT a single file. Idempotent: if the file already exists, we look
 *  up its sha and pass it as the update predicate, otherwise create.
 *  Accepts either a UTF-8 string (gets base64-encoded) or a raw Buffer
 *  (used for binary blobs like the topology screenshot). */
export async function putFile(input: {
  owner: string;
  repo: string;
  path: string;
  content: string | Buffer;
  message: string;
  branch?: string;
}): Promise<void> {
  // Look up existing sha for in-place update.
  let sha: string | undefined;
  const head = await gh(
    "GET",
    `/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path)}` +
      (input.branch ? `?ref=${input.branch}` : "")
  );
  if (head.status === 200 && head.json && typeof head.json === "object") {
    sha = (head.json as { sha?: string }).sha;
  }

  const base64 = Buffer.isBuffer(input.content)
    ? input.content.toString("base64")
    : Buffer.from(input.content, "utf8").toString("base64");

  const body: Record<string, unknown> = {
    message: input.message,
    content: base64,
  };
  if (sha) body["sha"] = sha;
  if (input.branch) body["branch"] = input.branch;

  const r = await gh(
    "PUT",
    `/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path)}`,
    body
  );
  if (r.status >= 400) {
    throw new GitHubError(
      `PUT contents ${input.path} → ${r.status}: ${r.text.slice(0, 300)}`,
      r.status,
      r.text
    );
  }
}

/** Sanitise a name into a GitHub-safe slug (alnum + ._-). */
function slug(name: string, max = 80): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}

/** Repo name for a project. Includes the project's UUID short suffix
 *  so two projects with similar/identical names don't collide on
 *  re-creation. Caller passes the project's database UUID. */
export function repoNameForProject(
  projectName: string,
  projectId?: string
): string {
  const base = `azure-mcp-${slug(projectName) || "project"}`;
  if (!projectId) return base;
  // First 8 chars of the UUID — collision-safe for any sub-billion
  // project count, keeps the name readable.
  const suffix = projectId.replace(/-/g, "").slice(0, 8);
  // Cap to GitHub's 100-char limit defensively.
  return `${base}-${suffix}`.slice(0, 100);
}

/** Repo name for a topology. Same shape as project: a readable slug
 *  followed by the topology's UUID short. */
export function repoNameForTopology(
  topologyName: string,
  topologyId: string
): string {
  const base = `azure-mcp-${slug(topologyName) || "topology"}`;
  const suffix = topologyId.replace(/-/g, "").slice(0, 8);
  return `${base}-${suffix}`.slice(0, 100);
}

/** Split a multi-file `<bicep>` marker body back into its
 *  { filename → content } map. Looks for `// === FILE: <name> ===`
 *  separator lines. Single-file input (no separators) returns a
 *  one-entry map keyed `main.bicep`. */
export function splitMultiFileBicep(
  bicep: string
): Record<string, string> {
  const sepRe = /^\s*\/\/\s*===\s*FILE\s*:\s*(.+?)\s*===\s*$/gm;
  const matches: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = sepRe.exec(bicep)) !== null) {
    matches.push({ name: m[1]!.trim(), index: m.index + m[0].length });
  }
  if (matches.length === 0) {
    return { "main.bicep": bicep };
  }
  const out: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index;
    const end = i + 1 < matches.length ? matches[i + 1]!.index - 0 : bicep.length;
    // Strip the next match's separator line itself if present (we
    // captured `index` as the position right after the separator,
    // so end is naturally the start of the next separator).
    out[matches[i]!.name] = bicep.slice(start, end).replace(/^\s*\n/, "").trimEnd() + "\n";
  }
  return out;
}
