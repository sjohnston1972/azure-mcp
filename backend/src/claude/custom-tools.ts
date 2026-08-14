// Custom tools that are NOT exposed by Microsoft's Azure MCP Server.
// We mix these into the tool list given to Claude alongside the upstream
// MCP tools, and the dispatcher in tool-bridge.ts routes calls to the
// right handler based on the tool name.
//
// The big one is `deploy_bicep` — Microsoft's MCP server has tools
// for inspection, best-practices advice, app-code deployment via azd,
// and Bicep schema lookup, but no tool for "submit this Bicep template
// to Azure Resource Manager". We bridge that gap by spawning the
// official `mcr.microsoft.com/azure-cli` container with the project's
// service-principal credentials and running `az deployment ... create`.

// ── A note on how values reach the container ──────────────────────
//
// Nothing that comes from a tool call is ever pasted into the `sh -c`
// script text. The script bodies below are static: they only ever
// reference `"$SOME_VAR"`. The values arrive separately as `docker run -e`
// flags, and docker passes those through verbatim — no shell parses them
// on the way in, and `"$VAR"` inside the script expands to a literal
// string that is never re-parsed as code. That makes shell injection
// structurally impossible rather than merely unlikely.
//
// On top of that, every scalar and tag is allowlist-validated before a
// container is spawned (see tool-input-validation.ts). Belt and braces:
// the env-var passing is the real fix, the validation also protects the
// JMESPath query strings, where a stray quote would change the query's
// meaning even though it could never execute anything.
//
// Secrets are passed by NAME only (`-e AZURE_CLIENT_SECRET`, no `=value`).
// Docker forwards the value from this process's own environment, so the
// secret never appears in the sidecar's argv where `ps` and
// `docker inspect` would expose it.

import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CURATED_VM_SKUS } from "../lib/vm-skus.js";
import { CURATED_EC2_TYPES } from "../lib/ec2-types.js";
import {
  requireProjectAnchor,
  validateAwsRegion,
  validateAzureLocation,
  validateAzureResourceGroup,
  validateDeploymentName,
  validateStackName,
  validateTags,
} from "./tool-input-validation.js";

const AZURE_CLI_IMAGE =
  process.env.AZURE_CLI_IMAGE ?? "mcr.microsoft.com/azure-cli:latest";

// AWS CLI sidecar image. We use the v2 amazon/aws-cli image so we
// can run `aws cloudformation deploy/validate-template/delete-stack`
// directly. Same pattern as the Azure side: spawn one container per
// invocation with the workspace volume + the host's SSO creds mounted.
const AWS_CLI_IMAGE = process.env.AWS_CLI_IMAGE ?? "amazon/aws-cli:latest";

// The shared volume mount path inside both the backend container and
// the spawned azure-cli/aws-cli containers (see docker-compose.yml).
const WORKSPACE = "/work";
// Docker named volume that compose actually creates. The naming convention
// is `<project>_<volume_key>` — for our compose file the project is
// `azure-mcp` and the volume key is `azure-mcp-deploy-workspace`, so the
// actual volume name is `azure-mcp_azure-mcp-deploy-workspace`. Override
// via env if you ever rename the project.
const WORKSPACE_VOLUME =
  process.env.AZURE_MCP_DEPLOY_VOLUME ?? "azure-mcp_azure-mcp-deploy-workspace";

// AWS auth via long-lived IAM access keys (mirrors the Azure
// service-principal pattern). The backend container reads these
// from .env via Compose, then passes them through to each spawned
// aws-cli sidecar via -e flags. No ~/.aws mount needed for the
// access-key path.
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "";
const AWS_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN ?? "";
// Default AWS region used when a tool call doesn't override it. The
// user can change this in the chat.
const AWS_DEFAULT_REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";

// Optional fallback: SSO via mounted ~/.aws. Set if you'd rather use
// AWS Identity Center than long-lived keys. The access-key path takes
// precedence when both are configured.
const AWS_HOST_CONFIG_PATH = process.env.AWS_HOST_CONFIG_PATH ?? "";
const AWS_PROFILE = process.env.AWS_PROFILE ?? "";

/** True when AWS auth is plumbed through (either via access keys or
 *  via mounted SSO config). The deploy tools error with a clear hint
 *  if neither is configured. */
const AWS_AUTH_CONFIGURED =
  Boolean(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) ||
  Boolean(AWS_HOST_CONFIG_PATH);

/**
 * Safety cap on a tag-filter destroy: if the filter matches more resource
 * groups than this, we refuse and print the list instead of deleting.
 * A filter that sweeps up 30 resource groups is almost certainly wrong,
 * and the service principal usually has rights over the whole
 * subscription. Raise via env if you genuinely run projects that large.
 */
const DESTROY_MAX_GROUPS = Number(
  process.env.AZURE_MCP_DESTROY_MAX_GROUPS ?? "25"
);

/**
 * Azure credential flags for `docker run`, passed by NAME so the secret
 * value never lands on the sidecar's command line (where any process on
 * the host could read it via `ps` or `docker inspect`).
 *
 * The values come from this process's environment, which config.ts has
 * already verified is populated — the backend exits at boot if any of
 * these are missing, so by the time a tool runs they are guaranteed
 * present. We re-check anyway and fail with a clear message rather than
 * spawning a container that would only fail at `az login`.
 */
const AZURE_CRED_ENV_NAMES = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_ID",
] as const;

function azureCredDockerArgs(): { args: string[] } | { error: string } {
  const missing = AZURE_CRED_ENV_NAMES.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    return {
      error:
        `Azure credentials are not available to the backend process: ${missing.join(", ")} ` +
        `is unset. Fill these in .env and restart the backend.`,
    };
  }
  // `-e NAME` with no `=value` tells docker "forward this variable from
  // my own environment" — the value is transferred over the docker API,
  // not through the argv.
  return { args: AZURE_CRED_ENV_NAMES.flatMap((n) => ["-e", n]) };
}

/** Same idea for AWS. Returns the name-only `-e` flags for whichever
 *  credential variables are actually set. */
function awsCredDockerArgs(): string[] {
  const args: string[] = ["-e", "AWS_ACCESS_KEY_ID", "-e", "AWS_SECRET_ACCESS_KEY"];
  if (AWS_SESSION_TOKEN) args.push("-e", "AWS_SESSION_TOKEN");
  return args;
}

