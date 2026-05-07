// Auto-layout helper. Takes raw nodes/edges and writes positions on
// each node so React Flow can render. We use dagre because it's the
// fastest path to a readable graph; ELK is the upgrade once we hit
// dagre's limits.

import dagre from "@dagrejs/dagre";
import { Position, type Edge, type Node } from "@xyflow/react";

const NODE_W = 200;
const NODE_H = 84;

export function layoutNodes(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR"
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 80 });

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const sourcePos = direction === "LR" ? Position.Right : Position.Bottom;
  const targetPos = direction === "LR" ? Position.Left : Position.Top;

  return nodes.map((n): Node => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      width: NODE_W,
      height: NODE_H,
      sourcePosition: sourcePos,
      targetPosition: targetPos,
    };
  });
}
