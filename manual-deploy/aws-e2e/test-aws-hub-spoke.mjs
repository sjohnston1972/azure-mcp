// E2E test for the AWS chat-driven deploy flow.
//
// Drives the website's actual /api/chat endpoint exactly like the
// Build / Push / Tear-down buttons would:
//   1. Create an AWS project via POST /api/projects.
//   2. Build turn — send the user's design prompt at stage=build,
//      consume the SSE stream, parse out the <topology> + <bicep>
//      (CloudFormation YAML/JSON) markers from the streamed text.
//   3. Create a topology row with the captured CFN template.
//   4. Push turn — send a buildPushPrompt-equivalent prompt at
//      stage=push, watch for deploy_cloudformation tool calls,
//      verify the deployment succeeded.
//   5. Tear-down turn — send a buildTeardownPrompt-equivalent
//      prompt at stage=teardown, watch for destroy_aws.
//   6. Repeat once more to confirm idempotency.
//
// Run from inside the backend container so localhost:3000 reaches
// the API: `docker compose exec azure-mcp-backend node /test/test-aws-hub-spoke.mjs`

const API = "http://127.0.0.1:3000";

// Directive version of the user's design ask. Pre-answers the
// questions the AWS prompt would otherwise force Claude to ask
// (SSM-only, single-region, accept endpoint cost) so the build
// turn produces a final <bicep> marker in one shot.
//
// NOTE: user originally asked for cross-region spokes. CFN can't
// span regions in a single stack and our deploy_cloudformation tool
// is single-stack per call, so we'd need a multi-call push that
// loops region-by-region. For the e2e pipeline-correctness test
// we keep it single-region (all 3 VPCs in us-east-1) — same
// architectural shape, deployable in one CFN call. Iterate to
// cross-region once the basic pipeline is proven clean.
const USER_PROMPT = `Design and emit a final CloudFormation template — skip clarifying questions, do not ask via <answers>, just produce the template.

Architecture:
- Hub-spoke in us-east-1 (single region for this stack — single CFN stack, deployable in one deploy_cloudformation call).
- Hub VPC 10.0.0.0/16 with one private subnet 10.0.1.0/24.
- Spoke 1 VPC 10.1.0.0/16 with one private subnet 10.1.1.0/24.
- Spoke 2 VPC 10.2.0.0/16 with one private subnet 10.2.1.0/24.
- VPC peerings: hub <-> spoke1, hub <-> spoke2, with route-table updates on both sides.
- One t3.micro Amazon Linux 2023 instance in each VPC's private subnet — no public IPs, no SSH, no password.
- SSM-only access: each instance gets an IAM instance profile with AmazonSSMManagedInstanceCore.
- SSM/SSMMessages/EC2Messages interface endpoints in the hub VPC only — spokes reach SSM via the peerings (do NOT add endpoints in the spokes; the user accepts the routing approach to keep cost down).
- Tag every taggable resource with mcp-project and mcp-topology-id.

Validate the template with validate_cloudformation before emitting the <bicep> marker. Use \`!Sub '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}'\` for the AMI. Don't ask any questions — emit the topology + the template.`;

const PROJECT_NAME = `mft-aws-hub-${Math.floor(Date.now() / 1000)}`;

// ── SSE helper ──────────────────────────────────────────────────
// The /api/chat endpoint emits Server-Sent Events. We need to parse
// the wire format ourselves because we're driving from Node, not a
// browser. Each event ends with `\n\n`; each line is `event: name`
// or `data: <json>`.
async function* sseEvents(response) {
  if (!response.body) throw new Error("no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (true) {
      const i = buf.indexOf("\n\n");
      if (i === -1) break;
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // keepalive comment
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      if (dataLines.length > 0) {
        yield { event, data: dataLines.join("\n") };
      }
    }
  }
}

/** Fire one chat turn against /api/chat. Returns the full assistant
 *  text + tool-call summary once `done` arrives. Streams progress
 *  to stdout as it goes so a long-running deploy isn't a black box. */
