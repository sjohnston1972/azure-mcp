// Which tools may be called in which lifecycle stage.
//
// WHY THIS FILE EXISTS
// --------------------
// Every chat turn happens in one of five stages: build, view, push,
// teardown, free. The rule has always been "you deploy in push, you delete
// in teardown, everything else is read-only" — but until now that rule
// lived only as English in the system prompt. The model was the only thing
// enforcing it, which means a prompt-injection payload (or a plain slip)
// could fire `destroy_azure` during a design conversation.
//
// This module is the single source of truth for the rule, used twice:
//
//   1. `getClaudeTools(cloud, stage)` filters the tool list, so in a
//      read-only stage the model never even sees a destroy tool.
//   2. `callMcpTool(name, input, stage)` re-checks before dispatching, so
//      a stale cache, a hand-crafted request, or a bug in (1) still can't
//      get a mutation through.
//
// Belt and braces on purpose: (1) is what makes the model behave, (2) is
// what makes it *safe*.

/** Lifecycle stage of a chat turn. Mirrors the frontend's Stage type. */
export type ChatStage = "build" | "view" | "push" | "teardown" | "free";

/**
 * What a tool does to the cloud.
 *   readonly — inspection only; always allowed
 *   deploy   — creates or changes resources; push only
 *   destroy  — deletes resources; teardown only
 *   mutating — an upstream MCP tool we can tell is not read-only, but
 *              can't confidently sort into deploy vs destroy; allowed in
 *              push and teardown, refused everywhere else
 */
export type ToolKind = "readonly" | "deploy" | "destroy" | "mutating";

/** Our own tools. These we know exactly, so they're matched by name. */
const CUSTOM_DEPLOY_TOOLS = new Set(["deploy_bicep", "deploy_cloudformation"]);
const CUSTOM_DESTROY_TOOLS = new Set(["destroy_azure", "destroy_aws"]);

// The upstream Azure/AWS/Bicep MCP servers expose 100+ tools whose names
// we don't control, so they're classified by the verb in the name. The
// convention across all three servers is `<area>_<thing>_<verb>`, e.g.
// `azmcp_storage_account_list`, `azmcp_group_create`.
//
// Read-only verbs are checked FIRST and only in the final position, so a
// tool like `azmcp_deploy_plan_get` (which reads an azd deployment plan)
// isn't misread as a deployment just because "deploy" appears earlier in
// the name.

const READONLY_VERBS = new Set([
  "list", "show", "get", "describe", "read", "query", "search", "find",
  "check", "validate", "verify", "schema", "info", "status", "usage",
  "count", "diagnose", "recommend", "explain", "types", "skus",
]);

const DESTROY_VERBS = new Set([
  "delete", "destroy", "remove", "purge", "teardown", "drop", "uninstall",
  "revoke", "detach", "deallocate",
]);

const DEPLOY_VERBS = new Set([
  "create", "deploy", "update", "set", "put", "add", "write", "upload",
  "install", "assign", "grant", "enable", "disable", "start", "stop",
  "restart", "scale", "import", "apply", "modify", "patch", "rotate",
  "reset", "attach", "provision", "publish", "run", "execute", "invoke",
  "generate",
]);

/**
 * Names we always treat as mutating regardless of their verb.
 *
 * The Azure MCP Server ships "extension" tools that are thin passthroughs
 * to the `az` / `azd` CLIs — they take an arbitrary command line, so their
 * name tells you nothing about what they'll do. Anything that can run an
 * arbitrary CLI command is mutating by definition.
 *
 * Matched as a substring of the lowercased tool name. If this turns out to
 * block a genuinely read-only scanner (azqr, say), the fix is to add an
 * exact-name exception here — not to widen the rule.
 */
const ALWAYS_MUTATING_SUBSTRINGS = ["extension_az", "extension-az", "_cli_", "passthrough"];

/** Classify a tool by name. Pure — no I/O, safe to call per dispatch. */
export function classifyTool(name: string): ToolKind {
  if (CUSTOM_DEPLOY_TOOLS.has(name)) return "deploy";
  if (CUSTOM_DESTROY_TOOLS.has(name)) return "destroy";

  const lower = name.toLowerCase();
  if (ALWAYS_MUTATING_SUBSTRINGS.some((s) => lower.includes(s))) {
    return "mutating";
  }

  const segments = lower.split(/[_\-.]+/).filter(Boolean);
  const last = segments[segments.length - 1];

  // A trailing read-only verb wins outright: `..._deployment_show` reads,
  // it doesn't deploy.
  if (last && READONLY_VERBS.has(last)) return "readonly";

  if (segments.some((s) => DESTROY_VERBS.has(s))) return "destroy";
  if (segments.some((s) => DEPLOY_VERBS.has(s))) return "mutating";

  // No recognised verb at all — the upstream servers' inspection tools
  // dominate this bucket (bicepschema, best-practices, docs lookups), and
  // anything genuinely dangerous almost always names its verb.
  return "readonly";
}

/** Which kinds of tool each stage may use. */
const ALLOWED_KINDS: Record<ChatStage, ToolKind[]> = {
  // Designing and reviewing: inspection only.
  build: ["readonly"],
  view: ["readonly"],
  // Ad-hoc questions outside the lifecycle. Read-only by default — if the
  // user genuinely wants to change something they can switch to push or
  // teardown, which is exactly the explicit act we want to require.
  free: ["readonly"],
  // Deploying: create/update, but never delete.
  push: ["readonly", "deploy", "mutating"],
  // Tearing down: delete, but never deploy.
  teardown: ["readonly", "destroy", "mutating"],
};

/** True when `name` may be called during `stage`. */
export function isToolAllowedInStage(name: string, stage: ChatStage): boolean {
  const kinds = ALLOWED_KINDS[stage];
  // An unrecognised stage is a programming error, not a licence to run
  // everything — fail closed to read-only.
  if (!kinds) return classifyTool(name) === "readonly";
  return kinds.includes(classifyTool(name));
}

/** The refusal message handed back to Claude as a tool result. Phrased so
 *  the model understands what to do instead of retrying the same call. */
export function stageRefusalMessage(name: string, stage: ChatStage): string {
  const kind = classifyTool(name);
  const where =
    kind === "destroy"
      ? "the TEAR-DOWN stage"
      : kind === "deploy"
        ? "the PUSH stage"
        : "the PUSH or TEAR-DOWN stages";
  return (
    `'${name}' is not permitted in stage '${stage}'. ` +
    `It is a ${kind} tool and may only run in ${where}. ` +
    `Nothing was executed and no cloud call was made. ` +
    `Tell the user which stage they need to switch to, and do not retry this tool in the current stage.`
  );
}
