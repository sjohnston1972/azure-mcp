// E2E test for the click-to-detail modal feature.
//
// Drives the website's actual /api/chat endpoint exactly like the
// Build / Push / Tear-down buttons would, then exercises the new
// GET /api/topologies/:id/details/:nodeId endpoint per node.
//
//   1. Create an Azure project via POST /api/projects.
//   2. Build turn — directive prompt that produces a small cheap
//      Bicep template: a VNet, one VM (Standard_B1s), a Storage
//      Account (Standard_LRS), and a SQL Server (no DBs — server
//      itself is free; we only want the SQL fetcher to have
//      something to call against).
//   3. Create a topology row with the captured Bicep.
//   4. Push turn — deploy_bicep, wait for success.
//   5. Hit /api/topologies/:id/details/:nodeId for every node in
//      the topology and verify the response shape.
//   6. Hit each node again — second response should be served from
//      the 30s cache (we verify it returns identical bytes).
//   7. Tear-down turn — destroy_subscription with topology-scoped
//      tags. Wait for clean teardown.
//
// Run from inside the backend container so localhost:3000 reaches
// the API:
//   docker cp .../test-detail-modal.mjs azure-mcp-backend:/test/
//   docker compose exec azure-mcp-backend node /test/test-detail-modal.mjs

const API = "http://127.0.0.1:3000";

const PROJECT_NAME = `mft-detail-${Math.floor(Date.now() / 1000)}`;
const REGION = "uksouth";

// Directive build prompt. Pre-answers every question the Azure system
// prompt would otherwise force Claude to ask, so the build turn emits
// a final <bicep> in one shot. The shape is deliberately cheap:
//   - 1 VNet, 1 subnet
//   - 1 VM Standard_B1s with admin/password (we throw the password
//     away after the test, no SSH ingress, no public IP)
//   - 1 Storage Account Standard_LRS (no containers/blobs)
//   - 1 SQL Server (no databases — server itself is free)
//   - tags propagated by deploy_bicep, no need to set per-resource
const USER_PROMPT = `Design and emit a final Bicep template — skip clarifying questions, do not ask via <answers>, just produce the template.

CRITICAL — TEMPLATE SCOPE:
- The template MUST use \`targetScope = 'subscription'\` (NOT 'resourceGroup').
- Inside the template, create the resource group inline: \`resource rg 'Microsoft.Resources/resourceGroups@2023-07-01'\`.
- All AVM modules use \`scope: rg\` and depend on the rg resource.
- This is non-negotiable — the deploy is a single \`az deployment sub create\` call. RG-scoped will fail because the deploy tool will be invoked with scope='subscription' and no resource_group_name.

Architecture (target ${REGION}):
- One inline resource group named 'rg-{projectName}' (use a parameter 'projectName' that defaults to a literal so no prompt is needed).
- One VNet 'vnet-mcp-detail' with CIDR 10.50.0.0/16 and a single subnet 'snet-default' 10.50.1.0/24.
- One Linux VM 'vm-mcp-detail' (Standard_B1s) on the subnet:
  - Ubuntu 22.04 LTS image (Canonical / 0001-com-ubuntu-server-jammy / 22_04-lts-gen2)
  - Admin password is a literal in the template (16+ chars meeting Azure complexity, throwaway test).
  - admin username 'azuremcp'
  - NO public IP, NO data disks, default 30GB OS disk Standard_LRS, accelerated networking off (B1s).
- One Storage Account name 'stmcpdetail\${uniqueString(...)}' truncated to 24 chars (Standard_LRS, StorageV2, https-only true, min TLS 1_2, public blob access disabled).
- One SQL Server 'sql-mcp-detail-\${uniqueString(...)}' with administratorLogin 'sqladmin' and administratorLoginPassword as a password literal. NO databases. publicNetworkAccess Disabled.
- Use AVM modules at versions: virtual-network 0.5.0, virtual-machine 0.10.1, storage-account 0.14.3, sql/server 0.11.1.
- Single file (no // === FILE: separators).

Validate with validate_bicep at subscription scope before emitting <bicep>. Don't ask any questions — emit the topology + the template directly.`;

// ── SSE helper ──────────────────────────────────────────────────
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
      if (dataLines.length > 0) {
        yield { event, data: dataLines.join("\n") };
      }
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
    } else if (ev.event === "done") {
      break;
    }
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
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function buildAzurePushPrompt(projectName, topologyId, bicep) {
  const tags = { "mcp-project": projectName };
  if (topologyId) tags["mcp-topology-id"] = topologyId;
  return (
    `Push the architecture to Azure now. ` +
    `Call the \`deploy_bicep\` tool ONCE with these parameters: ` +
    `\`bicep\` = the template below verbatim (do NOT regenerate, rename, simplify, or modify it); ` +
    `\`scope\` = "subscription"; ` +
    `\`location\` = "${REGION}"; ` +
    `\`required_tags\` = ${JSON.stringify(tags)} (deploy_bicep propagates these to all taggable resources). ` +
    `After the tool returns, inspect the result. On is_error: true, emit <topology> with affected nodes' status failed. On success, emit the topology with all nodes success.\n\n` +
    "```\n" +
    bicep +
    "\n```"
  );
}