export const CUSTOM_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_vm_skus",
    description:
      "Return the curated list of Azure VM SKUs the host knows about, with vCPU/RAM/disk specs, indicative monthly USD price, and a `free_tier` flag. Use this BEFORE proposing a VM size so you can: (1) default to `Standard_B1s` when the user hasn't specified — that's the only SKU eligible for Azure's 12-month free tier (750 hrs/mo on new accounts), and (2) match larger SKUs to the user's stated workload. Pricing is approximate (PAYG, Linux, East US) — flag that to the user, don't quote it as final. Optional filters: `family` (one of: burstable, general-purpose, memory-optimized, compute-optimized, gpu, legacy-basic), `free_tier_only` (true returns only the B1s entry).",
    input_schema: {
      type: "object",
      properties: {
        family: {
          type: "string",
          enum: [
            "burstable",
            "general-purpose",
            "memory-optimized",
            "compute-optimized",
            "gpu",
            "legacy-basic",
          ],
        },
        free_tier_only: { type: "boolean" },
      },
    },
  },
  {
    name: "validate_bicep",
    description:
      "Compile-check a Bicep template via `az bicep build`. Use this in build/view stages BEFORE emitting a `<bicep>` marker so the user only sees a template that actually compiles. Catches: syntax errors, `newGuid()`/`utcNow()` used outside parameter defaults, broken AVM module versions, undefined symbols, type mismatches. Multi-file is supported — pass `files` + `entry` when your template uses local `module x './foo.bicep' = {...}` references. Does NOT contact Azure. Returns the compile output verbatim. If the template doesn't validate, fix and call this again before emitting the final marker.",
    input_schema: {
      type: "object",
      properties: {
        bicep: {
          type: "string",
          description:
            "Single-file Bicep source. Use this when your template has no local `module` references (only AVM `br/public:avm/...` modules or none at all). Mutually exclusive with `files`.",
        },
        files: {
          type: "object",
          description:
            "Multi-file form: { '<filename>.bicep': '<content>', ... }. Use when your entry-point references sibling files via `module x './foo.bicep' = {...}` — pass every referenced file in the map. Filenames must be plain (no slashes, no '..'); relative refs in Bicep should still use `./<name>.bicep`. Mutually exclusive with `bicep`.",
          additionalProperties: { type: "string" },
        },
        entry: {
          type: "string",
          description:
            "Filename in `files` to compile as the entry point. Defaults to `main.bicep`. Ignored when `bicep` is used.",
        },
      },
    },
  },
  {
    name: "destroy_azure",
    description:
      "Delete Azure resources. Use this for tear-down — the Azure MCP Server has no resource-group-delete or generic delete-by-tag tool. This tool spawns Microsoft's official azure-cli container with the project's service-principal credentials and runs `az group delete` and/or `az resource delete --ids` against matched resources. Two operating modes: (1) `resource_group_name` to delete a specific resource group (cascades to all resources inside); (2) `tag_filters` to delete every resource group AND every standalone resource that carries ALL the listed tags. The two modes can be combined. " +
      "ALWAYS A TWO-STEP CALL: the first call (no `confirm`) is a dry run that returns the exact list of resource groups and resources that WOULD be deleted and deletes nothing. Read that list, check it matches what the user asked for, then call again with identical arguments plus `confirm: true` to actually delete. A tag-filter destroy must include the project tag (`mcp-project`) — an unanchored filter is refused, because it could match resources across the whole subscription.",
    input_schema: {
      type: "object",
      properties: {
        resource_group_name: {
          type: "string",
          description:
            "Specific resource group to delete (cascades). Optional.",
        },
        tag_filters: {
          type: "object",
          description:
            "Tag key→value pairs. Resources matching ALL of these tags are deleted. MUST include the project anchor tag `mcp-project`. Typical values: { 'mcp-project': '<name>', 'mcp-topology-id': '<uuid>' } for a per-topology destroy.",
          additionalProperties: { type: "string" },
        },
        confirm: {
          type: "boolean",
          description:
            "Set false (or omit) for the dry run — the tool lists what it would delete and deletes nothing. Set true ONLY on a follow-up call, after you have seen the dry-run list and it matches the user's intent. Never set true on the first call for a given teardown.",
        },
      },
    },
  },
  {
    name: "deploy_bicep",
    description:
      "Deploy a Bicep template to Azure Resource Manager. Use this for ANY infrastructure deployment — VNets, subnets, NSGs, peerings, public IPs, App Service, Storage, Key Vault, etc. The Azure MCP Server itself has no Bicep deployment tool, so this is the canonical path. Spawns Microsoft's official azure-cli container, authenticates with the project's service principal, runs `az deployment {sub|group} create`, then enforces `required_tags` via `az tag update`. Multi-file is supported — pass `files` + `entry` when your template uses local module references. Use scope='subscription' if the template creates resource groups; scope='resourceGroup' (with `resource_group_name`) if it deploys into an existing RG.",
    input_schema: {
      type: "object",
      properties: {
        bicep: {
          type: "string",
          description:
            "Single-file Bicep source. Use when your template has no local `module` references. Mutually exclusive with `files`.",
        },
        files: {
          type: "object",
          description:
            "Multi-file form: { '<filename>.bicep': '<content>', ... }. Use when your entry-point references sibling files via `module x './foo.bicep' = {...}` — pass every referenced file in the map. Filenames must be plain (no slashes, no '..'). Relative refs in Bicep should still use `./<name>.bicep`. Mutually exclusive with `bicep`.",
          additionalProperties: { type: "string" },
        },
        entry: {
          type: "string",
          description:
            "Filename in `files` to compile and deploy as the entry point. Defaults to `main.bicep`. Ignored when `bicep` is used.",
        },
        scope: {
          type: "string",
          enum: ["subscription", "resourceGroup"],
          description:
            "Deployment scope. 'subscription' for templates that include `targetScope = 'subscription'` (typically those that create resource groups). 'resourceGroup' for templates that deploy resources into an existing group.",
        },
        location: {
          type: "string",
          description:
            "Azure region for subscription-scoped deployments (e.g. 'uksouth'). Required when scope='subscription'.",
        },
        resource_group_name: {
          type: "string",
          description:
            "Existing resource group to deploy into. Required when scope='resourceGroup'.",
        },
        deployment_name: {
          type: "string",
          description:
            "Optional friendly name for the deployment. Defaults to a timestamped UUID.",
        },
        required_tags: {
          type: "object",
          description:
            "Tags that MUST be present on every resource produced by the deployment. After `az deployment create` succeeds, the tool runs `az tag update --operation Merge` against each resource id in the deployment's outputResources list to guarantee these tags are applied — even if the Bicep template forgot them. Use this to enforce `mcp-project`, `mcp-topology-id`, etc.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["scope"],
    },
  },
  // ── AWS tools ─────────────────────────────────────────────────
  // Mirrored from the Azure trio. Backend plumbing is the same
  // shape (sidecar container per call, workspace volume for the
  // template file) — the cloud, IaC language, and CLI differ.
  {
    name: "validate_cloudformation",
    description:
      "Compile-check an AWS CloudFormation template via `aws cloudformation validate-template`. Use this in build/view stages BEFORE emitting a `<bicep>` marker (yes, the marker is named `<bicep>` even for AWS — it's the project's generic 'IaC body' marker, see system prompt) so the user only sees a template that ARM/CFN actually accepts. Catches syntax errors, malformed resource type names, missing required properties, intrinsic-function misuse. Does NOT contact AWS for live state. Multi-file is supported via `files` + `entry`. Returns the validate output verbatim.",
    input_schema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description:
            "Single-file CloudFormation template (YAML or JSON). Mutually exclusive with `files`.",
        },
        files: {
          type: "object",
          description:
            "Multi-file form: { '<filename>.(yaml|json)': '<content>', ... }. Use when your design uses nested stacks (TemplateURL: ./nested.yaml) — pass every referenced file. Filenames must be plain (no slashes, no '..').",
          additionalProperties: { type: "string" },
        },
        entry: {
          type: "string",
          description:
            "Filename in `files` to validate as the entry point. Defaults to `main.yaml`. Ignored when `template` is used.",
        },
      },
    },
  },
  {
    name: "deploy_cloudformation",
    description:
      "Deploy a CloudFormation stack to AWS. Spawns the official `amazon/aws-cli` container, picks up the host's SSO credentials from the mounted ~/.aws, runs `aws cloudformation deploy`, then enforces `required_tags` via stack-level tagging. Use scope='create' for a fresh stack (will fail if a stack with that name already exists), scope='update' to apply changes to an existing stack. Multi-file templates supported via `files` + `entry` for nested stacks. Region defaults from AWS_DEFAULT_REGION env, override per call via `region`.",
    input_schema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description:
            "Single-file CloudFormation template (YAML or JSON). Mutually exclusive with `files`.",
        },
        files: {
          type: "object",
          description:
            "Multi-file form for nested stacks: { '<filename>': '<content>', ... }. The entry-point file refers to siblings via `TemplateURL: ./<name>` style paths.",
          additionalProperties: { type: "string" },
        },
        entry: {
          type: "string",
          description:
            "Filename in `files` to deploy as the entry. Defaults to `main.yaml`.",
        },
        stack_name: {
          type: "string",
          description:
            "Name for the CloudFormation stack. Required. Use kebab-case alphanumeric to match the project naming convention (e.g. `mcp-vigil-vpc`).",
        },
        region: {
          type: "string",
          description:
            "AWS region (e.g. 'us-east-1', 'eu-west-2'). Defaults to AWS_DEFAULT_REGION.",
        },
        capabilities: {
          type: "array",
          items: {
            type: "string",
            enum: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"],
          },
          description:
            "CloudFormation capabilities to acknowledge — required when the template creates IAM resources (CAPABILITY_IAM, or CAPABILITY_NAMED_IAM if you set explicit role/user names) or uses transforms like SAM (CAPABILITY_AUTO_EXPAND). Pass exactly the ones the template needs.",
        },
        required_tags: {
          type: "object",
          description:
            "Tags applied to the stack itself (and propagated to taggable resources via CloudFormation's stack tags). Mirrors Azure's required_tags — pass `mcp-project`, `mcp-topology-id`, etc. so the destroy-by-tag flow can find them later.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["stack_name"],
    },
  },
  {
    name: "destroy_aws",
    description:
      "Delete AWS resources — by stack name, by tag filter, or both. Spawns the aws-cli sidecar with the host's SSO creds. Two modes: (1) `stack_name` deletes a specific CloudFormation stack via `aws cloudformation delete-stack` and waits for stack-delete-complete; (2) `tag_filters` finds every CloudFormation stack whose tags match ALL the listed pairs (typical: `{ mcp-project: '<name>', mcp-topology-id: '<uuid>' }`) and deletes each. Modes can be combined.",
    input_schema: {
      type: "object",
      properties: {
        stack_name: {
          type: "string",
          description: "Specific stack to delete. Optional.",
        },
        tag_filters: {
          type: "object",
          description:
            "Tag key→value pairs. Stacks with ALL of these tags are deleted.",
          additionalProperties: { type: "string" },
        },
        region: {
          type: "string",
          description:
            "AWS region. Defaults to AWS_DEFAULT_REGION.",
        },
      },
    },
  },
  {
    name: "list_ec2_types",
    description:
      "Return the curated list of AWS EC2 instance types the host knows about, with vCPU/RAM/network specs, indicative monthly USD price, and a `free_tier` flag. Use this BEFORE proposing an EC2 instance type so you can: (1) default to `t3.micro` when the user hasn't specified — that's the only type eligible for AWS's 12-month free tier (750 hrs/mo on new accounts), and (2) match larger types to the user's stated workload. Pricing is approximate (on-demand, Linux, us-east-1) — flag that to the user, don't quote it as final. Optional filters: `family` (one of: burstable, general-purpose, memory-optimized, compute-optimized, gpu, storage-optimized, graviton-arm), `free_tier_only` (true returns only the t3.micro entry).",
    input_schema: {
      type: "object",
      properties: {
        family: {
          type: "string",
          enum: [
            "burstable",
            "general-purpose",
            "memory-optimized",
            "compute-optimized",
            "gpu",
            "storage-optimized",
            "graviton-arm",
          ],
        },
        free_tier_only: { type: "boolean" },
      },
    },
  },
];

