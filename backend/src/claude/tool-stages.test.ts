// Unit tests for stage-based tool authorization.
//
// Run with: npm test   (from the backend/ directory)
//
// The rule under test: mutating tools are unavailable outside the stage
// that matches them. build/view/free are read-only, push deploys, teardown
// destroys. Both the tool-list filter and the dispatcher guard are built
// on `isToolAllowedInStage`, so testing it covers both.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTool,
  isToolAllowedInStage,
  stageRefusalMessage,
  type ChatStage,
} from "./tool-stages.js";
import { CUSTOM_TOOLS } from "./custom-tools.js";

const READ_ONLY_STAGES: ChatStage[] = ["build", "view", "free"];
const ALL_STAGES: ChatStage[] = ["build", "view", "push", "teardown", "free"];

test("our own tools are classified exactly", () => {
  assert.equal(classifyTool("deploy_bicep"), "deploy");
  assert.equal(classifyTool("deploy_cloudformation"), "deploy");
  assert.equal(classifyTool("destroy_azure"), "destroy");
  assert.equal(classifyTool("destroy_aws"), "destroy");
  // The inspection tools stay available everywhere.
  assert.equal(classifyTool("validate_bicep"), "readonly");
  assert.equal(classifyTool("validate_cloudformation"), "readonly");
  assert.equal(classifyTool("list_vm_skus"), "readonly");
  assert.equal(classifyTool("list_ec2_types"), "readonly");
});

test("upstream MCP tools are classified by the verb in their name", () => {
  assert.equal(classifyTool("azmcp_group_list"), "readonly");
  assert.equal(classifyTool("azmcp_storage_account_show"), "readonly");
  assert.equal(classifyTool("bicepschema_get"), "readonly");
  assert.equal(classifyTool("azmcp_bestpractices"), "readonly");

  assert.equal(classifyTool("azmcp_storage_account_create"), "mutating");
  assert.equal(classifyTool("azmcp_role_assignment_set"), "mutating");

  assert.equal(classifyTool("azmcp_group_delete"), "destroy");
  assert.equal(classifyTool("azmcp_keyvault_key_purge"), "destroy");
});

test("a trailing read-only verb wins over an earlier mutating word", () => {
  // Reading an azd deployment plan is not a deployment.
  assert.equal(classifyTool("azmcp_deploy_plan_get"), "readonly");
  assert.equal(classifyTool("azmcp_deployment_show"), "readonly");
});

test("CLI passthrough tools are always treated as mutating", () => {
  // These take an arbitrary command line, so the name tells you nothing.
  assert.equal(classifyTool("azmcp_extension_az"), "mutating");
  assert.equal(classifyTool("azmcp_extension_azd"), "mutating");
});

test("read-only stages expose no deploy or destroy tool", () => {
  for (const stage of READ_ONLY_STAGES) {
    for (const name of [
      "deploy_bicep",
      "destroy_azure",
      "deploy_cloudformation",
      "destroy_aws",
      "azmcp_storage_account_create",
      "azmcp_group_delete",
      "azmcp_extension_az",
    ]) {
      assert.equal(
        isToolAllowedInStage(name, stage),
        false,
        `${name} must be unavailable in stage '${stage}'`
      );
    }
    // …but inspection is always fine.
    assert.equal(isToolAllowedInStage("azmcp_group_list", stage), true);
    assert.equal(isToolAllowedInStage("validate_bicep", stage), true);
  }
});

test("push allows deploying but not destroying", () => {
  assert.equal(isToolAllowedInStage("deploy_bicep", "push"), true);
  assert.equal(isToolAllowedInStage("deploy_cloudformation", "push"), true);
  assert.equal(isToolAllowedInStage("azmcp_storage_account_create", "push"), true);
  assert.equal(isToolAllowedInStage("destroy_azure", "push"), false);
  assert.equal(isToolAllowedInStage("destroy_aws", "push"), false);
  assert.equal(isToolAllowedInStage("azmcp_group_delete", "push"), false);
});

test("teardown allows destroying but not deploying", () => {
  assert.equal(isToolAllowedInStage("destroy_azure", "teardown"), true);
  assert.equal(isToolAllowedInStage("destroy_aws", "teardown"), true);
  assert.equal(isToolAllowedInStage("azmcp_group_delete", "teardown"), true);
  assert.equal(isToolAllowedInStage("deploy_bicep", "teardown"), false);
  assert.equal(isToolAllowedInStage("deploy_cloudformation", "teardown"), false);
});

test("an unrecognised stage fails closed to read-only", () => {
  const bogus = "admin" as ChatStage;
  assert.equal(isToolAllowedInStage("destroy_azure", bogus), false);
  assert.equal(isToolAllowedInStage("deploy_bicep", bogus), false);
  assert.equal(isToolAllowedInStage("azmcp_group_list", bogus), true);
});

test("filtering the real custom tool list gives the expected per-stage sets", () => {
  // This mirrors what getClaudeTools(cloud, stage) does to the tool list
  // — the upstream MCP tools need a running container, but our own tools
  // are right here, and they're the ones that touch the cloud directly.
  const namesFor = (stage: ChatStage) =>
    CUSTOM_TOOLS.map((t) => t.name)
      .filter((n) => isToolAllowedInStage(n, stage))
      .sort();

  assert.deepEqual(namesFor("build"), [
    "list_ec2_types",
    "list_vm_skus",
    "validate_bicep",
    "validate_cloudformation",
  ]);
  assert.deepEqual(namesFor("view"), namesFor("build"));
  assert.deepEqual(namesFor("free"), namesFor("build"));

  assert.ok(namesFor("push").includes("deploy_bicep"));
  assert.ok(!namesFor("push").includes("destroy_azure"));
  assert.ok(namesFor("teardown").includes("destroy_azure"));
  assert.ok(!namesFor("teardown").includes("deploy_bicep"));
});

test("the refusal message names the tool, the stage, and where it belongs", () => {
  const msg = stageRefusalMessage("destroy_azure", "build");
  assert.match(msg, /destroy_azure/);
  assert.match(msg, /build/);
  assert.match(msg, /TEAR-DOWN/);
  // Every stage must produce a usable message.
  for (const stage of ALL_STAGES) {
    assert.ok(stageRefusalMessage("deploy_bicep", stage).length > 0);
  }
});
