// Shared types for frontend.
//
// Wire shape for /api/chat matches Anthropic's MessageParam closely so
// the backend can pass `messages` straight into the SDK without having
// to translate.

export type Role = "user" | "assistant";

export type TextBlock = { type: "text"; text: string };

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown;
  is_error?: boolean;
};

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// What we send to /api/chat. Matches Anthropic's MessageParam.
export type ChatMessage = {
  role: Role;
  content: string | ContentBlock[];
};

// What the chat panel renders. Slightly richer than the wire shape so
// we can show streaming-in-progress assistant text and inline tool
// calls without re-deriving them every render.
export type DisplayMessage =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      // Ordered timeline of what the assistant did this turn.
      blocks: AssistantBlock[];
      // True while we're still receiving SSE events for this message.
      streaming: boolean;
    }
  | { kind: "system"; id: string; text: string; tone?: "info" | "error" };

export type AssistantBlock =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      input: unknown;
      // Result lands later via the matching tool_result SSE event.
      resultPending: boolean;
      isError: boolean;
    };

// Project shape from the backend.
export type Project = {
  id: string;
  name: string;
  description: string | null;
  github_repo: string | null;
  github_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GithubStatus = {
  configured: boolean;
  owner: string | null;
  visibility: "public" | "private";
};

export type GithubPushResult = {
  ok: boolean;
  repo: string;
  repo_url: string;
  repo_was_created: boolean;
  topologies_synced: number;
  project: Project;
};

// Lifecycle stages for a chat turn. Sent to /api/chat as `stage`.
export type Stage = "build" | "view" | "push" | "teardown" | "free";

// Per-project build state. Persisted to localStorage so a reload
// doesn't lose what Claude proposed.
export type BuildState = {
  topology: import("./parse-topology").Topology | null;
  bicep: string | null;
  /** True once the user has pressed Push and the deployment finished
   *  successfully. Tear-down clears it. */
  pushed: boolean;
  /** ISO timestamp of the last Push that was acknowledged as complete. */
  pushedAt: string | null;
};

export type Schedule = {
  id: string;
  project_id: string;
  template_id: string;
  action: "push" | "teardown";
  cron: string;
  enabled: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  next_run_at: string | null;
  created_at: string;
};

export type Template = {
  id: string;
  name: string;
  description: string | null;
  bicep: string;
  source_deployment_id: string | null;
  created_at: string;
};

export type TopologyStatus = "draft" | "live" | "failed" | "destroyed";

/** A topology RECORD (DB row) — distinct from the topology JSON
 *  shape which lives in lib/parse-topology.ts as `Topology`. */
export type TopologyRecord = {
  id: string;
  project_id: string;
  name: string;
  status: TopologyStatus;
  topology: import("./parse-topology").Topology | null;
  bicep: string | null;
  pushed_at: string | null;
  destroyed_at: string | null;
  pushed_deployment_id: string | null;
  created_at: string;
  updated_at: string;
};