async function chatTurn({ messages, projectId, stage, topologyId, label }) {
  console.log(`\n========================================`);
  console.log(`[${label}] sending turn (stage=${stage})`);
  console.log(`========================================`);
  const t0 = Date.now();
  const res = await fetch(`${API}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      project_id: projectId,
      stage,
      topology_id: topologyId ?? null,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/api/chat → ${res.status}: ${body || res.statusText}`);
  }
  let assistantText = "";
  const toolCalls = [];
  let lastTextPrintAt = 0;
  let unresolvedTools = new Map();
  for await (const ev of sseEvents(res)) {
    if (ev.event === "text") {
      const { delta } = JSON.parse(ev.data);
      assistantText += delta;
      // Lightly throttle progress prints: every 1.5s flush a snippet.
      if (Date.now() - lastTextPrintAt > 1500) {
        const tail = assistantText.slice(-160).replace(/\s+/g, " ").trim();
        process.stdout.write(`\r[${label}] …${tail.padEnd(160).slice(-160)}`);
        lastTextPrintAt = Date.now();
      }
    } else if (ev.event === "tool_use") {
      const { id, name, input } = JSON.parse(ev.data);
      unresolvedTools.set(id, { name, input });
      console.log(`\n[${label}] tool_use: ${name}`);
    } else if (ev.event === "tool_result") {
      const { id, is_error, content_preview } = JSON.parse(ev.data);
      const u = unresolvedTools.get(id) ?? { name: "?" };
      unresolvedTools.delete(id);
      const pv = (content_preview ?? "").slice(0, 600).replace(/\s+/g, " ");
      console.log(
        `[${label}] tool_result: ${u.name} ${is_error ? "ERROR" : "ok"} — ${pv}${(content_preview ?? "").length > 600 ? "…" : ""}`
      );
      toolCalls.push({ name: u.name, is_error, content_preview });
    } else if (ev.event === "error") {
      const { message } = JSON.parse(ev.data);
      console.warn(`\n[${label}] error event: ${message}`);
    } else if (ev.event === "done") {
      break;
    }
  }
  process.stdout.write("\n");
  console.log(`[${label}] turn complete in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${toolCalls.length} tool calls, ${assistantText.length} chars`);
  return { assistantText, toolCalls };
}

function parseBicepMarker(text) {
  const m = text.match(/<bicep>\s*([\s\S]*?)\s*<\/bicep>/i);
  return m ? m[1].trim() : null;
}

