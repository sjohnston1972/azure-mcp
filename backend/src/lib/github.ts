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
 *  up its sha and pass it as the update predicate, otherwise create. */
export async function putFile(input: {
  owner: string;
  repo: string;
  path: string;
  content: string;
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

  const body: Record<string, unknown> = {
    message: input.message,
    content: Buffer.from(input.content, "utf8").toString("base64"),
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

/** Sanitise a project name into a valid GitHub repo name. */
export function repoNameForProject(projectName: string): string {
  // GitHub repo names: alphanumeric, hyphen, underscore, period.
  // Max 100 chars. We prepend `azure-mcp-` so the user can find the
  // family at a glance.
  const safe = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `azure-mcp-${safe || "project"}`;
}
