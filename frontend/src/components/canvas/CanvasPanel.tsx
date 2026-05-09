// Left pane of the workspace: topology canvas with React Flow.
//
// The topology now flows in from the parent — Claude emits a
// <topology>{...}</topology> marker in chat, useChat parses it, App
// holds it, and we render. The local "Load demo" button still works
// for offline poking.

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  applyEdgeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { AzureNode, type AzureNodeData } from "./AzureNode";
import { ResourceDetailModal } from "./ResourceDetailModal";
import { layoutNodes } from "../../lib/dagre-layout";
import type { Topology } from "../../lib/parse-topology";
import type { TopologyStatus } from "../../lib/types";

const nodeTypes = { azure: AzureNode };

function buildDemo(): Topology {
  return {
    nodes: [
      { id: "rg", label: "vigil-lab", kind: "resource-group", sublabel: "uksouth", status: "planned" },
      { id: "vnet", label: "vnet-core", kind: "vnet", sublabel: "10.10.0.0/16", status: "planned" },
      { id: "snet-app", label: "snet-app", kind: "subnet", sublabel: "10.10.1.0/24", status: "planned" },
      { id: "snet-db", label: "snet-db", kind: "subnet", sublabel: "10.10.2.0/24", status: "planned" },
      { id: "nsg", label: "nsg-app", kind: "nsg", sublabel: "https only", status: "planned" },
      { id: "app", label: "appsvc-vigil", kind: "app-service", sublabel: "P1v3 linux", status: "planned" },
      { id: "sql", label: "sql-vigil", kind: "sql", sublabel: "GP S2", status: "planned" },
      { id: "kv", label: "kv-vigil", kind: "key-vault", sublabel: "premium", status: "planned" },
      { id: "ai", label: "openai-vigil", kind: "openai", sublabel: "gpt-4o", status: "planned" },
    ],
    edges: [
      { id: "e1", source: "rg", target: "vnet" },
      { id: "e2", source: "vnet", target: "snet-app" },
      { id: "e3", source: "vnet", target: "snet-db" },
      { id: "e4", source: "snet-app", target: "nsg" },
      { id: "e5", source: "snet-app", target: "app" },
      { id: "e6", source: "snet-db", target: "sql" },
      { id: "e7", source: "rg", target: "kv" },
      { id: "e8", source: "rg", target: "ai" },
      { id: "e9", source: "app", target: "sql" },
      { id: "e10", source: "app", target: "kv" },
      { id: "e11", source: "app", target: "ai" },
    ],
  };
}

function topologyToFlow(t: Topology): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = t.nodes.map((n) => ({
    id: n.id,
    type: "azure",
    position: { x: 0, y: 0 },
    data: {
      label: n.label,
      sublabel: n.sublabel,
      kind: n.kind,
      status: n.status,
    } satisfies AzureNodeData as unknown as Record<string, unknown>,
  }));
  const edges: Edge[] = t.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: false,
    style: { stroke: "#717786" },
  }));
  return { nodes: layoutNodes(nodes, edges, "LR"), edges };
}

type Props = {
  /** Topology coming from the chat (Claude emits <topology>...</topology>).
   *  When null, the canvas is empty and shows hints + a "Load demo" button. */
  topology: Topology | null;
  /** Active project id. Used to clear local canvas state (override,
   *  loaded demo) when the user switches projects — even if both
   *  projects happen to have a null topology. */
  projectId: string | null;
  /** Active topology id (DB row). Required for the click-to-detail
   *  modal — the backend uses this to look up the cloud + tag scope
   *  for the resource lookup. Null when no saved topology is active
   *  (fresh chat, demo, etc.) — the modal will be disabled in that
   *  case. */
  topologyId?: string | null;
  /** Status of the active topology. The detail modal only opens when
   *  status === "live" (otherwise there's nothing in Azure/AWS to
   *  inspect). */
  topologyStatus?: TopologyStatus | null;
  /** Click handler for the example prompts in the empty state. Sends
   *  the chosen prompt as a chat turn so the canvas populates. */
  onExamplePrompt?: (prompt: string) => void;
};

export function CanvasPanel({
  topology,
  projectId,
  topologyId,
  topologyStatus,
  onExamplePrompt,
}: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner
        topology={topology}
        projectId={projectId}
        topologyId={topologyId}
        topologyStatus={topologyStatus}
        onExamplePrompt={onExamplePrompt}
      />
    </ReactFlowProvider>
  );
}

const EXAMPLE_PROMPTS = [
  "Design a small web app with a SQL database",
  "Plan a hub-and-spoke network with two spokes",
  "Sketch an Azure OpenAI chat app with private endpoints",
];

