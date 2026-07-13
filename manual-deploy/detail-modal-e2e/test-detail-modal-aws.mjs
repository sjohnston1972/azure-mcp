// AWS twin of test-detail-modal.mjs. Drives /api/chat for a small,
// cheap deploy → exercises the per-node detail endpoint → tears down.
//
// Scope: 1 VPC, 1 subnet, 1 SG, 1 IAM role (SSM), 1 SSM VPC endpoint,
// 1 t3.micro EC2 instance. t3.micro is free-tier eligible; the full
// stack costs ~$0.01/hr.

const API = "http://127.0.0.1:3000";

const PROJECT_NAME = `mft-aws-detail-${Math.floor(Date.now() / 1000)}`;
const REGION = "us-east-1";

const USER_PROMPT = `Design and emit a final CloudFormation template — skip clarifying questions, do not ask via <answers>, just produce the template.

Architecture (target ${REGION}):
- 1 VPC 'vpc-mcp-detail' (10.60.0.0/16) with DNS hostnames + DNS support enabled.
- 1 private subnet 'snet-mcp-detail' (10.60.1.0/24) in the first AZ of ${REGION}.
- 1 IAM role 'role-mcp-ssm' with the managed policy AmazonSSMManagedInstanceCore attached, plus an InstanceProfile pointing at it (same name).
- 1 security group 'sg-mcp-detail' attached to the VPC with NO ingress rules (egress all).
- 3 SSM interface endpoints in the subnet, attached to the SG: \`com.amazonaws.${REGION}.ssm\`, \`com.amazonaws.${REGION}.ssmmessages\`, \`com.amazonaws.${REGION}.ec2messages\`. PrivateDnsEnabled = true.
- 1 EC2 instance 'ec2-mcp-detail' (t3.micro, Amazon Linux 2023). Use \`{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}\` inline on the resource's ImageId (NOT as a parameter default). IamInstanceProfile = the role above. Attach the SG. Private subnet, no public IP.
- Tag every taggable resource with \`mcp-project\` and \`mcp-topology-id\` (CloudFormation propagates stack-level tags).

Validate the template with validate_cloudformation before emitting the <bicep> marker. Don't ask any questions — emit the topology + the template.`;

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
        if (line.startsWith(":")) continue;
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
    }
  }
}

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
  const unresolvedTools = new Map();
  for await (const ev of sseEvents(res)) {
    if (ev.event === "text") {
      const { delta } = JSON.parse(ev.data);
      assistantText += delta;
      if (Date.now() - lastTextPrintAt > 1500) {
        const tail = assistantText.slice(-160).replace(/\s+/g, " ").trim();
        process.stdout.write(`\r[${label}] …${tail.padEnd(160).slice(-160)}`);
        lastTextPrintAt = Date.now();
      }
    } else if (ev.event === "tool_use") {
      const { id, name } = JSON.parse(ev.data);
      unresolvedTools.set(id, { name });
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
    } else if (ev.event === "done") break;
  }
  process.stdout.write("\n");
  console.log(
    `[${label}] turn complete in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${toolCalls.length} tool calls, ${assistantText.length} chars`
  );
  return { assistantText, toolCalls };
}