const CUSTOM_TOOL_NAMES = new Set(CUSTOM_TOOLS.map((t) => t.name));

export function isCustomTool(name: string): boolean {
  return CUSTOM_TOOL_NAMES.has(name);
}

export async function callCustomTool(
  name: string,
  input: unknown
): Promise<{
  content: string | Anthropic.ToolResultBlockParam["content"];
  is_error: boolean;
}> {
  if (name === "deploy_bicep") {
    return runBicepDeploy(input as DeployBicepInput);
  }
  if (name === "destroy_azure") {
    return runDestroy(input as DestroyAzureInput);
  }
  if (name === "validate_bicep") {
    return runValidateBicep(input as { bicep?: string });
  }
  if (name === "list_vm_skus") {
    return runListVmSkus(
      input as { family?: string; free_tier_only?: boolean }
    );
  }
  if (name === "validate_cloudformation") {
    return runValidateCloudFormation(input as CfnSource);
  }
  if (name === "deploy_cloudformation") {
    return runDeployCloudFormation(input as DeployCfnInput);
  }
  if (name === "destroy_aws") {
    return runDestroyAws(input as DestroyAwsInput);
  }
  if (name === "list_ec2_types") {
    return runListEc2Types(
      input as { family?: string; free_tier_only?: boolean }
    );
  }
  return {
    content: `unknown custom tool: ${name}`,
    is_error: true,
  };
}

async function runListEc2Types(input: {
  family?: string;
  free_tier_only?: boolean;
}): Promise<{ content: string; is_error: boolean }> {
  let types = CURATED_EC2_TYPES;
  if (input.family) {
    types = types.filter((t) => t.family === input.family);
  }
  if (input.free_tier_only) {
    types = types.filter((t) => t.free_tier);
  }
  return {
    content: JSON.stringify(
      {
        count: types.length,
        free_tier_note:
          "AWS's 12-month free tier covers 750 hrs/mo of t3.micro Linux on NEW accounts (or t2.micro in regions where t3 isn't available). Free-tier hours are account-wide, not per-instance.",
        types,
      },
      null,
      2
    ),
    is_error: false,
  };
}

async function runListVmSkus(input: {
  family?: string;
  free_tier_only?: boolean;
}): Promise<{ content: string; is_error: boolean }> {
  let skus = CURATED_VM_SKUS;
  if (input.family) {
    skus = skus.filter((s) => s.family === input.family);
  }
  if (input.free_tier_only) {
    skus = skus.filter((s) => s.free_tier);
  }
  return {
    content: JSON.stringify(
      {
        count: skus.length,
        free_tier_note:
          "Azure's 12-month free tier covers 750 hrs/mo of B1s Linux + 750 hrs/mo of B1s Windows on NEW accounts. There is no perpetual VM free tier.",
        skus,
      },
      null,
      2
    ),
    is_error: false,
  };
}

/** Bicep input shape shared by validate_bicep and deploy_bicep. Either
 *  `bicep` (single file) or `files` (multi-file) must be provided. */
type BicepSource = {
  bicep?: string;
  files?: Record<string, string>;
  entry?: string;
};

/** Resolve a BicepSource into a concrete plan: a unique workspace
 *  prefix, the absolute /work paths to write, and which one to compile.
 *  Filename safety is enforced — no slashes, no `..`, must end in `.bicep`. */
type BicepPlan = {
  /** Random session id used to namespace the files in /work so concurrent
   *  validate/deploy calls don't collide on filenames. */
  sessionDir: string;
  /** Map of /work-relative path → content, ready to writeFile. */
  toWrite: Map<string, string>;
  /** /work-relative path of the entry point (what `az bicep build`
   *  / `az deployment ... --template-file` runs against). */
  entryPath: string;
};

const FILENAME_RE = /^[a-zA-Z0-9_.-]+\.bicep$/;

function planBicepWrite(
  src: BicepSource,
  kind: "validate" | "deploy"
): { plan: BicepPlan } | { error: string } {
  const session = `${kind}-${randomUUID().slice(0, 8)}`;
  // Single-file path: keep the original behaviour. Write as
  // <session>.bicep at the workspace root.
  if (src.bicep && !src.files) {
    if (typeof src.bicep !== "string" || src.bicep.trim().length === 0) {
      return { error: "`bicep` must be a non-empty string" };
    }
    const file = `${session}.bicep`;
    return {
      plan: {
        sessionDir: session,
        toWrite: new Map([[file, src.bicep]]),
        entryPath: file,
      },
    };
  }
  // Multi-file path: write under /work/<session>/ so neighbour-file
  // refs (`module x './foo.bicep'`) resolve naturally.
  if (src.files) {
    const names = Object.keys(src.files);
    if (names.length === 0) {
      return { error: "`files` must contain at least one entry" };
    }
    for (const name of names) {
      if (!FILENAME_RE.test(name)) {
        return {
          error: `invalid filename in \`files\`: '${name}'. Must match ${FILENAME_RE} (plain name, no slashes, no '..', must end with .bicep)`,
        };
      }
      const content = src.files[name];
      if (typeof content !== "string") {
        return { error: `\`files['${name}']\` must be a string` };
      }
    }
    const entry = src.entry ?? "main.bicep";
    if (!FILENAME_RE.test(entry)) {
      return { error: `invalid \`entry\`: '${entry}'` };
    }
    if (!names.includes(entry)) {
      return {
        error: `\`entry\`='${entry}' but it is not present in \`files\`. Provide its content under \`files['${entry}']\`.`,
      };
    }
    const toWrite = new Map<string, string>();
    for (const name of names) {
      toWrite.set(`${session}/${name}`, src.files[name]!);
    }
    return {
      plan: {
        sessionDir: session,
        toWrite,
        entryPath: `${session}/${entry}`,
      },
    };
  }
  return {
    error:
      "either `bicep` (single-file string) or `files` (object map) is required",
  };
}

