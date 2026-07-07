import { create } from "zustand";
import type {
  AtomicNode,
  GraphEdge,
  IterationLog,
  NvidiaModel,
  AppConfig,
} from "@/lib/types";
import { CLUSTER_COLORS } from "@/lib/types";
import { buildFlowGraph, applyDagreLayout } from "@/lib/graphLayout";
import type { Node, Edge } from "@xyflow/react";
import type { NodeCardData } from "@/lib/types";

// No hardcoded API key — the server uses process.env.NVIDIA_API_KEY.
// Users can optionally provide their own key via the UI as an override.
const DEFAULT_API_KEY = "";

// ─── Live SSE event (from /api/nvidia-stream) ─────────────────
export type LiveEvent = {
  ts: number;
  type: string;            // stage-start | log | chunk | stage-end | error
  line?: string;           // for log
  text?: string;           // for chunk
  stage?: string;          // for stage-start/stage-end
  ok?: boolean;            // for stage-end
  elapsedMs?: number;      // for stage-end
  attempts?: number;       // for stage-end
  content?: string;        // for stage-end (final content safety net)
  message?: string;        // for error
};

// ─── Store Interface ─────────────────────────────────────────

interface GraphStore {
  // Config
  config: AppConfig;
  setConfig: (partial: Partial<AppConfig>) => void;

  // Notes input
  rawNotes: string;
  setRawNotes: (notes: string) => void;

  // Pipeline state
  isRunning: boolean;
  iterationLogs: IterationLog[];
  pipelineError: string | null;
  pipelineScore: number;
  pipelineAttempts: number;

  // Live streaming state (SSE from /api/nvidia-stream)
  liveEvents: LiveEvent[];
  liveText: string;
  showLiveLog: boolean;
  addLiveEvent: (ev: LiveEvent) => void;
  appendLiveText: (text: string) => void;
  clearLiveState: () => void;
  setShowLiveLog: (show: boolean) => void;

  // Graph data
  flowNodes: Node<NodeCardData>[];
  flowEdges: Edge[];
  selectedNodeId: string | null;

  // Actions
  setIterationLogs: (logs: IterationLog[]) => void;
  addIterationLog: (log: IterationLog) => void;
  setIsRunning: (running: boolean) => void;
  setPipelineError: (error: string | null) => void;
  setPipelineResult: (nodes: Node<NodeCardData>[], edges: Edge[], score: number, attempts: number) => void;
  setSelectedNodeId: (id: string | null) => void;
  updateNodePositions: (nodes: Node<NodeCardData>[]) => void;
  resetPipeline: () => void;
  importGraphFromJSON: (json: string) => { success: boolean; error?: string };
}

// ─── Persist API key to localStorage ────────────────────────

function loadStoredConfig(): AppConfig {
  if (typeof window === "undefined") {
    return {
      apiKey: DEFAULT_API_KEY,
      model: "openai/gpt-oss-120b",
      iterations: 3,
      confidenceThreshold: 0.75,
    };
  }
  try {
    const stored = localStorage.getItem("atomic-graph-config");
    if (stored) {
      const parsed = JSON.parse(stored);
      // Always ensure model is the current default
      return { ...parsed, model: "openai/gpt-oss-120b" };
    }
  } catch {
    // ignore
  }
  return {
    apiKey: DEFAULT_API_KEY,
    model: "openai/gpt-oss-120b",
    iterations: 3,
    confidenceThreshold: 0.75,
  };
}

function saveConfig(config: AppConfig) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("atomic-graph-config", JSON.stringify(config));
  } catch {
    // ignore
  }
}

// ─── Store ───────────────────────────────────────────────────

