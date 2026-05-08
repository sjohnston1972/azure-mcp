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

// The shared volume mount path inside both the backend container and
// the spawned azure-cli container (see docker-compose.yml).
const WORKSPACE = "/work";
// Docker named volume that compose actually creates. The naming convention
// is `<project>_<volume_key>` — for our compose file the project is
// `azure-mcp` and the volume key is `azure-mcp-deploy-workspace`, so the
// actual volume name is `azure-mcp_azure-mcp-deploy-workspace`. Override
// via env if you ever rename the project.
const WORKSPACE_VOLUME =
  process.env.AZURE_MCP_DEPLOY_VOLUME ?? "azure-mcp_azure-mcp-deploy-workspace";

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