/** Materialise a plan to disk. Returns the absolute /work paths so the
 *  caller can pass `entryPath` to `az bicep build` / `az deployment`,
 *  and clean up the rest in `finally`. */
async function materialisePlan(
  plan: BicepPlan
): Promise<{ entryWorkPath: string; cleanupPaths: string[] }> {
  const cleanupPaths: string[] = [];
  // Pre-create the session subdir for multi-file plans by writing
  // the first file (writeFile creates parents implicitly via mkdir
  // recursive in Node? — actually no, writeFile doesn't mkdir. We do
  // it explicitly here.)
  const isMulti = [...plan.toWrite.keys()][0]?.includes("/") ?? false;
  if (isMulti) {
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(WORKSPACE, plan.sessionDir), { recursive: true })
    );
  }
  for (const [rel, content] of plan.toWrite) {
    const abs = join(WORKSPACE, rel);
    await writeFile(abs, content, "utf8");
    cleanupPaths.push(abs);
  }
  return {
    entryWorkPath: `/work/${plan.entryPath}`,
    cleanupPaths,
  };
}

async function cleanupPlanFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await unlink(p);
    } catch {
      /* ignore */
    }
  }
}

async function runValidateBicep(input: BicepSource): Promise<{
  content: string;
  is_error: boolean;
}> {
  const planned = planBicepWrite(input, "validate");
  if ("error" in planned) {
    return { content: planned.error, is_error: true };
  }
  const { entryWorkPath, cleanupPaths } = await materialisePlan(planned.plan);

  try {
    // No `az login` needed — `az bicep build` is purely local. We
    // build to /dev/null because we only care about compile output,
    // not the resulting ARM JSON.
    // The path is built from a UUID plus a FILENAME_RE-checked name, so
    // it's already safe — but it still travels as an env var so that the
    // "no tool input in script text" rule holds for every `sh -c` in this
    // file without exception.
    const dockerArgs = [
      "run",
      "--rm",
      "-v",
      `${WORKSPACE_VOLUME}:/work`,
      "-e",
      `VALIDATE_ENTRY=${entryWorkPath}`,
      AZURE_CLI_IMAGE,
      "sh",
      "-c",
      `az bicep build --file "$VALIDATE_ENTRY" --stdout > /dev/null`,
    ];

    const result = await spawnAndCapture("docker", dockerArgs, {
      timeoutMs: 90_000,
    });

    const ok = result.code === 0;
    const summary = ok
      ? `# validate_bicep — OK\n\nTemplate compiles cleanly. Safe to emit the \`<bicep>\` marker.`
      : [
          `# validate_bicep — FAILED (exit ${result.code})`,
          ``,
          `## errors`,
          "```",
          (result.stderr.trim() || result.stdout.trim()).slice(-3000),
          "```",
          ``,
          `Fix these issues, then call \`validate_bicep\` again before emitting the \`<bicep>\` marker.`,
        ].join("\n");

    return { content: summary, is_error: !ok };
  } finally {
    await cleanupPlanFiles(cleanupPaths);
  }
}

type DestroyAzureInput = {
  resource_group_name?: string;
  tag_filters?: Record<string, string>;
  /** When falsy, the tool only reports what it WOULD delete. */
  confirm?: boolean;
};

/**
 * Build the docker args + shell script for a destroy_azure call.
 *
 * Split out from `runDestroy` so tests can inspect exactly what would be
 * executed without spawning anything. Two invariants this function is
 * responsible for, both covered by tests:
 *   - `shellScript` contains no caller-supplied text, only `$VAR` refs.
 *   - `dockerArgs` contains no secret VALUES, only `-e NAME` passthroughs.
 */
export function buildDestroyAzureCommand(
  input: DestroyAzureInput
): { dockerArgs: string[]; shellScript: string; willDelete: boolean } | { error: string } {
  const targetRG = input.resource_group_name?.trim();
  const tags = input.tag_filters ?? {};
  const tagEntries = Object.entries(tags).filter(([k, v]) => k && v) as [
    string,
    string,
  ][];
  const confirm = input.confirm === true;

  if (!targetRG && tagEntries.length === 0) {
    return {
      error:
        "destroy_azure requires either `resource_group_name` or non-empty `tag_filters`",
    };
  }

  // ── Validation ────────────────────────────────────────────────
  // Runs before anything is built, so a bad input never reaches docker.
  const validationError =
    validateAzureResourceGroup("resource_group_name", targetRG) ??
    validateTags("tag_filters", input.tag_filters) ??
    // A tag-filter destroy sweeps the whole subscription looking for
    // matches, so it must be anchored to one project. See issue #9.
    (tagEntries.length > 0
      ? requireProjectAnchor("tag_filters", tagEntries)
      : null);
  if (validationError) return { error: validationError };

  const creds = azureCredDockerArgs();
  if ("error" in creds) return { error: creds.error };

  // ── Environment handed to the container ──────────────────────
  // Everything dynamic lives here. Nothing below interpolates it into
  // the script text.
  const env: Record<string, string> = {
    DESTROY_MAX_GROUPS: String(DESTROY_MAX_GROUPS),
  };
  if (targetRG) env.DESTROY_RG = targetRG;
  if (tagEntries.length > 0) {
    env.DESTROY_TAGS_DESC = tagEntries.map(([k, v]) => `${k}=${v}`).join(", ");
    // `az group list` returns every RG the SP can see; the CLI's --tag
    // flag only handles one tag, so we AND the filters in JMESPath
    // client-side. Tag keys and values are validated above, so neither
    // can terminate the JMESPath string literals.
    const jmesCond = tagEntries
      .map(([k, v]) => `tags."${k}"=='${v}'`)
      .join(" && ");
    env.DESTROY_JMES_GROUPS = `[?${jmesCond}].name`;
    env.DESTROY_JMES_RESOURCES = `[?${jmesCond}] | [].id`;
  }

  const lines: string[] = [
    `set -e`,
    `az login --service-principal -u "$AZURE_CLIENT_ID" -p "$AZURE_CLIENT_SECRET" --tenant "$AZURE_TENANT_ID" --output none`,
    `az account set --subscription "$AZURE_SUBSCRIPTION_ID"`,
    confirm
      ? `echo "## destroy_azure — EXECUTING (confirm=true)"`
      : `echo "## destroy_azure — DRY RUN (confirm not set; nothing will be deleted)"`,
    `if [ -n "$DESTROY_RG" ]; then echo "target resource group: $DESTROY_RG"; fi`,
    `if [ -n "$DESTROY_TAGS_DESC" ]; then echo "tag filters: $DESTROY_TAGS_DESC"; fi`,
  ];

  if (tagEntries.length > 0) {
    // Always list first, in both modes — the dry run needs the list, and
    // the confirmed run needs it to know what to delete and to check the
    // safety cap.
    lines.push(
      `echo ""`,
      `echo "## resource groups matching the tag filter"`,
      `RGS=$(az group list --query "$DESTROY_JMES_GROUPS" -o tsv)`,
      `if [ -z "$RGS" ]; then echo "(none)"; else echo "$RGS"; fi`,
      // grep -c exits 1 on no match, which `set -e` would treat as fatal.
      `RG_COUNT=$(printf '%s\\n' "$RGS" | grep -c . || true)`,
      `echo "matched resource groups: $RG_COUNT"`,
      `echo ""`,
      `echo "## standalone resources matching the tag filter"`,
      `RES=$(az resource list --query "$DESTROY_JMES_RESOURCES" -o tsv)`,
      `if [ -z "$RES" ]; then echo "(none)"; else echo "$RES"; fi`
    );
    if (confirm) {
      lines.push(
        // Sanity cap. A filter matching dozens of resource groups is
        // almost certainly wrong, and the blast radius is "everything
        // the service principal can see".
        `if [ "$RG_COUNT" -gt "$DESTROY_MAX_GROUPS" ]; then`,
        `  echo ""`,
        `  echo "REFUSED: the tag filter matched $RG_COUNT resource groups, above the safety cap of $DESTROY_MAX_GROUPS."`,
        `  echo "Nothing was deleted. Narrow the tag filter, or raise AZURE_MCP_DESTROY_MAX_GROUPS if a teardown this large is genuinely intended."`,
        `  exit 3`,
        `fi`,
        `echo ""`,
        `echo "## deleting matched resource groups"`,
        `for RG in $RGS; do`,
        `  echo "deleting RG: $RG"`,
        `  az group delete --name "$RG" --yes --no-wait || true`,
        `done`,
        `if [ -n "$RES" ]; then`,
        `  echo ""`,
        `  echo "## deleting standalone resources"`,
        `  echo "$RES" | xargs -r az resource delete --ids || true`,
        `fi`
      );
    }
  }

  if (targetRG) {
    if (confirm) {
      lines.push(
        `echo ""`,
        `echo "## deleting resource group $DESTROY_RG"`,
        `az group delete --name "$DESTROY_RG" --yes --no-wait || true`
      );
    } else {
      lines.push(
        `echo ""`,
        `echo "## resource group $DESTROY_RG (would be deleted, with everything in it)"`,
        // `if <cmd>` is exempt from `set -e`, so a missing RG is reported
        // rather than aborting the dry run.
        `if az group show --name "$DESTROY_RG" -o none 2>/dev/null; then`,
        `  az resource list -g "$DESTROY_RG" --query "[].id" -o tsv || true`,
        `else`,
        `  echo "(resource group does not exist)"`,
        `fi`
      );
    }
  }

  // Wait for the --no-wait deletions to actually finish before we return
  // — otherwise Claude reports "deleted" while Azure is still working.
  // Only relevant on a confirmed run; a dry run deletes nothing.
  if (confirm && tagEntries.length > 0) {
    lines.push(
      `echo ""`,
      `echo "## waiting for deletions to complete"`,
      `for i in $(seq 1 60); do`,
      `  REMAINING=$(az group list --query "$DESTROY_JMES_GROUPS" -o tsv 2>/dev/null || echo "")`,
      `  if [ -z "$REMAINING" ]; then echo "all matching RGs gone"; break; fi`,
      `  echo "still pending: $REMAINING"; sleep 10`,
      `done`
    );
  }
  if (confirm && targetRG) {
    lines.push(
      `echo ""`,
      `echo "## waiting for $DESTROY_RG to be gone"`,
      `for i in $(seq 1 60); do`,
      `  if ! az group show --name "$DESTROY_RG" -o none 2>/dev/null; then echo "$DESTROY_RG gone"; break; fi`,
      `  sleep 10`,
      `done`
    );
  }

  if (!confirm) {
    lines.push(
      `echo ""`,
      `echo "## DRY RUN COMPLETE — nothing was deleted."`,
      `echo "To delete the items listed above, call destroy_azure again with the same arguments plus confirm: true."`
    );
  }

  const shellScript = lines.join("\n");

  const dockerArgs = [
    "run",
    "--rm",
    // Secrets by name only — no values on the argv.
    ...creds.args,
    // Non-secret dynamic values, passed as literal strings docker hands
    // to the container. These never touch a shell on the way in.
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    AZURE_CLI_IMAGE,
    "sh",
    "-c",
    shellScript,
  ];

  return { dockerArgs, shellScript, willDelete: confirm };
}

