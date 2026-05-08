// Parse Claude's <topology>{...}</topology> JSON marker into a typed
// graph. Returns null if no marker is present, or if the JSON is
// malformed (we silently fall back rather than blow up the chat).

import type { AzureNodeStatus, CloudResourceKind } from "./azure-icons";

export type TopologyNode = {
  id: string;
  label: string;
  // Multi-cloud: this used to be AzureResourceKind. Now it's the
  // broader union so AWS designs render too.
  kind: CloudResourceKind;
  sublabel?: string;
  status: AzureNodeStatus;
};

export type TopologyEdge = {
  id: string;
  source: string;
  target: string;
};

export type Topology = {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
};

const RE = /<topology>\s*([\s\S]*?)\s*<\/topology>/i;

export function parseTopology(text: string): Topology | null {
  const m = text.match(RE);
  if (!m || !m[1]) return null;
  try {
    const raw = JSON.parse(m[1]) as Partial<Topology>;
    if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges))
      return null;
    return {
      nodes: raw.nodes.filter(
        (n): n is TopologyNode =>
          !!n && typeof n.id === "string" && typeof n.label === "string"
      ),
      edges: raw.edges.filter(
        (e): e is TopologyEdge =>
          !!e &&
          typeof e.id === "string" &&
          typeof e.source === "string" &&
          typeof e.target === "string"
      ),
    };
  } catch {
    return null;
  }
}

/** True if the assistant text contains an open `<topology>` tag without
 *  a matching close — i.e. the marker is mid-stream and we should hide
 *  the partial JSON from the rendered text. */
export function topologyPending(text: string): boolean {
  const open = text.lastIndexOf("<topology>");
  if (open === -1) return false;
  const close = text.indexOf("</topology>", open);
  return close === -1;
}

export function stripTopology(text: string): string {
  // Remove closed markers entirely.
  let out = text.replace(RE, "").trimEnd();
  // Remove an unclosed opening tag (mid-stream).
  const open = out.lastIndexOf("<topology>");
  if (open !== -1) out = out.slice(0, open).trimEnd();
  return out;
}