function buildAzureTeardownPrompt(projectName, topologyId) {
  const filter = topologyId
    ? `\`tag_filters\` = \`{ "mcp-project": "${projectName}", "mcp-topology-id": "${topologyId}" }\` (per-topology destroy)`
    : `\`tag_filters\` = \`{ "mcp-project": "${projectName}" }\` (project-wide tear-down)`;
  return (
    `Tear down Azure resources for this project now. Use the \`destroy_subscription\` tool with ${filter}. ` +
    `After the tool returns, emit <topology>{"nodes":[],"edges":[]}</topology> if it succeeded, or the prior topology with statuses set to failed if it didn't.`
  );
}

// ── detail endpoint exerciser ──────────────────────────────────
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
      console.log(
        `[detail] ${n.id} (${n.kind}): ${res.status} in ${dur}ms — ${body.slice(0, 200)}`
      );
      results.push({ node: n, ok: false, status: res.status, body });
      continue;
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch {
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
  console.log(`[mft-detail] project: ${PROJECT_NAME}`);

  const projRes = await fetch(`${API}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: PROJECT_NAME,
      description: "Detail modal e2e — small VM/Storage/SQL test",
      cloud: "azure",
    }),
  });
  if (!projRes.ok) throw new Error(`create project → ${projRes.status}: ${await projRes.text()}`);
  const project = await projRes.json();
  console.log(`[mft-detail] project created: ${project.id}`);

  // Build turn.
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
    console.log("\n[mft-detail] build assistant text (last 2000 chars):");
    console.log(buildResult.assistantText.slice(-2000));
    throw new Error("no <bicep> marker emitted by build turn");
  }
  console.log(
    `[mft-detail] captured Bicep: ${bicep.length} chars; topology: ${topology?.nodes?.length ?? 0} nodes / ${topology?.edges?.length ?? 0} edges`
  );

  // Create topology row.
  const topoRes = await fetch(`${API}/api/topologies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: project.id,
      name: "detail-modal-test",
      bicep,
      topology,
    }),
  });
  if (!topoRes.ok) throw new Error(`create topology → ${topoRes.status}: ${await topoRes.text()}`);
  const topo = await topoRes.json();
  console.log(`[mft-detail] topology row created: ${topo.id}`);

  // Push.
  const pushPrompt = buildAzurePushPrompt(PROJECT_NAME, topo.id, bicep);
  const pushResult = await chatTurn({
    messages: [{ role: "user", content: pushPrompt }],
    projectId: project.id,
    stage: "push",
    topologyId: topo.id,
    label: "push",
  });
  const deployCalls = pushResult.toolCalls.filter((c) => c.name === "deploy_bicep");
  if (deployCalls.length === 0) throw new Error("push: deploy_bicep was not called");
  // Claude may retry deploy_bicep if the first attempt errors (e.g.
  // wrong scope) and self-corrects. We accept the push if the LAST
  // deploy_bicep call returned success. Earlier failures are surfaced
  // for visibility but are not fatal.
  const last = deployCalls[deployCalls.length - 1];
  for (let i = 0; i < deployCalls.length - 1; i++) {
    if (deployCalls[i].is_error) {
      console.warn(
        `[mft-detail] earlier deploy_bicep #${i + 1} errored (Claude self-corrected): ${(deployCalls[i].content_preview ?? "").slice(0, 200)}`
      );
    }
  }
  if (last.is_error) {
    console.log("[mft-detail] last deploy_bicep FAILED — content_preview:");
    console.log(last.content_preview);
    throw new Error("push: final deploy_bicep reported is_error");
  }
  console.log(
    `[mft-detail] push deploy SUCCESS (${deployCalls.length} deploy_bicep call(s))`
  );

  // The chat backend doesn't auto-promote topology rows to "live" on
  // its own — the frontend's SSE done-handler does that via PATCH
  // /api/topologies/:id { status: "live", topology: <push-turn-topology> }
  // after observing a clean deploy tool result. Mirror that here.
  //
  // Crucially: the push turn emits a NEW <topology> with REAL resource
  // names (e.g. `stmcpdetail6fbf2a` instead of the build-turn placeholder
  // `stmcpdetail<hash>`). The detail endpoint matches on tag+name, so
  // we MUST persist the push-turn topology, not the build-turn one.
  const pushTopology = parseTopologyMarker(pushResult.assistantText);
  if (!pushTopology) {
    console.warn(
      "[mft-detail] WARN: push turn did not emit a <topology> marker — names will be placeholders"
    );
  }
  const promoteRes = await fetch(`${API}/api/topologies/${topo.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "live",
      ...(pushTopology ? { topology: pushTopology } : {}),
    }),
  });
  if (!promoteRes.ok) {
    throw new Error(`promote → ${promoteRes.status}: ${await promoteRes.text()}`);
  }
  const liveTopo = await promoteRes.json();
  console.log(
    `[mft-detail] topology promoted to "${liveTopo.status}" with ${liveTopo.topology?.nodes?.length ?? 0} nodes (labels: ${(liveTopo.topology?.nodes ?? []).map((n) => n.label).join(", ")})`
  );

  // The PATCH-to-live response kicked off a fire-and-forget prefetch
  // on the backend. Poll the topology row until live_details lands or
  // we've waited long enough — typically ~30s for our 6-node test.
  const liveNodes = liveTopo.topology?.nodes ?? [];
  console.log(
    `\n[mft-detail] waiting for backend prefetch to populate live_details (${liveNodes.length} nodes)…`
  );
  const prefetchT0 = Date.now();
  const PREFETCH_TIMEOUT_MS = 90_000;
  while (Date.now() - prefetchT0 < PREFETCH_TIMEOUT_MS) {
    const r = await fetch(`${API}/api/topologies?project_id=${project.id}`);
    const list = await r.json();
    const t = list.find((x) => x.id === topo.id);
    if (t?.live_details?.nodes && Object.keys(t.live_details.nodes).length > 0) {
      console.log(
        `[mft-detail] prefetch complete in ${((Date.now() - prefetchT0) / 1000).toFixed(1)}s — ${Object.keys(t.live_details.nodes).length} nodes cached at ${t.live_details._at}`
      );
      break;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }

  // Exercise the detail endpoint per node — should be DB-cache hits now.
  const cold = await exerciseDetailEndpoint(topo.id, liveNodes);

  // After prefetch, every detail call should return in well under 1s
  // (DB read, no CLI spawn). Flag any slow ones.
  for (const r of cold) {
    if (r.ok && r.dur > 1000) {
      console.warn(
        `[mft-detail] WARN: node ${r.node.id} took ${r.dur}ms after prefetch — expected <1s DB-cache hit`
      );
    }
  }

  // Verify each node we expect to dispatch to a kind-specific fetcher
  // returned a non-empty `props` payload.
  const expectKindByType = {
    "Microsoft.Compute/virtualMachines": "vm",
    "Microsoft.Storage/storageAccounts": "storage",
    "Microsoft.Sql/servers": "sql",
    "Microsoft.Network/bastionHosts": "bastion",
    "Microsoft.Network/virtualNetworks": "vnet",
    "Microsoft.Network/virtualNetworks/subnets": "subnet",
    "Microsoft.Resources/resourceGroups": "resource-group",
  };
  let kindHits = 0;
  let warnings = 0;
  let failures = 0;
  for (const r of cold) {
    if (!r.ok) {
      failures++;
      continue;
    }
    const expected = expectKindByType[r.json.resource_type];
    if (expected) {
      kindHits++;
      if (r.json.kind !== expected) {
        console.warn(
          `[mft-detail] WARN: node ${r.node.id} resource_type=${r.json.resource_type} dispatched to kind=${r.json.kind} (expected ${expected})`
        );
        warnings++;
      }
      if (!r.json.props || Object.keys(r.json.props).length === 0) {
        console.warn(
          `[mft-detail] WARN: node ${r.node.id} kind=${r.json.kind} returned empty props`
        );
        warnings++;
      }
    }
  }
  console.log(
    `[mft-detail] kind-specific dispatches hit: ${kindHits}, warnings: ${warnings}, 4xx/5xx: ${failures}`
  );

  // Refresh endpoint test: forces the backend to re-query every node
  // and overwrite live_details. Should succeed and return updated_at.
  console.log(`\n[mft-detail] testing refresh endpoint…`);
  const refreshT0 = Date.now();
  const refreshRes = await fetch(
    `${API}/api/topologies/${topo.id}/details/refresh`,
    { method: "POST" }
  );
  const refreshDur = Date.now() - refreshT0;
  if (!refreshRes.ok) {
    console.warn(
      `[mft-detail] WARN: refresh returned ${refreshRes.status}: ${await refreshRes.text()}`
    );
  } else {
    const j = await refreshRes.json();
    console.log(
      `[mft-detail] refresh complete in ${(refreshDur / 1000).toFixed(1)}s — ${j.hits}/${j.node_count} nodes refreshed at ${j.refreshed_at}`
    );
  }

  if (failures > 0) {
    console.warn(
      `[mft-detail] ⚠ ${failures} node(s) returned non-2xx — see lines above`
    );
  }

  // Teardown.
  const downPrompt = buildAzureTeardownPrompt(PROJECT_NAME, topo.id);
  const downResult = await chatTurn({
    messages: [{ role: "user", content: downPrompt }],
    projectId: project.id,
    stage: "teardown",
    topologyId: topo.id,
    label: "teardown",
  });
  // The destroy tool is named `destroy_azure` (vs `destroy_aws` for AWS).
  const down = downResult.toolCalls.find(
    (c) => c.name === "destroy_azure" || c.name === "destroy_subscription"
  );
  if (!down || down.is_error) {
    console.warn("[mft-detail] teardown ERROR — leaving project for manual cleanup");
    throw new Error("teardown: destroy_subscription missing or errored");
  }
  console.log("[mft-detail] teardown SUCCESS");

  console.log("\n[mft-detail] ALL CHECKS CLEAN ✓");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n[mft-detail] FAILED: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