async function runDestroy(input: DestroyAzureInput): Promise<{
  content: string;
  is_error: boolean;
}> {
  const built = buildDestroyAzureCommand(input);
  if ("error" in built) {
    return { content: built.error, is_error: true };
  }

  const result = await spawnAndCapture("docker", built.dockerArgs, {
    timeoutMs: 30 * 60 * 1000,
  });

  const heading = built.willDelete
    ? `# destroy_azure — DELETE executed (exit ${result.code})`
    : `# destroy_azure — DRY RUN, nothing deleted (exit ${result.code})`;

  const footer = built.willDelete
    ? ""
    : "**This was a dry run.** Nothing has been deleted. Show the user the list above; " +
      "if it is what they want removed, call `destroy_azure` again with the same arguments plus `confirm: true`.";

  const summary = [
    heading,
    ``,
    "## stdout",
    "```",
    result.stdout.slice(-6000),
    "```",
    result.stderr.trim().length > 0
      ? `## stderr\n\n\`\`\`\n${result.stderr.slice(-3000)}\n\`\`\``
      : "",
    footer,
  ]
    .filter(Boolean)
    .join("\n");

  return { content: summary, is_error: result.code !== 0 };
}

type DeployBicepInput = BicepSource & {
  scope: "subscription" | "resourceGroup";
  location?: string;
  resource_group_name?: string;
  deployment_name?: string;
  required_tags?: Record<string, string>;
};

/**
 * Build the docker args + shell script for an `az deployment ... create`.
 *
 * Every dynamic value — region, resource group, deployment name, template
 * path, and each required tag — is handed to the container as an
 * environment variable. The script text below is entirely static, so
 * there is nothing for a hostile value to break out of.
 *
 * Exported so tests can assert those invariants without spawning docker.
 */
export function buildBicepDeployCommand(opts: {
  scope: "subscription" | "resourceGroup";
  location?: string;
  resourceGroupName?: string;
  deploymentName: string;
  entryWorkPath: string;
  requiredTags?: Record<string, string>;
}): { dockerArgs: string[]; shellScript: string } | { error: string } {
  const creds = azureCredDockerArgs();
  if ("error" in creds) return { error: creds.error };

  const tagPairs = Object.entries(opts.requiredTags ?? {}).filter(
    ([k, v]) => k && v
  );

  const env: Record<string, string> = {
    DEPLOY_NAME: opts.deploymentName,
    DEPLOY_ENTRY: opts.entryWorkPath,
  };
  if (opts.location) env.DEPLOY_LOCATION = opts.location;
  if (opts.resourceGroupName) env.DEPLOY_RG = opts.resourceGroupName;
  // Newline-delimited `key=value` pairs. The script splits on newlines
  // (not spaces) so a tag value containing a space survives intact.
  if (tagPairs.length > 0) {
    env.DEPLOY_TAG_PAIRS = tagPairs.map(([k, v]) => `${k}=${v}`).join("\n");
  }

  const isSub = opts.scope === "subscription";
  const azCmd = isSub
    ? `az deployment sub create --location "$DEPLOY_LOCATION" --template-file "$DEPLOY_ENTRY" --name "$DEPLOY_NAME"`
    : `az deployment group create --resource-group "$DEPLOY_RG" --template-file "$DEPLOY_ENTRY" --name "$DEPLOY_NAME"`;
  const showCmd = isSub
    ? `az deployment sub show --name "$DEPLOY_NAME"`
    : `az deployment group show --resource-group "$DEPLOY_RG" --name "$DEPLOY_NAME"`;

  // Post-deploy tag enforcement. We list the deployment's outputResources
  // and `az tag update --operation Merge` each one, so the required tags
  // are guaranteed regardless of what the Bicep template wrote. Idempotent
  // — Merge updates the value if the key exists, adds it if not, and
  // leaves other tags alone.
  const tagBlock =
    tagPairs.length === 0
      ? `echo "(no required_tags supplied — skipping tag enforcement)"`
      : [
          // Load the tag pairs into the positional parameters so they can
          // be passed as separate arguments via "$@". IFS is a literal
          // newline for the duration of the split.
          `OLDIFS=$IFS`,
          `IFS='\n'`,
          `set -- $DEPLOY_TAG_PAIRS`,
          `IFS=$OLDIFS`,
          // Capture deployment-output resource ids — for sub-scoped
          // deployments these are the resource groups; for group-scoped
          // they're the individual resources. Either way we walk them.
          `RIDS=$(${showCmd} --query "properties.outputResources[].id" -o tsv 2>/dev/null || echo "")`,
          `if [ -z "$RIDS" ]; then echo "(no output resources to tag)"; else`,
          `  echo "$RIDS" | while read -r rid; do`,
          `    [ -z "$rid" ] && continue`,
          `    echo "tagging $rid"`,
          `    az tag update --resource-id "$rid" --operation Merge --tags "$@" -o none || echo "  (warn: tag update failed for $rid)"`,
          `  done`,
          `  # Also apply tags directly to any resource group named in the deployment.`,
          `  echo "$RIDS" | grep -i "/resourcegroups/" | grep -ivE "/providers/" | while read -r rgid; do`,
          `    [ -z "$rgid" ] && continue`,
          // The azure-cli image is alpine-based and does NOT ship awk by
          // default; using `cut` keeps this portable across image updates.
          `    rgname=$(echo "$rgid" | cut -d/ -f5)`,
          `    echo "applying tags to RG $rgname (and child resources)"`,
          `    az tag update --resource-id "$rgid" --operation Merge --tags "$@" -o none || true`,
          `    # Cascade to every resource in the RG so tag-filter destroy can find them.`,
          `    az resource list -g "$rgname" --query "[].id" -o tsv | while read -r rid; do`,
          `      [ -z "$rid" ] && continue`,
          `      az tag update --resource-id "$rid" --operation Merge --tags "$@" -o none || true`,
          `    done`,
          `  done`,
          `fi`,
        ].join("\n");

  const shellScript = [
    `set -e`,
    // Login as the SP (these env vars come from --env passthrough).
    `az login --service-principal -u "$AZURE_CLIENT_ID" -p "$AZURE_CLIENT_SECRET" --tenant "$AZURE_TENANT_ID" --output none`,
    `az account set --subscription "$AZURE_SUBSCRIPTION_ID"`,
    `echo "## az deployment"`,
    `${azCmd} --output json`,
    `echo ""`,
    `echo "## tag enforcement"`,
    `set +e`,
    tagBlock,
  ].join("\n");

  const dockerArgs = [
    "run",
    "--rm",
    "-v",
    `${WORKSPACE_VOLUME}:/work`,
    // Secrets by name only — no values on the argv.
    ...creds.args,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    AZURE_CLI_IMAGE,
    "sh",
    "-c",
    shellScript,
  ];

  return { dockerArgs, shellScript };
}

