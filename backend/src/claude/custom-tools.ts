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

import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "../config.js";
import { CURATED_VM_SKUS } from "../lib/vm-skus.js";

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
      "Delete Azure resources. Use this for tear-down — the Azure MCP Server has no resource-group-delete or generic delete-by-tag tool. This tool spawns Microsoft's official azure-cli container with the project's service-principal credentials and runs `az group delete` and/or `az resource delete --ids` against matched resources. Two operating modes: (1) `resource_group_name` to delete a specific resource group (cascades to all resources inside); (2) `tag_filters` to delete every resource group AND every standalone resource that carries ALL the listed tags. The two modes can be combined. Returns the deletion summary verbatim.",
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
            "Tag key→value pairs. Resources matching ALL of these tags are deleted. Typical values: { 'azure-mcp-project': '<name>', 'azure-mcp-topology-id': '<uuid>' } for a per-topology destroy.",
          additionalProperties: { type: "string" },
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
  return {
    content: `unknown custom tool: ${name}`,
    is_error: true,
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
    const dockerArgs = [
      "run",
      "--rm",
      "-v",
      `${WORKSPACE_VOLUME}:/work`,
      AZURE_CLI_IMAGE,
      "sh",
      "-c",
      `az bicep build --file "${entryWorkPath}" --stdout > /dev/null`,
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
};

async function runDestroy(input: DestroyAzureInput): Promise<{
  content: string;
  is_error: boolean;
}> {
  const targetRG = input.resource_group_name?.trim();
  const tags = input.tag_filters ?? {};
  const tagEntries = Object.entries(tags).filter(([k, v]) => k && v);

  if (!targetRG && tagEntries.length === 0) {
    return {
      content:
        "destroy_azure requires either `resource_group_name` or non-empty `tag_filters`",
      is_error: true,
    };
  }

  // Build a tag-query string Azure understands. The CLI uses
  // `tagName=value` repeated; the resource graph filter we use below
  // joins them with ANDs.
  // We do the work inside the sidecar via a single shell script so a
  // single `az login` covers the whole sequence and we get one
  // consolidated stdout/stderr blob.
  const lines: string[] = [
    `set -e`,
    `az login --service-principal -u "$AZURE_CLIENT_ID" -p "$AZURE_CLIENT_SECRET" --tenant "$AZURE_TENANT_ID" --output none`,
    `az account set --subscription "$AZURE_SUBSCRIPTION_ID"`,
    `echo "## destroy_azure plan"`,
    targetRG ? `echo "specific RG: ${targetRG}"` : "",
    tagEntries.length > 0
      ? `echo "tag filters: ${tagEntries.map(([k, v]) => `${k}=${v}`).join(", ")}"`
      : "",
  ];

  if (tagEntries.length > 0) {
    // Find all resource groups whose tags include EVERY filter, list
    // their names, delete each. `az group list` returns all RGs; we
    // filter client-side via JMESPath for "tags has key && tag==value
    // for each entry" — the CLI's --tag flag only handles a single tag.
    const jmesParts = tagEntries.map(
      ([k, v]) => `tags.\\"${k}\\"=='${v}'`
    );
    const jmes = `[?${jmesParts.join(" && ")}].name`;
    lines.push(
      `echo ""`,
      `echo "## matching resource groups"`,
      `RGS=$(az group list --query "${jmes}" -o tsv)`,
      `if [ -z "$RGS" ]; then echo "(none)"; else echo "$RGS"; fi`,
      `for RG in $RGS; do`,
      `  echo "deleting RG: $RG"`,
      `  az group delete --name "$RG" --yes --no-wait || true`,
      `done`,
      `echo ""`,
      `echo "## standalone resources matching tags (those whose containing RG is NOT being deleted)"`,
      `RES=$(az resource list --query "${jmes.replace("[?", "[?")} | [].id" -o tsv)`,
      `if [ -z "$RES" ]; then echo "(none)"; else`,
      `  echo "$RES"`,
      `  echo "$RES" | xargs -r az resource delete --ids || true`,
      `fi`
    );
  }

  if (targetRG) {
    lines.push(
      `echo ""`,
      `echo "## explicit RG delete: ${targetRG}"`,
      `az group delete --name "${targetRG}" --yes --no-wait || true`
    );
  }

  // Wait for any --no-wait deletions to actually finish before we
  // return — otherwise Claude will report "deleted" while Azure is
  // still working on it. We poll until nothing matches.
  if (tagEntries.length > 0) {
    const jmesParts = tagEntries.map(
      ([k, v]) => `tags.\\"${k}\\"=='${v}'`
    );
    const jmes = `[?${jmesParts.join(" && ")}].name`;
    lines.push(
      `echo ""`,
      `echo "## waiting for deletions to complete"`,
      `for i in $(seq 1 60); do`,
      `  REMAINING=$(az group list --query "${jmes}" -o tsv 2>/dev/null || echo "")`,
      `  if [ -z "$REMAINING" ]; then echo "all matching RGs gone"; break; fi`,
      `  echo "still pending: $REMAINING"; sleep 10`,
      `done`
    );
  }
  if (targetRG) {
    lines.push(
      `echo ""`,
      `echo "## waiting for ${targetRG} to be gone"`,
      `for i in $(seq 1 60); do`,
      `  if ! az group show --name "${targetRG}" -o none 2>/dev/null; then echo "${targetRG} gone"; break; fi`,
      `  sleep 10`,
      `done`
    );
  }

  const shellScript = lines.filter(Boolean).join("\n");

  const dockerArgs = [
    "run",
    "--rm",
    "-e",
    `AZURE_TENANT_ID=${config.AZURE_TENANT_ID}`,
    "-e",
    `AZURE_CLIENT_ID=${config.AZURE_CLIENT_ID}`,
    "-e",
    `AZURE_CLIENT_SECRET=${config.AZURE_CLIENT_SECRET}`,
    "-e",
    `AZURE_SUBSCRIPTION_ID=${config.AZURE_SUBSCRIPTION_ID}`,
    AZURE_CLI_IMAGE,
    "sh",
    "-c",
    shellScript,
  ];

  const result = await spawnAndCapture("docker", dockerArgs, {
    timeoutMs: 30 * 60 * 1000,
  });

  const summary = [
    `# destroy_azure — exit ${result.code}`,
    ``,
    "## stdout",
    "```",
    result.stdout.slice(-6000),
    "```",
    result.stderr.trim().length > 0
      ? `## stderr\n\n\`\`\`\n${result.stderr.slice(-3000)}\n\`\`\``
      : "",
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
    const azCmd =
      input.scope === "subscription"
        ? `az deployment sub create --location "${input.location}" --template-file "${entryWorkPath}" --name "${id}"`
        : `az deployment group create --resource-group "${input.resource_group_name}" --template-file "${entryWorkPath}" --name "${id}"`;

    // Build the post-deploy tag-enforcement step. We list the
    // deployment's outputResources, then `az tag update --operation
    // Merge` each one so the required tags are guaranteed regardless
    // of what the Bicep template wrote. Idempotent — Merge updates the
    // value if the key exists, adds it if not, leaves other tags alone.
    const tagPairs = Object.entries(input.required_tags ?? {}).filter(
      ([k, v]) => k && v
    );
    const showCmd =
      input.scope === "subscription"
        ? `az deployment sub show --name "${id}"`
        : `az deployment group show --resource-group "${input.resource_group_name}" --name "${id}"`;
    const tagBlock =
      tagPairs.length === 0
        ? `echo "(no required_tags supplied — skipping tag enforcement)"`
        : [
            // Capture deployment-output resource ids — for sub-scoped
            // deployments these are the resource groups; for group-scoped
            // they're the individual resources. Either way we walk them.
            `RIDS=$(${showCmd} --query "properties.outputResources[].id" -o tsv 2>/dev/null || echo "")`,
            `if [ -z "$RIDS" ]; then echo "(no output resources to tag)"; else`,
            `  echo "$RIDS" | while read -r rid; do`,
            `    [ -z "$rid" ] && continue`,
            `    echo "tagging $rid"`,
            `    az tag update --resource-id "$rid" --operation Merge --tags ${tagPairs
              .map(([k, v]) => `'${k}=${v}'`)
              .join(" ")} -o none || echo "  (warn: tag update failed for $rid)"`,
            `  done`,
            `  # Also apply tags directly to any resource group named in the deployment.`,
            `  echo "$RIDS" | grep -i "/resourcegroups/" | grep -ivE "/providers/" | while read -r rgid; do`,
            `    [ -z "$rgid" ] && continue`,
            // The azure-cli image is alpine-based and does NOT ship awk by
            // default; using `cut` keeps this portable across image updates.
            `    rgname=$(echo "$rgid" | cut -d/ -f5)`,
            `    echo "applying tags to RG $rgname (and child resources)"`,
            `    az tag update --resource-id "$rgid" --operation Merge --tags ${tagPairs
              .map(([k, v]) => `'${k}=${v}'`)
              .join(" ")} -o none || true`,
            `    # Cascade to every resource in the RG so tag-filter destroy can find them.`,
            `    az resource list -g "$rgname" --query "[].id" -o tsv | while read -r rid; do`,
            `      [ -z "$rid" ] && continue`,
            `      az tag update --resource-id "$rid" --operation Merge --tags ${tagPairs
              .map(([k, v]) => `'${k}=${v}'`)
              .join(" ")} -o none || true`,
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
      "-e",
      `AZURE_TENANT_ID=${config.AZURE_TENANT_ID}`,
      "-e",
      `AZURE_CLIENT_ID=${config.AZURE_CLIENT_ID}`,
      "-e",
      `AZURE_CLIENT_SECRET=${config.AZURE_CLIENT_SECRET}`,
      "-e",
      `AZURE_SUBSCRIPTION_ID=${config.AZURE_SUBSCRIPTION_ID}`,
      AZURE_CLI_IMAGE,
      "sh",
      "-c",
      shellScript,
    ];

    const result = await spawnAndCapture("docker", dockerArgs, {
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
  if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
    args.push("-e", `AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}`);
    args.push("-e", `AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}`);
    if (AWS_SESSION_TOKEN) {
      args.push("-e", `AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN}`);
    }
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
  if (!input.stack_name || !/^[a-zA-Z][a-zA-Z0-9-]{0,127}$/.test(input.stack_name)) {
    return {
      content:
        "`stack_name` is required and must be 1–128 chars: letter, then alphanumerics + dashes (CloudFormation rules).",
      is_error: true,
    };
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
  const stack = input.stack_name?.trim();
  const tags = input.tag_filters ?? {};
  const tagEntries = Object.entries(tags).filter(([k, v]) => k && v);
  if (!stack && tagEntries.length === 0) {
    return {
      content:
        "destroy_aws requires either `stack_name` or non-empty `tag_filters`",
      is_error: true,
    };
  }

  const region = input.region ?? AWS_DEFAULT_REGION;
  const lines: string[] = [
    `set -e`,
    `echo "## destroy_aws plan"`,
    stack ? `echo "specific stack: ${stack}"` : "",
    tagEntries.length > 0
      ? `echo "tag filters: ${tagEntries.map(([k, v]) => `${k}=${v}`).join(", ")}"`
      : "",
  ];

  if (tagEntries.length > 0) {
    // Find every CFN stack whose tags include EVERY filter pair.
    // describe-stacks JMES filters: each tag is { Key, Value }, so
    // we need an `[? ... && ...]` expression that ANDs them.
    const conds = tagEntries
      .map(([k, v]) => `Tags[?Key=='${k}' && Value=='${v}']`)
      .join(" && ");
    lines.push(
      `echo ""`,
      `echo "## matching stacks"`,
      // CFN active stacks only (skip already-deleted ones via filter).
      `STACKS=$(aws cloudformation describe-stacks --region "${region}" --query "Stacks[?${conds}].StackName" --output text 2>/dev/null || echo "")`,
      `if [ -z "$STACKS" ]; then echo "(none)"; else echo "$STACKS"; fi`,
      `for S in $STACKS; do`,
      `  echo "deleting stack: $S"`,
      `  aws cloudformation delete-stack --region "${region}" --stack-name "$S" || true`,
      `done`
    );
  }
  if (stack) {
    lines.push(
      `echo ""`,
      `echo "## explicit stack delete: ${stack}"`,
      `aws cloudformation delete-stack --region "${region}" --stack-name "${stack}" || true`
    );
  }

  // Wait for deletions to complete.
  if (tagEntries.length > 0) {
    const conds = tagEntries
      .map(([k, v]) => `Tags[?Key=='${k}' && Value=='${v}']`)
      .join(" && ");
    lines.push(
      `echo ""`,
      `echo "## waiting for stack deletions to complete"`,
      `for i in $(seq 1 60); do`,
      `  REMAINING=$(aws cloudformation describe-stacks --region "${region}" --query "Stacks[?${conds}].StackName" --output text 2>/dev/null || echo "")`,
      `  if [ -z "$REMAINING" ]; then echo "all matching stacks gone"; break; fi`,
      `  echo "still pending: $REMAINING"; sleep 10`,
      `done`
    );
  }
  if (stack) {
    lines.push(
      `echo ""`,
      `echo "## waiting for ${stack} to be gone"`,
      `for i in $(seq 1 60); do`,
      `  if ! aws cloudformation describe-stacks --region "${region}" --stack-name "${stack}" >/dev/null 2>&1; then echo "${stack} gone"; break; fi`,
      `  sleep 10`,
      `done`
    );
  }

  const shellScript = lines.filter(Boolean).join("\n");
  const dockerArgs = [
    ...awsCliDockerArgs({ AWS_DEFAULT_REGION: region, AWS_PROFILE }),
    "--",
    "sh",
    "-c",
    shellScript,
  ];
  // The aws-cli image's ENTRYPOINT is `aws`. To run a shell we need
  // `--entrypoint /bin/sh` (or use the `aws` ENTRYPOINT for single
  // commands). Override entrypoint here so we can run a shell script.
  // We rebuild the args list because awsCliDockerArgs already
  // appended the IMAGE — splice an --entrypoint right before it.
  const imgIdx = dockerArgs.indexOf(AWS_CLI_IMAGE);
  if (imgIdx >= 0) {
    dockerArgs.splice(imgIdx, 0, "--entrypoint", "/bin/sh");
  }
  // Now the `--` and `sh -c` we pushed at the end conflict with the
  // overridden entrypoint. Drop the literal "--" and "sh" tokens
  // we appended; the entrypoint /bin/sh will be invoked directly
  // with `-c <script>` as its arg.
  // Rebuild cleanly to avoid bugs. Auth precedence matches the rest
  // of the AWS path: access keys first, fall back to ~/.aws mount.
  const useAccessKeys =
    Boolean(AWS_ACCESS_KEY_ID) && Boolean(AWS_SECRET_ACCESS_KEY);
  const finalArgs = [
    "run",
    "--rm",
    "-v",
    `${WORKSPACE_VOLUME}:/work`,
    ...(useAccessKeys
      ? [
          "-e",
          `AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}`,
          "-e",
          `AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}`,
          ...(AWS_SESSION_TOKEN
            ? ["-e", `AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN}`]
            : []),
        ]
      : AWS_HOST_CONFIG_PATH
        ? ["-v", `${AWS_HOST_CONFIG_PATH}:/root/.aws:ro`]
        : []),
    "-e",
    `AWS_DEFAULT_REGION=${region}`,
    ...(!useAccessKeys && AWS_PROFILE
      ? ["-e", `AWS_PROFILE=${AWS_PROFILE}`]
      : []),
    "--entrypoint",
    "/bin/sh",
    AWS_CLI_IMAGE,
    "-c",
    shellScript,
  ];

  const result = await spawnAndCapture("docker", finalArgs, {
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