function parseTopologyMarker(text) {
  const m = text.match(/<topology>\s*([\s\S]*?)\s*<\/topology>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ── push prompt builder (mirror of frontend useChat.ts) ─────────
function buildAwsPushPrompt(projectName, topologyId, bicep) {
  const tags = { "mcp-project": projectName };
  if (topologyId) tags["mcp-topology-id"] = topologyId;
  const isMultiFile = /^\s*\/\/\s*===\s*FILE\s*:/m.test(bicep || "");
  const paramHint = isMultiFile
    ? "`files` = the multi-file template below split by the `// === FILE: <name> ===` separators (each section becomes one entry in the files map); `entry` = the entry-point filename (typically `main.yaml`); "
    : "`template` = the CloudFormation template below verbatim (do NOT regenerate, rename, simplify, or modify it); ";
  return (
    `Push the architecture to AWS now. ` +
    `Call the \`deploy_cloudformation\` tool ONCE with these parameters: ` +
    paramHint +
    `\`stack_name\` = a kebab-case name for this stack (e.g. \`mcp-${projectName}-${topologyId ? topologyId.slice(0, 8) : "main"}\`); ` +
    `\`region\` = the region the template targets (default us-east-1); ` +
    `\`capabilities\` = pass exactly the ones the template needs (CAPABILITY_IAM if it creates IAM roles/policies, CAPABILITY_NAMED_IAM if any roles have explicit names); ` +
    `\`required_tags\` = ${JSON.stringify(tags)} (CloudFormation propagates stack tags to taggable resources). ` +
    `After the tool returns, inspect the result. On is_error: true, emit <topology> with affected nodes' status failed. On success, emit the topology with all nodes success.\n\n` +
    "```\n" +
    bicep +
    "\n```"
  );
}

function buildAwsTeardownPrompt(projectName, topologyId) {
  const filter = topologyId
    ? `\`tag_filters\` = \`{ "mcp-project": "${projectName}", "mcp-topology-id": "${topologyId}" }\` (per-topology destroy)`
    : `\`tag_filters\` = \`{ "mcp-project": "${projectName}" }\` (project-wide tear-down)`;
  return (
    `Tear down AWS resources for this project now. Use the \`destroy_aws\` tool with ${filter}. ` +
    `The tool runs aws cloudformation delete-stack for matching CloudFormation stacks and waits for stack-delete-complete. ` +
    `After the tool returns, emit <topology>{"nodes":[],"edges":[]}</topology> if it succeeded, or the prior topology with statuses set to failed if it didn't.`
  );
}

// ── main ────────────────────────────────────────────────────────
async function main() {
  console.log(`[mft-aws] project: ${PROJECT_NAME}`);

  // 1. Create the project (cloud=aws so the chat picks the AWS prompt + AWS tools).
  const projRes = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: PROJECT_NAME,
      description: "AWS hub-spoke e2e test (cross-region t3.micro VMs + SSM)",
      cloud: "aws",
    }),
  });
  if (!projRes.ok) {
    throw new Error(`create project → ${projRes.status}: ${await projRes.text()}`);
  }
  const project = await projRes.json();
  console.log(`[mft-aws] project created: ${project.id} (cloud=${project.cloud})`);

  // 2. Build turn.
  const buildResult = await chatTurn({
    messages: [{ role: "user", content: USER_PROMPT }],
    projectId: project.id,
    stage: "build",
    topologyId: null,
    label: "build",
  });
  const bicep = parseBicepMarker(buildResult.assistantText);
  const topology = parseTopologyMarker(buildResult.assistantText);
  if (!bicep) {
    console.log("\n[mft-aws] build assistant text (last 2000 chars):");
    console.log(buildResult.assistantText.slice(-2000));
    throw new Error("no <bicep> marker emitted by build turn");
  }
  console.log(`[mft-aws] captured CFN template: ${bicep.length} chars, ${(bicep.match(/^\s*\/\/\s*===\s*FILE\s*:/gm) || []).length} file separators`);
  console.log(`[mft-aws] captured topology: ${topology ? topology.nodes.length : 0} nodes, ${topology ? topology.edges.length : 0} edges`);

  // 3. Create topology row.
  const topoRes = await fetch(`${API}/api/topologies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: project.id,
      name: "hub-spoke-aws",
      bicep,
      topology,
    }),
  });
  if (!topoRes.ok) {
    throw new Error(`create topology → ${topoRes.status}: ${await topoRes.text()}`);
  }
  const topo = await topoRes.json();
  console.log(`[mft-aws] topology row created: ${topo.id}`);

  // 4. Push turn (cycle 1).
  const pushPrompt = buildAwsPushPrompt(PROJECT_NAME, topo.id, bicep);
  const pushResult = await chatTurn({
    messages: [{ role: "user", content: pushPrompt }],
    projectId: project.id,
    stage: "push",
    topologyId: topo.id,
    label: "push#1",
  });
  const pushDeploy = pushResult.toolCalls.find((c) => c.name === "deploy_cloudformation");
  if (!pushDeploy) {
    throw new Error("push#1: deploy_cloudformation was not called by Claude");
  }
  if (pushDeploy.is_error) {
    console.log("[mft-aws] push#1 deploy FAILED — full content_preview:");
    console.log(pushDeploy.content_preview);
    throw new Error("push#1: deploy_cloudformation reported is_error");
  }
  console.log("[mft-aws] push#1 deploy SUCCESS");

  // 5. Tear-down turn (cycle 1).
  const downPrompt1 = buildAwsTeardownPrompt(PROJECT_NAME, topo.id);
  const downResult1 = await chatTurn({
    messages: [{ role: "user", content: downPrompt1 }],
    projectId: project.id,
    stage: "teardown",
    topologyId: topo.id,
    label: "teardown#1",
  });
  const down1 = downResult1.toolCalls.find((c) => c.name === "destroy_aws");
  if (!down1 || down1.is_error) {
    throw new Error("teardown#1: destroy_aws missing or errored");
  }
  console.log("[mft-aws] teardown#1 SUCCESS");

  // 6. Push turn (cycle 2 — re-deploy after teardown).
  const pushResult2 = await chatTurn({
    messages: [{ role: "user", content: buildAwsPushPrompt(PROJECT_NAME, topo.id, bicep) }],
    projectId: project.id,
    stage: "push",
    topologyId: topo.id,
    label: "push#2",
  });
  const pushDeploy2 = pushResult2.toolCalls.find((c) => c.name === "deploy_cloudformation");
  if (!pushDeploy2 || pushDeploy2.is_error) {
    throw new Error("push#2: deploy_cloudformation missing or errored");
  }
  console.log("[mft-aws] push#2 deploy SUCCESS");

  // 7. Tear-down turn (cycle 2).
  const downResult2 = await chatTurn({
    messages: [{ role: "user", content: buildAwsTeardownPrompt(PROJECT_NAME, topo.id) }],
    projectId: project.id,
    stage: "teardown",
    topologyId: topo.id,
    label: "teardown#2",
  });
  const down2 = downResult2.toolCalls.find((c) => c.name === "destroy_aws");
  if (!down2 || down2.is_error) {
    throw new Error("teardown#2: destroy_aws missing or errored");
  }
  console.log("[mft-aws] teardown#2 SUCCESS");

  console.log("\n[mft-aws] ALL CYCLES CLEAN ✓");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n[mft-aws] FAILED: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