function parseBicepMarker(text) {
  const m = text.match(/<bicep>\s*([\s\S]*?)\s*<\/bicep>/i);
  return m ? m[1].trim() : null;
}
function parseTopologyMarker(text) {
  const m = text.match(/<topology>\s*([\s\S]*?)\s*<\/topology>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function buildAwsPushPrompt(projectName, topologyId, bicep) {
  const tags = { "mcp-project": projectName };
  if (topologyId) tags["mcp-topology-id"] = topologyId;
  return (
    `Push the architecture to AWS now. ` +
    `Call the \`deploy_cloudformation\` tool ONCE with these parameters: ` +
    `\`template\` = the CloudFormation template below verbatim; ` +
    `\`stack_name\` = \`mcp-${projectName}-${topologyId.slice(0, 8)}\`; ` +
    `\`region\` = "${REGION}"; ` +
    `\`capabilities\` = ["CAPABILITY_NAMED_IAM"] (the template creates a named IAM role); ` +
    `\`required_tags\` = ${JSON.stringify(tags)}. ` +
    `After the tool returns, inspect the result. On is_error: true, emit <topology> with affected nodes' status failed. On success, emit the topology with all nodes success.\n\n` +
    "```\n" + bicep + "\n```"
  );
}

function buildAwsTeardownPrompt(projectName, topologyId) {
  return (
    `Tear down AWS resources for this project now. Use the \`destroy_aws\` tool with \`tag_filters\` = \`{ "mcp-project": "${projectName}", "mcp-topology-id": "${topologyId}" }\`. ` +
    `After the tool returns, emit <topology>{"nodes":[],"edges":[]}</topology> if it succeeded, or the prior topology with statuses set to failed if it didn't.`
  );
}

async function exerciseDetailEndpoint(topologyId, nodes) {
  console.log(`\n========================================`);
  console.log(`[detail] exercising /details/:nodeId for ${nodes.length} nodes`);
  console.log(`========================================`);
  const results = [];
  for (const n of nodes) {
    const url = `${API}/api/topologies/${topologyId}/details/${encodeURIComponent(n.id)}`;
    const t0 = Date.now();
    const res = await fetch(url);
    const body = await res.text();
    const dur = Date.now() - t0;
    if (!res.ok) {
      console.log(`[detail] ${n.id} (${n.kind}): ${res.status} in ${dur}ms — ${body.slice(0, 200)}`);
      results.push({ node: n, ok: false, status: res.status, body });
      continue;
    }
    let json;
    try { json = JSON.parse(body); } catch {
      console.log(`[detail] ${n.id} (${n.kind}): non-JSON response`);
      results.push({ node: n, ok: false, status: res.status, body });
      continue;
    }
    const summary = `${json.cloud}/${json.kind} type=${json.resource_type} state=${json.state ?? "—"} loc=${json.location} props=${Object.keys(json.props ?? {}).join(",")}`;
    console.log(`[detail] ${n.id} (${n.kind}): 200 in ${dur}ms — ${summary}`);
    results.push({ node: n, ok: true, json, dur });
  }
  return results;
}

async function main() {
  console.log(`[mft-aws-detail] project: ${PROJECT_NAME}`);

  const projRes = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: PROJECT_NAME,
      description: "AWS detail-modal e2e — small VPC/EC2/SG/IAM/VPC-endpoint",
      cloud: "aws",
    }),
  });
  if (!projRes.ok) throw new Error(`create project → ${projRes.status}: ${await projRes.text()}`);
  const project = await projRes.json();
  console.log(`[mft-aws-detail] project created: ${project.id}`);

  // Build.
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
    console.log("\n[mft-aws-detail] build assistant text (last 2000 chars):");
    console.log(buildResult.assistantText.slice(-2000));
    throw new Error("no <bicep> marker emitted by build turn");
  }
  console.log(
    `[mft-aws-detail] captured CFN: ${bicep.length} chars; topology: ${topology?.nodes?.length ?? 0} nodes / ${topology?.edges?.length ?? 0} edges`
  );

  const topoRes = await fetch(`${API}/api/topologies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: project.id,
      name: "detail-modal-aws",
      bicep,
      topology,
    }),
  });
  if (!topoRes.ok) throw new Error(`create topology → ${topoRes.status}: ${await topoRes.text()}`);
  const topo = await topoRes.json();
  console.log(`[mft-aws-detail] topology row created: ${topo.id}`);

  // Push.
  const pushPrompt = buildAwsPushPrompt(PROJECT_NAME, topo.id, bicep);
  const pushResult = await chatTurn({
    messages: [{ role: "user", content: pushPrompt }],
    projectId: project.id,
    stage: "push",
    topologyId: topo.id,
    label: "push",
  });
  const deployCalls = pushResult.toolCalls.filter((c) => c.name === "deploy_cloudformation");
  if (deployCalls.length === 0) throw new Error("push: deploy_cloudformation was not called");
  const last = deployCalls[deployCalls.length - 1];
  for (let i = 0; i < deployCalls.length - 1; i++) {
    if (deployCalls[i].is_error) {
      console.warn(
        `[mft-aws-detail] earlier deploy_cloudformation #${i + 1} errored (Claude self-corrected): ${(deployCalls[i].content_preview ?? "").slice(0, 200)}`
      );
    }
  }
  if (last.is_error) {
    console.log("[mft-aws-detail] last deploy FAILED — content_preview:");
    console.log(last.content_preview);
    throw new Error("push: final deploy_cloudformation reported is_error");
  }
  console.log(`[mft-aws-detail] push SUCCESS (${deployCalls.length} call(s))`);

  // Persist push-turn topology + promote to live (mirrors the frontend's
  // SSE done-handler).
  const pushTopology = parseTopologyMarker(pushResult.assistantText);
  const promoteRes = await fetch(`${API}/api/topologies/${topo.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "live",
      ...(pushTopology ? { topology: pushTopology } : {}),
    }),
  });
  if (!promoteRes.ok) throw new Error(`promote → ${promoteRes.status}: ${await promoteRes.text()}`);
  const liveTopo = await promoteRes.json();
  console.log(
    `[mft-aws-detail] topology promoted to "${liveTopo.status}" with ${liveTopo.topology?.nodes?.length ?? 0} nodes (labels: ${(liveTopo.topology?.nodes ?? []).map((n) => n.label).join(", ")})`
  );

  // Wait for background prefetch.
  const liveNodes = liveTopo.topology?.nodes ?? [];
  console.log(`\n[mft-aws-detail] waiting for backend prefetch to populate live_details (${liveNodes.length} nodes)…`);
  const prefetchT0 = Date.now();
  const PREFETCH_TIMEOUT_MS = 180_000;
  while (Date.now() - prefetchT0 < PREFETCH_TIMEOUT_MS) {
    const r = await fetch(`${API}/api/topologies?project_id=${project.id}`);
    const list = await r.json();
    const t = list.find((x) => x.id === topo.id);
    if (t?.live_details?.nodes && Object.keys(t.live_details.nodes).length > 0) {
      console.log(
        `[mft-aws-detail] prefetch complete in ${((Date.now() - prefetchT0) / 1000).toFixed(1)}s — ${Object.keys(t.live_details.nodes).length} nodes cached at ${t.live_details._at}`
      );
      break;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }

  const cold = await exerciseDetailEndpoint(topo.id, liveNodes);

  const expectKindByType = {
    "AWS::EC2::Instance": "ec2",
    "AWS::EC2::VPC": "vpc",
    "AWS::EC2::Subnet": "subnet",
    "AWS::EC2::SecurityGroup": "security-group",
    "AWS::EC2::VPCEndpoint": "vpc-endpoint",
    "AWS::IAM::Role": "iam-role",
    "AWS::CloudFormation::Stack": "cloudformation-stack",
  };
  let kindHits = 0;
  let failures = 0;
  for (const r of cold) {
    if (!r.ok) { failures++; continue; }
    const expected = expectKindByType[r.json.resource_type];
    if (expected) {
      kindHits++;
      if (!r.json.props || Object.keys(r.json.props).length === 0) {
        console.warn(
          `[mft-aws-detail] WARN: node ${r.node.id} kind=${r.json.kind} returned empty props`
        );
      }
      if (r.dur > 1000) {
        console.warn(
          `[mft-aws-detail] WARN: node ${r.node.id} took ${r.dur}ms after prefetch — expected <1s DB-cache hit`
        );
      }
    }
  }
  console.log(`[mft-aws-detail] kind-specific dispatches hit: ${kindHits}, 4xx/5xx: ${failures}`);

  // Refresh endpoint.
  console.log(`\n[mft-aws-detail] testing refresh endpoint…`);
  const refreshT0 = Date.now();
  const refreshRes = await fetch(`${API}/api/topologies/${topo.id}/details/refresh`, { method: "POST" });
  const refreshDur = Date.now() - refreshT0;
  if (!refreshRes.ok) {
    console.warn(`[mft-aws-detail] WARN: refresh returned ${refreshRes.status}: ${await refreshRes.text()}`);
  } else {
    const j = await refreshRes.json();
    console.log(
      `[mft-aws-detail] refresh complete in ${(refreshDur / 1000).toFixed(1)}s — ${j.hits}/${j.node_count} nodes refreshed at ${j.refreshed_at}`
    );
  }

  // Teardown.
  const downPrompt = buildAwsTeardownPrompt(PROJECT_NAME, topo.id);
  const downResult = await chatTurn({
    messages: [{ role: "user", content: downPrompt }],
    projectId: project.id,
    stage: "teardown",
    topologyId: topo.id,
    label: "teardown",
  });
  const down = downResult.toolCalls.find((c) => c.name === "destroy_aws");
  if (!down || down.is_error) {
    console.warn("[mft-aws-detail] teardown ERROR — leaving project for manual cleanup");
    throw new Error("teardown: destroy_aws missing or errored");
  }
  console.log("[mft-aws-detail] teardown SUCCESS");

  console.log("\n[mft-aws-detail] ALL CHECKS CLEAN ✓");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n[mft-aws-detail] FAILED: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