function CanvasInner({
  topology,
  projectId,
  topologyId,
  topologyStatus,
  onExamplePrompt,
}: Props) {
  // Click-to-detail modal state — open it from onNodeClick when the
  // topology is live (otherwise there's nothing in Azure/AWS to fetch).
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  const detailOpen = detailNodeId !== null;
  const canShowDetails = Boolean(topologyId) && topologyStatus === "live";

  const onNodeClick = useCallback(
    (_e: MouseEvent, node: Node) => {
      if (!canShowDetails) return;
      // Only allow click-through for resources that actually deployed
      // — pending/failed nodes don't exist in the cloud yet.
      const status = (node.data as unknown as AzureNodeData).status;
      if (status !== "success") return;
      setDetailNodeId(node.id);
    },
    [canShowDetails]
  );
  // When the parent passes a topology, that's the truth. The local
  // override (demo / cleared) only kicks in when there's nothing from
  // the parent. We also let the user nudge nodes around by hand —
  // local positions persist via React Flow's onNodesChange.
  const upstream = useMemo<{ nodes: Node[]; edges: Edge[] } | null>(
    () => (topology ? topologyToFlow(topology) : null),
    [topology]
  );

  const [override, setOverride] = useState<{ nodes: Node[]; edges: Edge[] } | null>(
    null
  );

  // Clear local canvas state in two cases:
  //   1. Claude emits a new topology — chat-driven update wins over
  //      any drags the user made or "Load demo" they triggered.
  //   2. The user switches projects — even if both old and new project
  //      have a null topology (e.g. you load the demo on project A,
  //      then switch to fresh project B), the demo/override should
  //      clear so B starts blank.
  useEffect(() => {
    setOverride(null);
  }, [topology, projectId]);

  const graph = override ?? upstream;
  const empty = !graph || graph.nodes.length === 0;

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // If we're currently displaying upstream (no local override),
      // promote it into a local copy on first interaction so the user
      // can drag without their tweaks being clobbered by re-renders.
      const base = override ?? upstream;
      if (!base) return;
      const next = { ...base, nodes: applyNodeChanges(changes, base.nodes) };
      setOverride(next);
    },
    [override, upstream]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const base = override ?? upstream;
      if (!base) return;
      const next = { ...base, edges: applyEdgeChanges(changes, base.edges) };
      setOverride(next);
    },
    [override, upstream]
  );

  const stats = useMemo(() => {
    if (!graph) return { total: 0, byStatus: {} as Record<string, number> };
    const total = graph.nodes.length;
    const byStatus = graph.nodes.reduce<Record<string, number>>((acc, n) => {
      const status = (n.data as unknown as AzureNodeData).status ?? "planned";
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});
    return { total, byStatus };
  }, [graph]);

  const loadDemo = () => setOverride(topologyToFlow(buildDemo()));
  // "Clear canvas" — wipe the visible graph entirely. We set the
  // override to an explicit empty graph (NOT null) so it doesn't
  // immediately fall back to the upstream topology from chat. If
  // Claude later emits a fresh <topology> marker, the upstream
  // topology change resets the override automatically (see the
  // useEffect on [topology, projectId] above) and the new design
  // appears.
  const clearCanvas = () => setOverride({ nodes: [], edges: [] });

  return (
    <section className="rounded-xl bg-surface-container-lowest border border-outline-variant/40 shadow-sm overflow-hidden flex flex-col h-full">
      <div className="px-6 py-4 border-b border-outline-variant/30 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold">Topology</h2>
          <p className="text-xs text-on-surface-variant">
            {empty
              ? "Renders when you ask Claude to design or modify an architecture."
              : `${stats.total} nodes • ${Object.entries(stats.byStatus)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(" • ")}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canShowDetails && !empty && (
            <span
              className="hidden md:inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant"
              title="Click any deployed node to see live cloud-API details (IPs, NICs, SKU, …)."
            >
              <span className="material-symbols-outlined text-[12px]">
                touch_app
              </span>
              click nodes for details
            </span>
          )}
          {empty ? (
            <button
              type="button"
              onClick={loadDemo}
              className="px-3 py-1.5 rounded-lg border border-outline-variant/40 text-xs font-semibold hover:bg-surface-container-high transition-colors"
            >
              Load demo
            </button>
          ) : (
            <button
              type="button"
              onClick={clearCanvas}
              className="px-3 py-1.5 rounded-lg border border-outline-variant/40 text-xs font-semibold hover:bg-surface-container-high transition-colors flex items-center gap-1.5"
              title="Wipe everything from the canvas. The next chat turn that emits a topology will repopulate it."
            >
              <span className="material-symbols-outlined text-[14px]">
                ink_eraser
              </span>
              Clear canvas
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 workbench-grid">
        {empty ? (
          <div className="h-full grid place-items-center px-8">
            <div className="max-w-md text-center space-y-4">
              <p className="text-sm text-on-surface-variant">
                The canvas auto-renders when Claude proposes architecture.
                Casual chat, questions, and read-only inspections leave it
                empty by design.
              </p>
              <div className="space-y-1.5">
                <p className="text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant">
                  Try one of these
                </p>
                <div className="flex flex-col gap-1.5">
                  {EXAMPLE_PROMPTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      disabled={!onExamplePrompt}
                      onClick={() => onExamplePrompt?.(p)}
                      className="text-left text-xs px-3 py-2 rounded-lg border border-outline-variant/40 bg-surface-container-lowest hover:bg-surface-container-high transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={graph!.nodes}
            edges={graph!.edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            colorMode="light"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={32}
              size={1}
              color="#c1c6d7"
            />
            <Controls
              showInteractive={false}
              className="!bg-surface-container-lowest !border !border-outline-variant/40 !rounded-lg !shadow-sm"
            />
            <MiniMap
              pannable
              zoomable
              className="!bg-surface-container-lowest !border !border-outline-variant/40 !rounded-lg"
              maskColor="rgba(193, 198, 215, 0.4)"
            />
          </ReactFlow>
        )}
      </div>
      <ResourceDetailModal
        open={detailOpen}
        topologyId={topologyId ?? null}
        nodeId={detailNodeId}
        onClose={() => setDetailNodeId(null)}
      />
    </section>
  );
}
