"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  BackgroundVariant,
  Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { NodeCard } from "./NodeCard";
import { NodeDrawer } from "./NodeDrawer";
import { useGraphStore } from "@/store/graphStore";
import type { NodeCardData } from "@/lib/types";
import { toPng } from "html-to-image";
import { generateHTMLExport } from "@/lib/exportHTML";
import { Button } from "@/components/ui/button";
import { Download, FileJson, Globe, Expand, Eye, EyeOff } from "lucide-react";

// ─── Custom Animated Edge ────────────────────────────────────

function AnimatedEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  style = {},
  markerEnd,
  label,
  data,
  showLabel = true,
  labelOffset = 0,
}: any) {
  const edgeColor = style.stroke || "#6366f1";
  const edgeWidth = style.strokeWidth || 1.5;

  // Calculate edge path with slight curve
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const edgeLength = Math.sqrt(dx * dx + dy * dy);
  const curvature = 0.2;
  const controlX = midX - dy * curvature;
  const controlY = midY + dx * curvature;

  const edgePath = `M ${sourceX} ${sourceY} Q ${controlX} ${controlY} ${targetX} ${targetY}`;

  // Determine label text: prefer data.label, then label prop
  const labelText = data?.label || label;

  // Compute label position with anti-collision offset.
  // Offset is along the edge's perpendicular direction so labels
  // stack vertically relative to the edge, not in world coords.
  // The perpendicular unit vector is (-dy, dx) / edgeLength.
  const perpX = edgeLength > 0 ? -dy / edgeLength : 0;
  const perpY = edgeLength > 0 ? dx / edgeLength : -1;
  const labelX = midX + perpX * labelOffset;
  const labelY = midY + perpY * labelOffset - 8; // -8 for baseline above edge

  return (
    <>
      {/* Background path (shadow) */}
      <path
        d={edgePath}
        fill="none"
        stroke={edgeColor}
        strokeWidth={edgeWidth + 2}
        strokeOpacity={0.15}
      />
      {/* Animated dashed path */}
      <path
        d={edgePath}
        fill="none"
        stroke={edgeColor}
        strokeWidth={edgeWidth}
        strokeDasharray="6 4"
        markerEnd={markerEnd}
        className="animated-edge"
      />
      {/* Edge label — with collision offset */}
      {showLabel && labelText && (
        <g style={{ pointerEvents: "none" }}>
          {/* Background pill for readability */}
          <rect
            x={labelX - (typeof labelText === "string" ? Math.min(labelText.length, 20) * 3.2 + 6 : 40)}
            y={labelY - 9}
            width={typeof labelText === "string" ? Math.min(labelText.length, 20) * 3.2 + 12 : 80}
            height={14}
            rx={4}
            fill="#0a0a1a"
            fillOpacity={0.85}
          />
          <text
            x={labelX}
            y={labelY}
            textAnchor="middle"
            className="text-[10px] fill-[#a0a0dd] font-mono"
          >
            {typeof labelText === "string" && labelText.length > 20
              ? labelText.slice(0, 18) + "\u2026"
              : labelText}
          </text>
        </g>
      )}
    </>
  );
}

// ─── Node Types Map ──────────────────────────────────────────

const nodeTypes = {
  atomicCard: NodeCard,
};

// ─── Inner Graph Canvas (uses useReactFlow inside provider) ──

