// Tests for what the deploy/destroy tools would actually execute.
//
// Run with: npm test   (from the backend/ directory)
//
// These never spawn a container. They call the exported command builders
// and inspect the two things that matter:
//
//   1. the `sh -c` script body contains NO caller-supplied text — only
//      static structure and "$VAR" references, so a hostile value has
//      nothing to break out of;
//   2. the `docker run` argv contains no secret VALUES — credentials are
//      forwarded by name, so `ps auxww` and `docker inspect` can't see them.
//
// custom-tools.ts reads credentials from process.env at import time, so
// the environment is set up before the dynamic import below.

import { test } from "node:test";
import assert from "node:assert/strict";

const AZ_SECRET = "super-secret-sp-password-DO-NOT-LEAK";
const AWS_SECRET = "super-secret-aws-key-DO-NOT-LEAK";
const AWS_TOKEN = "super-secret-aws-session-token";

process.env.AZURE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
process.env.AZURE_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
process.env.AZURE_CLIENT_SECRET = AZ_SECRET;
process.env.AZURE_SUBSCRIPTION_ID = "33333333-3333-3333-3333-333333333333";
process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLEEXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = AWS_SECRET;
process.env.AWS_SESSION_TOKEN = AWS_TOKEN;

const {
  buildBicepDeployCommand,
  buildDestroyAzureCommand,
  buildDestroyAwsCommand,
} = await import("./custom-tools.js");

/** Every secret value that must never appear anywhere in an argv. */
const SECRET_VALUES = [AZ_SECRET, AWS_SECRET, AWS_TOKEN];

function assertNoSecretsInArgv(args: string[], label: string) {
  for (const secret of SECRET_VALUES) {
    for (const arg of args) {
      assert.ok(
        !arg.includes(secret),
        `${label}: secret value leaked into docker argv: ${arg.slice(0, 40)}…`
      );
    }
  }
  // Name-only passthrough means the flag has no '=' in it at all.
  for (const name of [
    "AZURE_CLIENT_SECRET",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ]) {
    assert.ok(
      !args.some((a) => a.startsWith(`${name}=`)),
      `${label}: ${name} was passed as NAME=value instead of by name`
    );
  }
}

/** The credential env var must still be forwarded — by name. */
function assertForwardsByName(args: string[], name: string) {
  const idx = args.indexOf(name);
  assert.ok(idx > 0, `${name} is not forwarded to the container at all`);
  assert.equal(args[idx - 1], "-e", `${name} is not preceded by -e`);
}

const ok = <T,>(r: T | { error: string }, what: string): T => {
  if (r && typeof r === "object" && "error" in r) {
    assert.fail(`${what} unexpectedly failed: ${(r as { error: string }).error}`);
  }
  return r as T;
};

// ── destroy_azure ────────────────────────────────────────────────

test("destroy_azure: the issue #1 payload is rejected and nothing is built", () => {
  const r = buildDestroyAzureCommand({
    resource_group_name: `x"; az ad sp create-for-rbac --name pwn --role Owner --scopes /subscriptions/$AZURE_SUBSCRIPTION_ID; echo "`,
    confirm: true,
  });
  assert.ok("error" in r, "a shell-metacharacter RG name must be refused");
  assert.match(r.error, /resource_group_name/);
});

test("destroy_azure: a hostile tag value is rejected", () => {
  const r = buildDestroyAzureCommand({
    tag_filters: { "mcp-project": `lab'; rm -rf /; echo '` },
    confirm: true,
  });
  assert.ok("error" in r);
});

test("destroy_azure: a tag filter with no project anchor is refused", () => {
  const r = buildDestroyAzureCommand({
    tag_filters: { env: "lab" },
    confirm: true,
  });
  assert.ok("error" in r, "unanchored tag filters must be refused");
  assert.match(r.error, /project anchor/i);
});

test("destroy_azure: an anchored filter is accepted", () => {
  const r = buildDestroyAzureCommand({
    tag_filters: { "mcp-project": "vigil-lab" },
  });
  assert.ok(!("error" in r));
});

test("destroy_azure: neither mode supplied is refused", () => {
  const r = buildDestroyAzureCommand({});
  assert.ok("error" in r);
});

