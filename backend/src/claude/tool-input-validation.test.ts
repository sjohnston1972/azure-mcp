// Unit tests for the deploy/destroy input validators.
//
// Run with: npm test   (from the backend/ directory)
//
// The point of these tests is not "does the regex work" — it's that every
// class of shell metacharacter and every JMESPath-breaking character is
// rejected, in every field that reaches a cloud CLI. If someone widens a
// regex later, these fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requireProjectAnchor,
  validateAwsRegion,
  validateAzureLocation,
  validateAzureResourceGroup,
  validateDeploymentName,
  validateStackName,
  validateTags,
} from "./tool-input-validation.js";

/** The characters that would let a value escape its context — either a
 *  shell word or a JMESPath string literal. Every validator must reject
 *  all of them, in every field. */
const HOSTILE_FRAGMENTS = [
  `"`,
  `'`,
  "`",
  "$",
  "$(whoami)",
  ";",
  "&&",
  "|",
  "\\",
  "\n",
  "\r",
  "\0",
  "<",
  ">",
];

test("azure location: real regions pass", () => {
  for (const v of ["uksouth", "eastus", "eastus2", "westeurope"]) {
    assert.equal(validateAzureLocation("location", v), null, v);
  }
});

test("azure location: hostile and malformed values are rejected", () => {
  for (const frag of HOSTILE_FRAGMENTS) {
    assert.notEqual(
      validateAzureLocation("location", `uksouth${frag}`),
      null,
      `should reject location containing ${JSON.stringify(frag)}`
    );
  }
  // Leading dash would be read as a flag by the CLI.
  assert.notEqual(validateAzureLocation("location", "-uksouth"), null);
  assert.notEqual(validateAzureLocation("location", "UK South"), null);
  assert.notEqual(validateAzureLocation("location", ""), null);
});

test("azure resource group: real names pass", () => {
  for (const v of ["mcp-lab-rg", "rg_test.01", "vigil(lab)", "a"]) {
    assert.equal(validateAzureResourceGroup("resource_group_name", v), null, v);
  }
});

test("azure resource group: the issue #1 injection payload is rejected", () => {
  const payload = `x"; az ad sp create-for-rbac --name pwn --role Owner; echo "`;
  const err = validateAzureResourceGroup("resource_group_name", payload);
  assert.notEqual(err, null);
  assert.match(String(err), /resource_group_name/);
});

test("azure resource group: hostile characters, trailing dot, over-length rejected", () => {
  for (const frag of HOSTILE_FRAGMENTS) {
    assert.notEqual(
      validateAzureResourceGroup("resource_group_name", `rg${frag}`),
      null,
      `should reject RG containing ${JSON.stringify(frag)}`
    );
  }
  // Azure forbids a trailing period specifically.
  assert.notEqual(validateAzureResourceGroup("resource_group_name", "rg."), null);
  assert.notEqual(
    validateAzureResourceGroup("resource_group_name", "a".repeat(91)),
    null
  );
  assert.notEqual(validateAzureResourceGroup("resource_group_name", "rg name"), null);
});

test("deployment name: generated ids pass, hostile ones don't", () => {
  assert.equal(validateDeploymentName("deployment_name", "azmcp-1a2b3c4d"), null);
  assert.equal(validateDeploymentName("deployment_name", "hub_spoke.v2"), null);
  for (const frag of HOSTILE_FRAGMENTS) {
    assert.notEqual(
      validateDeploymentName("deployment_name", `dep${frag}`),
      null,
      `should reject deployment name containing ${JSON.stringify(frag)}`
    );
  }
});

test("aws region: real regions pass, anything else doesn't", () => {
  for (const v of ["us-east-1", "eu-west-2", "ap-southeast-3"]) {
    assert.equal(validateAwsRegion("region", v), null, v);
  }
  for (const frag of HOSTILE_FRAGMENTS) {
    assert.notEqual(validateAwsRegion("region", `us-east-1${frag}`), null);
  }
  assert.notEqual(validateAwsRegion("region", "useast1"), null);
  assert.notEqual(validateAwsRegion("region", "-us-east-1"), null);
});

