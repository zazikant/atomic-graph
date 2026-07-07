import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";
import type { AtomicNode, GraphEdge, NodeCardData, CLUSTER_COLORS } from "./types";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 130;

/**
 * Auto-position nodes using Dagre's layered graph layout algorithm.
 * Produces a clean, hierarchical arrangement suitable for knowledge graphs.
 * Adapts spacing based on graph size for better readability with many nodes.
 */
export function applyDagreLayout(
  nodes: Node<NodeCardData>[],
  edges: Edge[]
): Node<NodeCardData>[] {
  const nodeCount = nodes.length;

  // Adaptive spacing: wider gaps for larger graphs
  const nodesep = nodeCount > 30 ? 100 : nodeCount > 15 ? 90 : 80;
  const ranksep = nodeCount > 30 ? 150 : nodeCount > 15 ? 130 : 120;

  const g = new dagre.graphlib.Graph();

  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep,
    ranksep,
    marginx: 80,
    marginy: 80,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });
}

/**
 * Convert domain AtomicNodes + GraphEdges into React Flow Node[] + Edge[].
 * Auto-assigns cluster colours based on tag similarity.
 */
export function buildFlowGraph(
  atomicNodes: AtomicNode[],
  graphEdges: GraphEdge[],
  clusterColors: typeof CLUSTER_COLORS,
  onSelectNode: (id: string) => void
): { nodes: Node<NodeCardData>[]; edges: Edge[] } {
  // ─── Cluster assignment by tag similarity ──────────────────
  const tagToCluster = new Map<string, number>();
  let clusterCounter = 0;

  for (const node of atomicNodes) {
    const tags = node.tags || [];
    let assignedCluster: number | undefined;

    // Check if any tag already has a cluster
    for (const tag of tags) {
      if (tagToCluster.has(tag)) {
        assignedCluster = tagToCluster.get(tag);
        break;
      }
    }

    // Assign new cluster if none found
    if (assignedCluster === undefined) {
      assignedCluster = clusterCounter % clusterColors.length;
      clusterCounter++;
    }

    // Map all tags of this node to the same cluster
    for (const tag of tags) {
      if (!tagToCluster.has(tag)) {
        tagToCluster.set(tag, assignedCluster);
      }
    }

    node.cluster = assignedCluster;
  }

  // ─── Build React Flow nodes ───────────────────────────────
  const nodes: Node<NodeCardData>[] = atomicNodes.map((node) => ({
    id: node.id,
    type: "atomicCard",
    position: { x: 0, y: 0 }, // Will be overridden by dagre
    data: {
      node,
      color: clusterColors[node.cluster ?? 0] || clusterColors[0],
      isSelected: false,
      onSelect: onSelectNode,
    },
  }));

  // ─── Build React Flow edges ───────────────────────────────
  const edges: Edge[] = graphEdges.map((edge, i) => {
    const strength = edge.strength ?? 0.5;
    let edgeColor: string;
    let edgeWidth: number;

    if (strength >= 0.7) {
      edgeColor = "#a78bfa"; // purple — strong
      edgeWidth = 2.5;
    } else if (strength >= 0.4) {
      edgeColor = "#6366f1"; // blue — medium
      edgeWidth = 1.8;
    } else {
      edgeColor = "#6b7280"; // gray — weak
      edgeWidth = 1.2;
    }

    return {
      id: `e-${edge.source}-${edge.target}-${i}`,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: "animatedEdge",
      style: {
        stroke: edgeColor,
        strokeWidth: edgeWidth,
      },
      animated: true,
      markerEnd: {
        type: "arrowclosed" as const,
        color: edgeColor,
        width: 20,
        height: 20,
      },
      data: { strength, label: edge.label },
    };
  });

  return { nodes, edges };
}