test("destroy_azure: the RG name never appears in the script body", () => {
  const built = ok(
    buildDestroyAzureCommand({ resource_group_name: "mcp-lab-rg", confirm: true }),
    "destroy build"
  );
  // The value travels as env data…
  assert.ok(
    built.dockerArgs.includes("DESTROY_RG=mcp-lab-rg"),
    "RG should be passed as an env var"
  );
  // …and never as script text. This is the invariant that makes shell
  // injection impossible regardless of what the validator lets through.
  assert.ok(
    !built.shellScript.includes("mcp-lab-rg"),
    "RG name leaked into the sh -c script body"
  );
  assert.match(built.shellScript, /az group delete --name "\$DESTROY_RG"/);
});

test("destroy_azure: tag values never appear in the script body", () => {
  const built = ok(
    buildDestroyAzureCommand({
      tag_filters: { "mcp-project": "vigil-lab", "mcp-topology-id": "abc-123" },
      confirm: true,
    }),
    "destroy build"
  );
  for (const literal of ["vigil-lab", "abc-123", "mcp-topology-id"]) {
    assert.ok(
      !built.shellScript.includes(literal),
      `'${literal}' leaked into the sh -c script body`
    );
  }
  // The JMESPath query is built as data and referenced as a variable.
  assert.match(built.shellScript, /--query "\$DESTROY_JMES_GROUPS"/);
  assert.ok(
    built.dockerArgs.some((a) =>
      a.startsWith(`DESTROY_JMES_GROUPS=[?tags."mcp-project"=='vigil-lab'`)
    ),
    "the JMESPath filter should be passed as an env var"
  );
});

test("destroy_azure: without confirm it lists but never deletes", () => {
  const built = ok(
    buildDestroyAzureCommand({
      tag_filters: { "mcp-project": "vigil-lab" },
      resource_group_name: "mcp-lab-rg",
    }),
    "dry run build"
  );
  assert.equal(built.willDelete, false);
  assert.ok(!/az group delete/.test(built.shellScript), "dry run must not delete");
  assert.ok(!/az resource delete/.test(built.shellScript), "dry run must not delete");
  // It still has to show what it would remove.
  assert.match(built.shellScript, /az group list --query/);
  assert.match(built.shellScript, /az resource list --query/);
  assert.match(built.shellScript, /DRY RUN COMPLETE/);
});

test("destroy_azure: confirm:true reaches the delete commands and the cap check", () => {
  const built = ok(
    buildDestroyAzureCommand({
      tag_filters: { "mcp-project": "vigil-lab" },
      confirm: true,
    }),
    "confirmed build"
  );
  assert.equal(built.willDelete, true);
  assert.match(built.shellScript, /az group delete --name "\$RG" --yes --no-wait/);
  assert.match(built.shellScript, /az resource delete --ids/);
  // The safety cap must be evaluated before any delete runs.
  const capAt = built.shellScript.indexOf("DESTROY_MAX_GROUPS");
  const delAt = built.shellScript.indexOf("az group delete");
  assert.ok(capAt >= 0 && capAt < delAt, "cap check must precede deletion");
  assert.ok(built.dockerArgs.includes("DESTROY_MAX_GROUPS=25"));
});

test("destroy_azure: credentials are forwarded by name only", () => {
  const built = ok(
    buildDestroyAzureCommand({ resource_group_name: "mcp-lab-rg", confirm: true }),
    "destroy build"
  );
  assertNoSecretsInArgv(built.dockerArgs, "destroy_azure");
  assertForwardsByName(built.dockerArgs, "AZURE_CLIENT_SECRET");
  assertForwardsByName(built.dockerArgs, "AZURE_TENANT_ID");
});

// ── deploy_bicep ─────────────────────────────────────────────────

test("deploy_bicep: no dynamic value appears in the script body", () => {
  const built = ok(
    buildBicepDeployCommand({
      scope: "subscription",
      location: "uksouth",
      deploymentName: "azmcp-1a2b3c4d",
      entryWorkPath: "/work/deploy-9f8e7d6c.bicep",
      requiredTags: { "mcp-project": "vigil-lab", "mcp-topology-id": "abc-123" },
    }),
    "deploy build"
  );
  for (const literal of [
    "uksouth",
    "azmcp-1a2b3c4d",
    "/work/deploy-9f8e7d6c.bicep",
    "vigil-lab",
    "abc-123",
  ]) {
    assert.ok(
      !built.shellScript.includes(literal),
      `'${literal}' leaked into the sh -c script body`
    );
  }
  assert.match(
    built.shellScript,
    /az deployment sub create --location "\$DEPLOY_LOCATION" --template-file "\$DEPLOY_ENTRY" --name "\$DEPLOY_NAME"/
  );
  // Tag pairs are loaded into "$@" from the env, not pasted in.
  assert.match(built.shellScript, /set -- \$DEPLOY_TAG_PAIRS/);
  assert.match(built.shellScript, /--operation Merge --tags "\$@"/);
  assert.ok(
    built.dockerArgs.includes(
      "DEPLOY_TAG_PAIRS=mcp-project=vigil-lab\nmcp-topology-id=abc-123"
    ),
    "tag pairs should be newline-delimited env data"
  );
});