function GraphCanvas() {
  const {
    flowNodes,
    flowEdges,
    selectedNodeId,
    setSelectedNodeId,
  } = useGraphStore();

  const flowRef = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useReactFlow();
  const prevNodeCountRef = useRef(0);

  // Edge label visibility — auto-hide for large graphs (>30 edges)
  const [showEdgeLabels, setShowEdgeLabels] = useState(true);

  // Auto-hide labels when graph gets large
  useEffect(() => {
    if (flowEdges.length > 30 && showEdgeLabels) {
      setShowEdgeLabels(false);
    }
    if (flowEdges.length <= 30 && !showEdgeLabels) {
      setShowEdgeLabels(true);
    }
  }, [flowEdges.length]);

  // ─── Compute label offsets to prevent overlapping ─────────────
  // Group edges by proximity of their midpoints and assign staggered
  // offsets so labels don't collide.
  const labelOffsets = useMemo(() => {
    if (!showEdgeLabels || flowEdges.length === 0) return new Map<string, number>();

    const offsets = new Map<string, number>();

    // Compute midpoints for each edge using current node positions
    const edgeMidpoints = flowEdges.map((e) => {
      const srcNode = flowNodes.find((n) => n.id === e.source);
      const tgtNode = flowNodes.find((n) => n.id === e.target);
      if (!srcNode || !tgtNode) return { id: e.id, mx: 0, my: 0 };
      return {
        id: e.id,
        mx: (srcNode.position.x + 110 + tgtNode.position.x + 110) / 2,
        my: (srcNode.position.y + 60 + tgtNode.position.y + 60) / 2,
      };
    });

    // Cluster edges whose midpoints are within 30px of each other
    const CLUSTER_RADIUS = 30;
    const LABEL_SPACING = 16; // pixels between stacked labels
    const visited = new Set<string>();

    for (let i = 0; i < edgeMidpoints.length; i++) {
      if (visited.has(edgeMidpoints[i].id)) continue;
      const cluster = [edgeMidpoints[i]];
      visited.add(edgeMidpoints[i].id);

      for (let j = i + 1; j < edgeMidpoints.length; j++) {
        if (visited.has(edgeMidpoints[j].id)) continue;
        const dx = edgeMidpoints[i].mx - edgeMidpoints[j].mx;
        const dy = edgeMidpoints[i].my - edgeMidpoints[j].my;
        if (Math.sqrt(dx * dx + dy * dy) < CLUSTER_RADIUS) {
          cluster.push(edgeMidpoints[j]);
          visited.add(edgeMidpoints[j].id);
        }
      }

      // Assign staggered offsets within the cluster
      if (cluster.length > 1) {
        cluster.forEach((item, idx) => {
          const offset = (idx - (cluster.length - 1) / 2) * LABEL_SPACING;
          offsets.set(item.id, offset);
        });
      }
    }

    return offsets;
  }, [showEdgeLabels, flowEdges, flowNodes]);

  // Create edge types with label visibility and offset
  const edgeTypes = useMemo(
    () => ({
      animatedEdge: (props: any) => (
        <AnimatedEdge
          {...props}
          showLabel={showEdgeLabels}
          labelOffset={labelOffsets.get(props.id) || 0}
        />
      ),
    }),
    [showEdgeLabels, labelOffsets]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

  // Sync store → local state when pipeline produces new results
  useMemo(() => {
    setNodes(flowNodes);
  }, [flowNodes, setNodes]);

  useMemo(() => {
    setEdges(flowEdges);
  }, [flowEdges, setEdges]);

  // Auto fitView when nodes first appear (pipeline completes) or change count
  useEffect(() => {
    if (flowNodes.length > 0 && flowNodes.length !== prevNodeCountRef.current) {
      prevNodeCountRef.current = flowNodes.length;
      // Short delay to let React Flow compute layout before fitting
      const timer = setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.2, duration: 800 });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [flowNodes.length, reactFlowInstance]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId]
  );

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  // ─── Export as PNG ─────────────────────────────────────────
  const exportPNG = useCallback(() => {
    if (!flowRef.current) return;
    toPng(flowRef.current, {
      backgroundColor: "#0a0a1a",
      quality: 0.95,
    })
      .then((dataUrl) => {
        const link = document.createElement("a");
        link.download = "atomic-graph.png";
        link.href = dataUrl;
        link.click();
      })
      .catch(console.error);
  }, []);

  // ─── Export as JSON ────────────────────────────────────────
  const exportJSON = useCallback(() => {
    try {
      const data = {
        nodes: flowNodes.map((n) => ({
          id: n.id,
          ...n.data.node,
        })),
        edges: flowEdges.map((e) => ({
          source: e.source,
          target: e.target,
          label: e.data?.label || e.label,
          strength: e.data?.strength,
        })),
        exportedAt: new Date().toISOString(),
      };

      // Use streaming JSON serialization for large graphs to avoid
      // memory issues with JSON.stringify on very large datasets.
      // For most graphs, JSON.stringify is fine, but we add a safety
      // check and chunked fallback for extremely large datasets.
      const estimatedSize = flowNodes.length * 500 + flowEdges.length * 200;
      const useCompactFormat = estimatedSize > 2_000_000; // >2MB estimated

      const jsonString = useCompactFormat
        ? JSON.stringify(data) // Compact: no indentation, smaller file
        : JSON.stringify(data, null, 2); // Pretty-printed for normal sizes

      const blob = new Blob([jsonString], {
        type: "application/json",
      });

      // For very large blobs, use the streaming download approach
      // to avoid memory issues with URL.createObjectURL
      if (blob.size > 50_000_000) {
        // >50MB: use streaming via ReadableStream
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(jsonString));
            controller.close();
          },
        });
        const response = new Response(stream);
        response.blob().then((largeBlob) => {
          const url = URL.createObjectURL(largeBlob);
          const link = document.createElement("a");
          link.download = "atomic-graph.json";
          link.href = url;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        });
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.download = "atomic-graph.json";
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error("[JSON Export] Failed:", error);
      // Fallback: try compact format without pretty-printing
      try {
        const data = {
          nodes: flowNodes.map((n) => ({ id: n.id, ...n.data.node })),
          edges: flowEdges.map((e) => ({
            source: e.source,
            target: e.target,
            label: e.data?.label || e.label,
            strength: e.data?.strength,
          })),
          exportedAt: new Date().toISOString(),
        };
        const jsonString = JSON.stringify(data);
        const blob = new Blob([jsonString], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.download = "atomic-graph.json";
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
      } catch (fallbackError) {
        console.error("[JSON Export] Fallback also failed:", fallbackError);
        alert("Failed to export JSON. The graph may be too large for browser memory.");
      }
    }
  }, [flowNodes, flowEdges]);

  // ─── Export as self-contained HTML ─────────────────────────
  const exportHTML = useCallback(() => {
    const html = generateHTMLExport(flowNodes, flowEdges);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = "atomic-graph.html";
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  }, [flowNodes, flowEdges]);

  // ─── Fit view options ─────────────────────────────────────
  const fitViewOptions = { padding: 0.2, duration: 800 };

  // ─── Graph size info ──────────────────────────────────────
  const nodeCount = flowNodes.length;
  const edgeCount = flowEdges.length;
  const isLargeGraph = nodeCount > 20 || edgeCount > 30;

  if (nodeCount === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0a0a1a]">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-[#12122a] border border-[#2a2a5a] flex items-center justify-center">
            <Expand className="w-8 h-8 text-[#4a4a8a]" />
          </div>
          <p className="text-[#6666aa] font-mono text-sm">
            Paste notes and click Generate to build your knowledge graph
          </p>
          <p className="text-[#4444aa] font-mono text-xs max-w-xs mx-auto">
            The AI will reason through the semantic space of your ideas,
            surfacing implicit structure your brain knows but didn&apos;t articulate.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full" ref={flowRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        style={{ background: "#0a0a1a" }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#2a2a5a"
        />
        <Controls
          className="!bg-[#1a1a3e] !border-[#3a3a6a] [&>button]:!bg-[#1a1a3e] [&>button]:!border-[#3a3a6a] [&>button]:!text-[#c8c8ee] [&>button:hover]:!bg-[#2a2a5a]"
        />
        <MiniMap
          nodeColor={(node) => {
            const data = node.data as NodeCardData;
            return data?.color || "#6366f1";
          }}
          maskColor="rgba(10, 10, 26, 0.85)"
          style={{
            background: "#12122a",
            border: "1px solid #2a2a5a",
            borderRadius: "8px",
          }}
          className="!bottom-4 !right-4"
        />

        {/* Graph Stats — bottom left */}
        <Panel position="bottom-left" className="flex items-center gap-2">
          <div className="flex items-center gap-3 px-2.5 py-1.5 rounded-lg bg-[#1a1a3e]/80 border border-[#2a2a5a] backdrop-blur-sm">
            <span className="text-[#8888cc] font-mono text-[10px]">
              {nodeCount} nodes
            </span>
            <span className="text-[#3a3a6a]">·</span>
            <span className="text-[#8888cc] font-mono text-[10px]">
              {edgeCount} edges
            </span>
            {isLargeGraph && (
              <>
                <span className="text-[#3a3a6a]">·</span>
                <span className="text-amber-400/70 font-mono text-[10px]">
                  large graph
                </span>
              </>
            )}
          </div>
        </Panel>

        {/* Export & Controls Panel — top right */}
        <Panel position="top-right" className="flex gap-1.5">
          {/* Edge labels toggle — only show for graphs with edges */}
          {edgeCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowEdgeLabels(!showEdgeLabels)}
              className="bg-[#1a1a3e] border-[#3a3a6a] text-[#c8c8ee] hover:bg-[#2a2a5a] hover:text-white font-mono text-xs h-7"
              title={showEdgeLabels ? "Hide edge labels" : "Show edge labels"}
            >
              {showEdgeLabels ? (
                <Eye className="w-3 h-3 mr-1" />
              ) : (
                <EyeOff className="w-3 h-3 mr-1" />
              )}
              Labels
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={exportHTML}
            className="bg-[#1a1a3e] border-[#3a3a6a] text-[#c8c8ee] hover:bg-[#2a2a5a] hover:text-white font-mono text-xs h-7"
          >
            <Globe className="w-3 h-3 mr-1" />
            HTML
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportPNG}
            className="bg-[#1a1a3e] border-[#3a3a6a] text-[#c8c8ee] hover:bg-[#2a2a5a] hover:text-white font-mono text-xs h-7"
          >
            <Download className="w-3 h-3 mr-1" />
            PNG
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportJSON}
            className="bg-[#1a1a3e] border-[#3a3a6a] text-[#c8c8ee] hover:bg-[#2a2a5a] hover:text-white font-mono text-xs h-7"
          >
            <FileJson className="w-3 h-3 mr-1" />
            JSON
          </Button>
        </Panel>
      </ReactFlow>

      {/* Node Drawer — slides in from right */}
      {selectedNodeId && <NodeDrawer />}
    </div>
  );
}

// ─── GraphView — wraps canvas in ReactFlowProvider ───────────

export function GraphView() {
  return (
    <ReactFlowProvider>
      <GraphCanvas />
    </ReactFlowProvider>
  );
}
