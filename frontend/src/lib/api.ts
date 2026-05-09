// API client. Same-origin in production (nginx proxies /api → backend);
// in dev Vite's proxy in vite.config.ts handles the same routing.

import type {
  ChatMessage,
  Cloud,
  GithubPushResult,
  GithubStatus,
  Project,
  Schedule,
  Stage,
  Template,
  TopologyRecord,
  TopologyStatus,
} from "./types";
import type { Topology } from "./parse-topology";

export async function streamChat(
  messages: ChatMessage[],
  projectId: string | null,
  stage: Stage,
  topologyId: string | null,
  signal?: AbortSignal
): Promise<Response> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      project_id: projectId,
      stage,
      topology_id: topologyId,
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/chat → ${res.status}: ${text || res.statusText}`);
  }
  return res;
}

/** List projects, optionally filtered by cloud. The header toggle
 *  drives this — the project dropdown only shows projects matching
 *  the active cloud. */
export async function listProjects(cloud?: Cloud): Promise<Project[]> {
  const url = cloud ? `/api/projects?cloud=${cloud}` : "/api/projects";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

export async function createProject(input: {
  name: string;
  description?: string;
  cloud?: Cloud;
}): Promise<Project> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/projects → ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`/api/projects/${id} → ${res.status}`);
}

// ── GitHub integration ──────────────────────────────────────────────

export async function getGithubStatus(): Promise<GithubStatus> {
  const res = await fetch("/api/github/status");
  if (!res.ok) throw new Error(`/api/github/status → ${res.status}`);
  return res.json();
}

export async function pushProjectToGithub(
  projectId: string
): Promise<GithubPushResult> {
  const res = await fetch(`/api/projects/${projectId}/github/push`, {
    method: "POST",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github push → ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

// ── Templates ────────────────────────────────────────────────────────

export async function listTemplates(): Promise<Template[]> {
  const res = await fetch("/api/templates");
  if (!res.ok) throw new Error(`/api/templates → ${res.status}`);
  return res.json();
}

export async function createTemplate(input: {
  name: string;
  description?: string;
  bicep: string;
  /** Canvas state at save time. Saved alongside the Bicep so loading
   *  a template doesn't have to ask Claude to re-derive a topology. */
  topology?: Topology | null;
  source_deployment_id?: string;
}): Promise<Template> {
  const res = await fetch("/api/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/templates → ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export async function deleteTemplate(id: string): Promise<void> {
  const res = await fetch(`/api/templates/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`/api/templates/${id} → ${res.status}`);
}

// ── Schedules ────────────────────────────────────────────────────────

export async function listSchedules(projectId?: string): Promise<Schedule[]> {
  const url = projectId
    ? `/api/schedules?project_id=${projectId}`
    : "/api/schedules";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

export async function createSchedule(input: {
  project_id: string;
  template_id?: string;
  action: "push" | "teardown";
  cron: string;
  enabled?: boolean;
}): Promise<Schedule> {
  const res = await fetch("/api/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/schedules → ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export async function patchSchedule(
  id: string,
  input: { enabled?: boolean; cron?: string }
): Promise<Schedule> {
  const res = await fetch(`/api/schedules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`/api/schedules/${id} → ${res.status}`);
  return res.json();
}

export async function deleteSchedule(id: string): Promise<void> {
  const res = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`/api/schedules/${id} → ${res.status}`);
}

// ── Topologies ──────────────────────────────────────────────────────

export async function listTopologies(
  projectId: string
): Promise<TopologyRecord[]> {
  const res = await fetch(
    `/api/topologies?project_id=${encodeURIComponent(projectId)}`
  );
  if (!res.ok) throw new Error(`/api/topologies → ${res.status}`);
  return res.json();
}

export async function createTopology(input: {
  project_id: string;
  name?: string;
  topology?: Topology;
  bicep?: string;
}): Promise<TopologyRecord> {
  const res = await fetch("/api/topologies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`/api/topologies → ${res.status}: ${t}`);
  }
  return res.json();
}

export async function patchTopology(
  id: string,
  input: {
    name?: string;
    status?: TopologyStatus;
    topology?: Topology;
    bicep?: string | null;
  }
): Promise<TopologyRecord> {
  const res = await fetch(`/api/topologies/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`/api/topologies/${id} → ${res.status}`);
  return res.json();
}

export async function deleteTopology(id: string): Promise<void> {
  const res = await fetch(`/api/topologies/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`/api/topologies/${id} → ${res.status}`);
}

/** Live resource details fetched per-click from the cloud APIs.
 *  Mirrors the backend's ResourceDetails shape. */
export type ResourceDetails = {
  cloud: "azure" | "aws";
  name: string;
  kind: string;
  resource_type: string;
  location: string;
  resource_group?: string;
  state?: string;
  tags?: Record<string, string>;
  console_url?: string;
  /** Kind-specific structured payload — modal pattern-matches on
   *  resource_type / kind to render the right fields. */
  props: Record<string, unknown>;
  /** Raw cloud-API response for the modal's "Raw" tab. */
  raw?: unknown;
  /** ISO timestamp of the post-deploy prefetch. Present when the
   *  detail came from the topology's live_details cache, absent
   *  when fetched live. Used to render "cached X ago". */
  _cached_at?: string;
};

export async function fetchResourceDetails(
  topologyId: string,
  nodeId: string
): Promise<ResourceDetails> {
  const url = `/api/topologies/${encodeURIComponent(topologyId)}/details/${encodeURIComponent(nodeId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} → ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

/** Force a synchronous re-fetch of every node's detail for this
 *  topology. Used by the modal's refresh button when cached data
 *  is stale (e.g. the user changed something in the portal). */
export async function refreshTopologyDetails(
  topologyId: string
): Promise<{
  ok: boolean;
  refreshed_at: string;
  node_count: number;
  hits: number;
}> {
  const url = `/api/topologies/${encodeURIComponent(topologyId)}/details/refresh`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} → ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export type TopologyGithubPushResult = {
  ok: boolean;
  repo: string;
  repo_url: string;
  repo_was_created: boolean;
  bicep_files_synced: number;
  screenshot_synced: boolean;
  topology: TopologyRecord;
};

/** Push a single topology to its own GitHub repo. The screenshot is
 *  optional — if supplied as a PNG data URL, the backend strips the
 *  data: prefix and saves the bytes as screenshot.png in the repo. */
export async function pushTopologyToGithub(
  id: string,
  screenshotPngBase64?: string
): Promise<TopologyGithubPushResult> {
  const res = await fetch(`/api/topologies/${id}/github/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      screenshotPngBase64
        ? { screenshot_png_base64: screenshotPngBase64 }
        : {}
    ),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`/api/topologies/${id}/github/push → ${res.status}: ${t}`);
  }
  return res.json();
}