async function runBicepDeploy(input: DeployBicepInput): Promise<{
  content: string;
  is_error: boolean;
}> {
  const errors: string[] = [];
  if (!input.bicep && !input.files)
    errors.push("either `bicep` or `files` is required");
  if (input.bicep && input.files)
    errors.push("`bicep` and `files` are mutually exclusive — use one");
  if (input.scope !== "subscription" && input.scope !== "resourceGroup")
    errors.push("`scope` must be 'subscription' or 'resourceGroup'");
  if (input.scope === "subscription" && !input.location)
    errors.push("`location` is required when scope='subscription'");
  if (input.scope === "resourceGroup" && !input.resource_group_name)
    errors.push("`resource_group_name` is required when scope='resourceGroup'");

  // Allowlist every value that will reach the sidecar. These are also
  // passed as env vars rather than script text (see buildBicepDeployCommand),
  // so this is the second layer — but it fails fast, with a message the
  // model can act on, before we spend time on pre-flight compilation.
  const invalid = [
    validateAzureLocation("location", input.location),
    validateAzureResourceGroup("resource_group_name", input.resource_group_name),
    validateDeploymentName("deployment_name", input.deployment_name),
    validateTags("required_tags", input.required_tags),
  ].filter((e): e is string => e !== null);
  errors.push(...invalid);

  if (errors.length > 0) {
    return { content: errors.join("\n"), is_error: true };
  }

  // 0. Defence-in-depth pre-validate. Pass through whatever shape we
  // received (single-file or files map) so multi-file refs resolve.
  const preValidate = await runValidateBicep({
    bicep: input.bicep,
    files: input.files,
    entry: input.entry,
  });
  if (preValidate.is_error) {
    return {
      content:
        "# deploy_bicep — pre-flight validation FAILED\n\n" +
        "The template did not compile. Fix the errors below, then call deploy_bicep again with the corrected Bicep.\n\n" +
        preValidate.content,
      is_error: true,
    };
  }

  const id = input.deployment_name ?? `azmcp-${randomUUID().slice(0, 8)}`;

  // 1. Plan + materialise the template files. We re-plan rather than
  // reuse the validate session so the deploy gets its own clean
  // namespace (and so `azmcp-*.bicep` shows up in /work for debugging
  // matched the deployment id).
  const planned = planBicepWrite(
    { bicep: input.bicep, files: input.files, entry: input.entry },
    "deploy"
  );
  if ("error" in planned) {
    return { content: planned.error, is_error: true };
  }
  // Override the session prefix to match the deployment name so the
  // /work directory is greppable by deployment id.
  const plan: BicepPlan = {
    ...planned.plan,
    // Keep the auto-generated session for randomness, but we still
    // use the user-facing `id` for the deployment --name flag.
  };
  const { entryWorkPath, cleanupPaths } = await materialisePlan(plan);

  try {
    // 2. Build the az command and spawn the azure-cli container.
    const built = buildBicepDeployCommand({
      scope: input.scope,
      location: input.location,
      resourceGroupName: input.resource_group_name,
      deploymentName: id,
      entryWorkPath,
      requiredTags: input.required_tags,
    });
    if ("error" in built) {
      return { content: built.error, is_error: true };
    }

    const result = await spawnAndCapture("docker", built.dockerArgs, {
      timeoutMs: 30 * 60 * 1000, // 30 minute hard cap on a single deployment
    });

    const summary = [
      `# az deployment ${input.scope === "subscription" ? "sub" : "group"} create — ${id}`,
      ``,
      `**exit code:** ${result.code}`,
      ``,
      `## stdout`,
      "```",
      result.stdout.slice(0, 8000),
      "```",
      result.stderr.trim().length > 0 ? `## stderr\n\n\`\`\`\n${result.stderr.slice(0, 4000)}\n\`\`\`` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: summary,
      is_error: result.code !== 0,
    };
  } finally {
    // 3. Best-effort cleanup — don't blow up the tool result on this.
    await cleanupPlanFiles(cleanupPaths);
    // Also drop the session subdir if multi-file (so /work doesn't
    // accumulate empty dirs across many deployments).
    if (plan.entryPath.includes("/")) {
      try {
        await import("node:fs/promises").then((fs) =>
          fs.rmdir(join(WORKSPACE, plan.sessionDir))
        );
      } catch {
        /* ignore — directory may not exist or may have other files */
      }
    }
  }
}

// ── AWS / CloudFormation handlers ─────────────────────────────────
//
// Mirrors the Bicep trio: planBicepWrite → materialisePlan →
// spawnAndCapture(docker run aws-cli) → cleanup. The shared
// helpers (planBicepWrite, materialisePlan, spawnAndCapture) are
// generic over filename — they don't care that the templates
// happen to be YAML/JSON instead of Bicep. We just pass a
// different FILENAME_RE-equivalent for CFN, matching .yaml/.yml/.json.

const CFN_FILENAME_RE = /^[a-zA-Z0-9_.-]+\.(yaml|yml|json)$/i;

type CfnSource = {
  template?: string;
  files?: Record<string, string>;
  entry?: string;
};

type CfnPlan = {
  sessionDir: string;
  toWrite: Map<string, string>;
  entryPath: string;
};

