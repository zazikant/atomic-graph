"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
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
import { Download, FileJson, Globe, Expand } from "lucide-react";

// ─── Custom Animated Edge ────────────────────────────────────

function AnimatedEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  style = {},
  markerEnd,
  label,
}: any) {
  const edgeColor = style.stroke || "#6366f1";
  const edgeWidth = style.strokeWidth || 1.5;

  // Calculate edge path with slight curve
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const curvature = 0.2;
  const controlX = midX - dy * curvature;
  const controlY = midY + dx * curvature;

  const edgePath = `M ${sourceX} ${sourceY} Q ${controlX} ${controlY} ${targetX} ${targetY}`;

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
      {/* Edge label */}
      {label && (
        <text
          x={midX}
          y={midY - 8}
          textAnchor="middle"
          className="text-[10px] fill-[#8888cc] font-mono"
          style={{ pointerEvents: "none" }}
        >
          {typeof label === "string" && label.length > 20
            ? label.slice(0, 18) + "…"
            : label}
        </text>
      )}
    </>
  );
}

// ─── Node Types Map ──────────────────────────────────────────

const nodeTypes = {
  atomicCard: NodeCard,
};

const edgeTypes = {
  animatedEdge: AnimatedEdge,
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
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = "atomic-graph.json";
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
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

  if (flowNodes.length === 0) {
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
        minZoom={0.1}
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

        {/* Export Panel */}
        <Panel position="top-right" className="flex gap-1.5">
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