test("stack name: CloudFormation rules enforced", () => {
  assert.equal(validateStackName("stack_name", "mcp-vigil-vpc"), null);
  assert.notEqual(validateStackName("stack_name", "1-starts-with-digit"), null);
  assert.notEqual(validateStackName("stack_name", "has_underscore"), null);
  for (const frag of HOSTILE_FRAGMENTS) {
    assert.notEqual(validateStackName("stack_name", `stack${frag}`), null);
  }
});

test("undefined scalars pass — required-ness is the caller's business", () => {
  assert.equal(validateAzureLocation("location", undefined), null);
  assert.equal(validateStackName("stack_name", undefined), null);
});

test("tags: the real mcp-* tag set passes", () => {
  const err = validateTags("required_tags", {
    "mcp-project": "vigil-lab",
    "mcp-topology-id": "3f2a5c1e-9b44-4d0a-8f21-6c7e2b1a9d33",
    "mcp-deployed-at": "2026-07-07T00:00:00Z",
    "mcp-deployment-id": "d41d8cd9-8f00-b204-e980-0998ecf8427e",
  });
  assert.equal(err, null);
});

test("tags: hostile characters rejected in both key and value position", () => {
  for (const frag of HOSTILE_FRAGMENTS) {
    assert.notEqual(
      validateTags("tag_filters", { [`k${frag}`]: "v" }),
      null,
      `should reject tag KEY containing ${JSON.stringify(frag)}`
    );
    assert.notEqual(
      validateTags("tag_filters", { k: `v${frag}` }),
      null,
      `should reject tag VALUE containing ${JSON.stringify(frag)}`
    );
  }
});

test("tags: a value that would close the JMESPath literal is rejected", () => {
  // `tags."k"=='v'` — a value ending the single-quoted literal early
  // would let the caller rewrite the whole query.
  const err = validateTags("tag_filters", {
    "mcp-project": `lab' || 'a'=='a`,
  });
  assert.notEqual(err, null);
});

test("tags: blank pairs are ignored, not rejected", () => {
  assert.equal(validateTags("required_tags", { "": "v", k: "" }), null);
});

test("tags: requireAtLeastOne catches an effectively empty map", () => {
  assert.notEqual(
    validateTags("tag_filters", { "": "" }, { requireAtLeastOne: true }),
    null
  );
  assert.notEqual(
    validateTags("tag_filters", undefined, { requireAtLeastOne: true }),
    null
  );
  assert.equal(
    validateTags("tag_filters", { k: "v" }, { requireAtLeastOne: true }),
    null
  );
});

test("tags: non-object input rejected", () => {
  assert.notEqual(
    validateTags("tag_filters", "mcp-project=lab" as unknown as Record<string, string>),
    null
  );
  assert.notEqual(
    validateTags("tag_filters", ["a"] as unknown as Record<string, string>),
    null
  );
});

test("project anchor: accepted under either supported key", () => {
  assert.equal(requireProjectAnchor("tag_filters", [["mcp-project", "lab"]]), null);
  assert.equal(
    requireProjectAnchor("tag_filters", [["azure-mcp-project", "lab"]]),
    null
  );
  assert.equal(
    requireProjectAnchor("tag_filters", [
      ["mcp-topology-id", "abc"],
      ["mcp-project", "lab"],
    ]),
    null
  );
});

test("project anchor: an unanchored or blank filter is refused", () => {
  // This is the whole point of issue #9: `env=lab` would sweep the
  // subscription for anything tagged that way.
  assert.notEqual(requireProjectAnchor("tag_filters", [["env", "lab"]]), null);
  assert.notEqual(requireProjectAnchor("tag_filters", []), null);
  assert.notEqual(
    requireProjectAnchor("tag_filters", [["mcp-project", "   "]]),
    null
  );
  assert.notEqual(
    requireProjectAnchor("tag_filters", [["mcp-topology-id", "abc"]]),
    null
  );
});