function planCfnWrite(
  src: CfnSource,
  kind: "validate" | "deploy"
): { plan: CfnPlan } | { error: string } {
  const session = `cfn-${kind}-${randomUUID().slice(0, 8)}`;
  if (src.template && !src.files) {
    if (typeof src.template !== "string" || src.template.trim().length === 0) {
      return { error: "`template` must be a non-empty string" };
    }
    // Sniff the format from the first non-blank char so we name the
    // file with the right extension. CFN-cli is happy with either.
    const trimmed = src.template.trimStart();
    const ext = trimmed.startsWith("{") ? "json" : "yaml";
    const file = `${session}.${ext}`;
    return {
      plan: {
        sessionDir: session,
        toWrite: new Map([[file, src.template]]),
        entryPath: file,
      },
    };
  }
  if (src.files) {
    const names = Object.keys(src.files);
    if (names.length === 0) return { error: "`files` must contain at least one entry" };
    for (const name of names) {
      if (!CFN_FILENAME_RE.test(name)) {
        return {
          error: `invalid filename in \`files\`: '${name}'. Must match plain-name + .yaml/.yml/.json`,
        };
      }
      if (typeof src.files[name] !== "string") {
        return { error: `\`files['${name}']\` must be a string` };
      }
    }
    const entry = src.entry ?? "main.yaml";
    if (!CFN_FILENAME_RE.test(entry)) {
      return { error: `invalid \`entry\`: '${entry}'` };
    }
    if (!names.includes(entry)) {
      return {
        error: `\`entry\`='${entry}' but it is not present in \`files\`.`,
      };
    }
    const toWrite = new Map<string, string>();
    for (const name of names) toWrite.set(`${session}/${name}`, src.files[name]!);
    return {
      plan: {
        sessionDir: session,
        toWrite,
        entryPath: `${session}/${entry}`,
      },
    };
  }
  return {
    error: "either `template` (single-file string) or `files` (object map) is required",
  };
}

/** Common docker args for spawning an aws-cli sidecar with the
 *  user's credentials and the deploy workspace.
 *
 *  Auth precedence (matches the AWS SDK default chain):
 *    1. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars (long-
 *       lived IAM access keys — primary path for our homelab tool,
 *       same shape as the Azure SP).
 *    2. Mounted ~/.aws (SSO session) — fallback for users running
 *       `aws sso login` on the host. */
function awsCliDockerArgs(extraEnv: Record<string, string> = {}): string[] {
  const args = [
    "run",
    "--rm",
    "-v",
    `${WORKSPACE_VOLUME}:/work`,
  ];
  // Pass IAM access keys when configured. These take precedence
  // over any ~/.aws mount because they're more deterministic
  // (no SSO refresh window, no profile lookup).
  //
  // Passed by NAME (`-e AWS_SECRET_ACCESS_KEY`, no `=value`): docker
  // forwards the value from this process's environment, so the key never
  // appears on the sidecar's command line where `ps auxww` or
  // `docker inspect` would show it.
  if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
    args.push(...awsCredDockerArgs());
  } else if (AWS_HOST_CONFIG_PATH) {
    // SSO fallback: mount the host's ~/.aws into the sidecar.
    args.push("-v", `${AWS_HOST_CONFIG_PATH}:/root/.aws:ro`);
  }
  // If neither auth path is set, the sidecar runs unauthenticated
  // and any CFN call fails with "Unable to locate credentials" —
  // we surface that error verbatim rather than guess.
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v !== undefined && v !== "") args.push("-e", `${k}=${v}`);
  }
  args.push(AWS_CLI_IMAGE);
  return args;
}

async function runValidateCloudFormation(input: CfnSource): Promise<{
  content: string;
  is_error: boolean;
}> {
  const planned = planCfnWrite(input, "validate");
  if ("error" in planned) {
    return { content: planned.error, is_error: true };
  }
  // We don't strictly need ~/.aws to validate, but aws-cli sometimes
  // 400s on validate-template if the region resolver can't find a
  // home — passing AWS_DEFAULT_REGION sidesteps that.
  const cleanupPaths: string[] = [];
  const isMulti = [...planned.plan.toWrite.keys()][0]?.includes("/") ?? false;
  if (isMulti) {
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(WORKSPACE, planned.plan.sessionDir), { recursive: true })
    );
  }
  for (const [rel, content] of planned.plan.toWrite) {
    const abs = join(WORKSPACE, rel);
    await writeFile(abs, content, "utf8");
    cleanupPaths.push(abs);
  }
  const entryWorkPath = `/work/${planned.plan.entryPath}`;

  try {
    const dockerArgs = [
      ...awsCliDockerArgs({
        AWS_DEFAULT_REGION,
        AWS_PROFILE,
      }),
      "cloudformation",
      "validate-template",
      "--template-body",
      `file://${entryWorkPath}`,
    ];
    const result = await spawnAndCapture("docker", dockerArgs, {
      timeoutMs: 90_000,
    });
    const ok = result.code === 0;
    const summary = ok
      ? `# validate_cloudformation — OK\n\nTemplate is well-formed. Safe to emit the \`<bicep>\` marker.`
      : [
          `# validate_cloudformation — FAILED (exit ${result.code})`,
          ``,
          `## errors`,
          "```",
          (result.stderr.trim() || result.stdout.trim()).slice(-3000),
          "```",
          ``,
          `Fix these issues, then call \`validate_cloudformation\` again before emitting the \`<bicep>\` marker.`,
        ].join("\n");
    return { content: summary, is_error: !ok };
  } finally {
    await cleanupPlanFiles(cleanupPaths);
  }
}

type DeployCfnInput = CfnSource & {
  stack_name: string;
  region?: string;
  capabilities?: string[];
  required_tags?: Record<string, string>;
};

async function runDeployCloudFormation(input: DeployCfnInput): Promise<{
  content: string;
  is_error: boolean;
}> {
  if (!AWS_AUTH_CONFIGURED) {
    return {
      content:
        "# deploy_cloudformation — AWS not configured\n\n" +
        "Set EITHER `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (long-lived IAM keys, recommended for homelab) " +
        "OR `AWS_HOST_CONFIG_PATH` (path to host's `~/.aws` for SSO sessions) in the backend's `.env`, then restart the backend.",
      is_error: true,
    };
  }
  // Validate everything that reaches the aws CLI. These go on the argv
  // as separate arguments (no shell involved), but a bad region or stack
  // name should fail fast with a message the model can act on, and the
  // tags end up on the stack where the destroy-by-tag flow reads them.
  const cfnErrors = [
    input.stack_name ? null : "`stack_name` is required.",
    validateStackName("stack_name", input.stack_name),
    validateAwsRegion("region", input.region),
    validateTags("required_tags", input.required_tags),
  ].filter((e): e is string => e !== null);
  if (cfnErrors.length > 0) {
    return { content: cfnErrors.join("\n"), is_error: true };
  }
  // Pre-flight validate so we never attempt a CFN deploy on a
  // template that won't parse — same defence-in-depth as Bicep.
  const preValidate = await runValidateCloudFormation({
    template: input.template,
    files: input.files,
    entry: input.entry,
  });
  if (preValidate.is_error) {
    return {
      content:
        "# deploy_cloudformation — pre-flight validation FAILED\n\n" +
        preValidate.content,
      is_error: true,
    };
  }

  const planned = planCfnWrite(
    { template: input.template, files: input.files, entry: input.entry },
    "deploy"
  );
  if ("error" in planned) {
    return { content: planned.error, is_error: true };
  }
  const plan = planned.plan;
  const isMulti = [...plan.toWrite.keys()][0]?.includes("/") ?? false;
  if (isMulti) {
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(WORKSPACE, plan.sessionDir), { recursive: true })
    );
  }
  const cleanupPaths: string[] = [];
  for (const [rel, content] of plan.toWrite) {
    const abs = join(WORKSPACE, rel);
    await writeFile(abs, content, "utf8");
    cleanupPaths.push(abs);
  }
  const entryWorkPath = `/work/${plan.entryPath}`;
  const region = input.region ?? AWS_DEFAULT_REGION;

  try {
    // `aws cloudformation deploy` is the high-level wrapper that
    // creates-or-updates as appropriate, waits for the change set
    // to settle, and exits non-zero on failure. Cleaner than
    // create-stack + wait-for-stack-create-complete.
    const tagPairs = Object.entries(input.required_tags ?? {}).filter(
      ([k, v]) => k && v
    );
    const args = [
      "cloudformation",
      "deploy",
      "--stack-name",
      input.stack_name,
      "--template-file",
      entryWorkPath,
      "--region",
      region,
      "--no-fail-on-empty-changeset",
    ];
    if (input.capabilities && input.capabilities.length > 0) {
      args.push("--capabilities", ...input.capabilities);
    }
    if (tagPairs.length > 0) {
      args.push("--tags", ...tagPairs.map(([k, v]) => `${k}=${v}`));
    }

    const dockerArgs = [
      ...awsCliDockerArgs({ AWS_DEFAULT_REGION: region, AWS_PROFILE }),
      ...args,
    ];

    const result = await spawnAndCapture("docker", dockerArgs, {
      timeoutMs: 30 * 60 * 1000,
    });
    const summary = [
      `# aws cloudformation deploy — ${input.stack_name}`,
      ``,
      `**exit code:** ${result.code}`,
      ``,
      `## stdout`,
      "```",
      result.stdout.slice(0, 8000),
      "```",
      result.stderr.trim().length > 0
        ? `## stderr\n\n\`\`\`\n${result.stderr.slice(0, 4000)}\n\`\`\``
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { content: summary, is_error: result.code !== 0 };
  } finally {
    await cleanupPlanFiles(cleanupPaths);
    if (plan.entryPath.includes("/")) {
      try {
        await import("node:fs/promises").then((fs) =>
          fs.rmdir(join(WORKSPACE, plan.sessionDir))
        );
      } catch {
        /* ignore */
      }
    }
  }
}