export const useGraphStore = create<GraphStore>((set, get) => ({
  // Config
  config: loadStoredConfig(),
  setConfig: (partial) => {
    const newConfig = { ...get().config, ...partial };
    saveConfig(newConfig);
    set({ config: newConfig });
  },

  // Notes
  rawNotes: "",
  setRawNotes: (notes) => set({ rawNotes: notes }),

  // Pipeline
  isRunning: false,
  iterationLogs: [],
  pipelineError: null,
  pipelineScore: 0,
  pipelineAttempts: 0,

  // Live streaming state
  liveEvents: [],
  liveText: "",
  showLiveLog: true,
  addLiveEvent: (ev) => set((state) => ({ liveEvents: [...state.liveEvents, ev] })),
  appendLiveText: (text) => set((state) => ({ liveText: state.liveText + text })),
  clearLiveState: () => set({ liveEvents: [], liveText: "" }),
  setShowLiveLog: (show) => set({ showLiveLog: show }),

  // Graph
  flowNodes: [],
  flowEdges: [],
  selectedNodeId: null,

  // Actions
  setIterationLogs: (logs) => set({ iterationLogs: logs }),
  addIterationLog: (log) =>
    set((state) => ({ iterationLogs: [...state.iterationLogs, log] })),

  setIsRunning: (running) => set({ isRunning: running }),
  setPipelineError: (error) => set({ pipelineError: error }),

  setPipelineResult: (nodes, edges, score, attempts) =>
    set({
      flowNodes: nodes,
      flowEdges: edges,
      pipelineScore: score,
      pipelineAttempts: attempts,
      isRunning: false,
    }),

  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  updateNodePositions: (nodes) => set({ flowNodes: nodes }),

  resetPipeline: () =>
    set({
      isRunning: false,
      iterationLogs: [],
      pipelineError: null,
      pipelineScore: 0,
      pipelineAttempts: 0,
      flowNodes: [],
      flowEdges: [],
      selectedNodeId: null,
      liveEvents: [],
      liveText: "",
    }),

  importGraphFromJSON: (json: string) => {
    try {
      const data = JSON.parse(json);

      // Validate structure
      if (!data.nodes || !Array.isArray(data.nodes) || data.nodes.length === 0) {
        return { success: false, error: "JSON must contain a non-empty 'nodes' array." };
      }
      if (!data.edges || !Array.isArray(data.edges)) {
        return { success: false, error: "JSON must contain an 'edges' array." };
      }

      // Map to AtomicNode[] — accept both exported format and minimal format
      const atomicNodes: AtomicNode[] = data.nodes.map((n: any, i: number) => ({
        id: n.id || `n${i}`,
        title: n.title || `Node ${i + 1}`,
        summary: n.summary || "",
        tags: Array.isArray(n.tags) ? n.tags : [],
        content: n.content || n.summary || "",
        cluster: n.cluster,
      }));

      // Map to GraphEdge[] — accept both exported format and minimal format
      const graphEdges: GraphEdge[] = data.edges
        .map((e: any, i: number) => ({
          source: e.source,
          target: e.target,
          label: e.label || e.data?.label || "",
          strength: e.strength ?? e.data?.strength ?? 0.5,
        }))
        .filter((e: GraphEdge) => e.source && e.target);

      // Validate that edge references exist
      const nodeIds = new Set(atomicNodes.map((n) => n.id));
      const validEdges = graphEdges.filter(
        (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
      );

      if (validEdges.length === 0 && graphEdges.length > 0) {
        return { success: false, error: "Edge source/target IDs don't match any node IDs." };
      }

      // Build the flow graph using the same pipeline as AI generation
      const { nodes, edges } = buildFlowGraph(
        atomicNodes,
        validEdges,
        CLUSTER_COLORS,
        (id) => get().setSelectedNodeId(id)
      );

      const laidOutNodes = applyDagreLayout(nodes, edges);

      set({
        flowNodes: laidOutNodes,
        flowEdges: edges,
        pipelineScore: 1.0,
        pipelineAttempts: 1,
        isRunning: false,
        pipelineError: null,
        selectedNodeId: null,
        iterationLogs: [
          {
            iteration: 1,
            phase: "complete",
            score: 1.0,
            passed: true,
            detail: "Imported from JSON",
            timestamp: Date.now(),
          },
        ],
      });

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid JSON format";
      return { success: false, error: `Parse error: ${message}` };
    }
  },
}));
