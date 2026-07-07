import { create } from "zustand";
import type {
  AtomicNode,
  GraphEdge,
  IterationLog,
  NvidiaModel,
  AppConfig,
} from "@/lib/types";
import type { Node, Edge } from "@xyflow/react";
import type { NodeCardData } from "@/lib/types";

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
}

// ─── Persist API key to localStorage ────────────────────────

function loadStoredConfig(): AppConfig {
  if (typeof window === "undefined") {
    return {
      apiKey: "",
      model: "meta/llama-3.1-405b-instruct",
      iterations: 3,
      confidenceThreshold: 0.75,
    };
  }
  try {
    const stored = localStorage.getItem("atomic-graph-config");
    if (stored) {
      return { ...JSON.parse(stored) };
    }
  } catch {
    // ignore
  }
  return {
    apiKey: "",
    model: "meta/llama-3.1-405b-instruct",
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
    }),
}));