test("deploy_bicep: resourceGroup scope targets the RG by variable", () => {
  const built = ok(
    buildBicepDeployCommand({
      scope: "resourceGroup",
      resourceGroupName: "mcp-lab-rg",
      deploymentName: "azmcp-1a2b3c4d",
      entryWorkPath: "/work/deploy-1.bicep",
    }),
    "deploy build"
  );
  assert.match(
    built.shellScript,
    /az deployment group create --resource-group "\$DEPLOY_RG"/
  );
  assert.ok(!built.shellScript.includes("mcp-lab-rg"));
  assert.ok(built.dockerArgs.includes("DEPLOY_RG=mcp-lab-rg"));
});

test("deploy_bicep: with no tags it skips enforcement rather than emitting an empty --tags", () => {
  const built = ok(
    buildBicepDeployCommand({
      scope: "subscription",
      location: "uksouth",
      deploymentName: "azmcp-1a2b3c4d",
      entryWorkPath: "/work/deploy-1.bicep",
    }),
    "deploy build"
  );
  assert.ok(!built.shellScript.includes("az tag update"));
  assert.match(built.shellScript, /skipping tag enforcement/);
});

test("deploy_bicep: credentials are forwarded by name only", () => {
  const built = ok(
    buildBicepDeployCommand({
      scope: "subscription",
      location: "uksouth",
      deploymentName: "azmcp-1a2b3c4d",
      entryWorkPath: "/work/deploy-1.bicep",
      requiredTags: { "mcp-project": "vigil-lab" },
    }),
    "deploy build"
  );
  assertNoSecretsInArgv(built.dockerArgs, "deploy_bicep");
  assertForwardsByName(built.dockerArgs, "AZURE_CLIENT_SECRET");
});

// ── destroy_aws ──────────────────────────────────────────────────

test("destroy_aws: hostile stack name and region are rejected", () => {
  assert.ok("error" in buildDestroyAwsCommand({ stack_name: `s"; whoami; echo "` }));
  assert.ok(
    "error" in
      buildDestroyAwsCommand({ stack_name: "mcp-vpc", region: "us-east-1; whoami" })
  );
});

test("destroy_aws: no dynamic value appears in the script body", () => {
  const built = ok(
    buildDestroyAwsCommand({
      stack_name: "mcp-vigil-vpc",
      tag_filters: { "mcp-project": "vigil-lab" },
      region: "eu-west-2",
    }),
    "destroy_aws build"
  );
  for (const literal of ["mcp-vigil-vpc", "vigil-lab", "eu-west-2"]) {
    assert.ok(
      !built.shellScript.includes(literal),
      `'${literal}' leaked into the sh -c script body`
    );
  }
  assert.match(built.shellScript, /--region "\$DESTROY_REGION"/);
  assert.match(built.shellScript, /--stack-name "\$DESTROY_STACK"/);
  assert.match(built.shellScript, /--query "\$DESTROY_STACK_JMES"/);
});

test("destroy_aws: AWS credentials are forwarded by name only", () => {
  const built = ok(
    buildDestroyAwsCommand({ stack_name: "mcp-vigil-vpc" }),
    "destroy_aws build"
  );
  assertNoSecretsInArgv(built.dockerArgs, "destroy_aws");
  assertForwardsByName(built.dockerArgs, "AWS_SECRET_ACCESS_KEY");
  assertForwardsByName(built.dockerArgs, "AWS_SESSION_TOKEN");
  // Region is not a secret and is per-call, so it stays a value.
  assert.ok(built.dockerArgs.includes("DESTROY_REGION=us-east-1"));
});

test("destroy_aws: neither mode supplied is refused", () => {
  assert.ok("error" in buildDestroyAwsCommand({}));
});