type DestroyAwsInput = {
  stack_name?: string;
  tag_filters?: Record<string, string>;
  region?: string;
};

/**
 * Build the docker args + shell script for a destroy_aws call.
 *
 * Same contract as the Azure builders: static script text, every dynamic
 * value handed over as an environment variable, secrets by name only.
 * Exported for tests.
 */
export function buildDestroyAwsCommand(
  input: DestroyAwsInput
): { dockerArgs: string[]; shellScript: string } | { error: string } {
  const stack = input.stack_name?.trim();
  const tags = input.tag_filters ?? {};
  const tagEntries = Object.entries(tags).filter(([k, v]) => k && v) as [
    string,
    string,
  ][];
  if (!stack && tagEntries.length === 0) {
    return {
      error: "destroy_aws requires either `stack_name` or non-empty `tag_filters`",
    };
  }

  const validationError =
    validateStackName("stack_name", stack) ??
    validateAwsRegion("region", input.region) ??
    validateTags("tag_filters", input.tag_filters);
  if (validationError) return { error: validationError };

  const region = input.region ?? AWS_DEFAULT_REGION;

  const env: Record<string, string> = { DESTROY_REGION: region };
  if (stack) env.DESTROY_STACK = stack;
  if (tagEntries.length > 0) {
    env.DESTROY_TAGS_DESC = tagEntries.map(([k, v]) => `${k}=${v}`).join(", ");
    // describe-stacks returns each tag as { Key, Value }, so matching ALL
    // filters means ANDing one sub-filter per pair. Keys and values are
    // validated above, so neither can terminate the JMESPath literals.
    const conds = tagEntries
      .map(([k, v]) => `Tags[?Key=='${k}' && Value=='${v}']`)
      .join(" && ");
    env.DESTROY_STACK_JMES = `Stacks[?${conds}].StackName`;
  }

  const lines: string[] = [
    `set -e`,
    `echo "## destroy_aws"`,
    `if [ -n "$DESTROY_STACK" ]; then echo "target stack: $DESTROY_STACK"; fi`,
    `if [ -n "$DESTROY_TAGS_DESC" ]; then echo "tag filters: $DESTROY_TAGS_DESC"; fi`,
  ];

  if (tagEntries.length > 0) {
    lines.push(
      `echo ""`,
      `echo "## matching stacks"`,
      `STACKS=$(aws cloudformation describe-stacks --region "$DESTROY_REGION" --query "$DESTROY_STACK_JMES" --output text 2>/dev/null || echo "")`,
      `if [ -z "$STACKS" ]; then echo "(none)"; else echo "$STACKS"; fi`,
      `for S in $STACKS; do`,
      `  echo "deleting stack: $S"`,
      `  aws cloudformation delete-stack --region "$DESTROY_REGION" --stack-name "$S" || true`,
      `done`
    );
  }
  if (stack) {
    lines.push(
      `echo ""`,
      `echo "## explicit stack delete: $DESTROY_STACK"`,
      `aws cloudformation delete-stack --region "$DESTROY_REGION" --stack-name "$DESTROY_STACK" || true`
    );
  }

  // Wait for deletions to complete.
  if (tagEntries.length > 0) {
    lines.push(
      `echo ""`,
      `echo "## waiting for stack deletions to complete"`,
      `for i in $(seq 1 60); do`,
      `  REMAINING=$(aws cloudformation describe-stacks --region "$DESTROY_REGION" --query "$DESTROY_STACK_JMES" --output text 2>/dev/null || echo "")`,
      `  if [ -z "$REMAINING" ]; then echo "all matching stacks gone"; break; fi`,
      `  echo "still pending: $REMAINING"; sleep 10`,
      `done`
    );
  }
  if (stack) {
    lines.push(
      `echo ""`,
      `echo "## waiting for $DESTROY_STACK to be gone"`,
      `for i in $(seq 1 60); do`,
      `  if ! aws cloudformation describe-stacks --region "$DESTROY_REGION" --stack-name "$DESTROY_STACK" >/dev/null 2>&1; then echo "$DESTROY_STACK gone"; break; fi`,
      `  sleep 10`,
      `done`
    );
  }

  const shellScript = lines.join("\n");

  // The aws-cli image's ENTRYPOINT is `aws`, so running a shell script
  // needs `--entrypoint /bin/sh`; the script then arrives as the
  // entrypoint's `-c` argument. Auth precedence matches the rest of the
  // AWS path: access keys first, fall back to the ~/.aws mount.
  const useAccessKeys =
    Boolean(AWS_ACCESS_KEY_ID) && Boolean(AWS_SECRET_ACCESS_KEY);
  const dockerArgs = [
    "run",
    "--rm",
    "-v",
    `${WORKSPACE_VOLUME}:/work`,
    // Secrets by name only — no values on the argv.
    ...(useAccessKeys
      ? awsCredDockerArgs()
      : AWS_HOST_CONFIG_PATH
        ? ["-v", `${AWS_HOST_CONFIG_PATH}:/root/.aws:ro`]
        : []),
    ...(!useAccessKeys && AWS_PROFILE ? ["-e", "AWS_PROFILE"] : []),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    // The CLI also reads AWS_DEFAULT_REGION when a command omits --region.
    "-e",
    `AWS_DEFAULT_REGION=${region}`,
    "--entrypoint",
    "/bin/sh",
    AWS_CLI_IMAGE,
    "-c",
    shellScript,
  ];

  return { dockerArgs, shellScript };
}

async function runDestroyAws(input: DestroyAwsInput): Promise<{
  content: string;
  is_error: boolean;
}> {
  if (!AWS_AUTH_CONFIGURED) {
    return {
      content:
        "destroy_aws — AWS auth not configured. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or AWS_HOST_CONFIG_PATH) in the backend's .env.",
      is_error: true,
    };
  }

  const built = buildDestroyAwsCommand(input);
  if ("error" in built) {
    return { content: built.error, is_error: true };
  }

  const result = await spawnAndCapture("docker", built.dockerArgs, {
    timeoutMs: 30 * 60 * 1000,
  });
  const summary = [
    `# destroy_aws — exit ${result.code}`,
    ``,
    `## stdout`,
    "```",
    result.stdout.slice(0, 8000),
    "```",
    result.stderr.trim().length > 0
      ? `## stderr\n\n\`\`\`\n${result.stderr.slice(0, 4000)}\n\`\`\``
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { content: summary, is_error: result.code !== 0 };
}

function spawnAndCapture(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      stderr += "\n[deploy_bicep] timed out — child killed";
    }, opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(t);
      stderr += `\n[deploy_bicep] spawn error: ${err.message}`;
      resolve({ code: -1, stdout, stderr });
    });
  });
}
