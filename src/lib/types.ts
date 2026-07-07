// ─── Core Domain Types ───────────────────────────────────────

export interface AtomicNode {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  /** Full content revealed on node click */
  content?: string;
  /** Cluster colour auto-assigned by tag similarity */
  cluster?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  label: string;
  strength: number; // 0.0 – 1.0
}

// ─── Pipeline Types ──────────────────────────────────────────

export interface ExtractResult {
  nodes: AtomicNode[];
}

export interface LinkResult {
  nodes: AtomicNode[];
  edges: GraphEdge[];
}

export interface ValidationResult {
  score: number; // 0.0 – 1.0
  issues: string[];
  suggestions: string[];
}

export interface PipelineResult {
  result: LinkResult | null;
  score: number;
  attempts: number;
  iterations: IterationLog[];
}

export interface IterationLog {
  iteration: number;
  phase: "extracting" | "linking" | "validating" | "refining" | "complete";
  score: number;
  passed: boolean;
  issues?: string[];
  timestamp: number;
}

// ─── Config Types ────────────────────────────────────────────

export interface AppConfig {
  apiKey: string;
  model: NvidiaModel;
  iterations: number;
  confidenceThreshold: number;
}

export type NvidiaModel =
  | "meta/llama-3.1-405b-instruct"
  | "nvidia/llama-3.3-nemotron-super-49b-v1"
  | "meta/llama-3.1-70b-instruct"
  | "nvidia/llama-3.1-nemotron-70b-instruct";

export const NVIDIA_MODELS: { value: NvidiaModel; label: string }[] = [
  { value: "meta/llama-3.1-405b-instruct", label: "Llama 3.1 405B Instruct" },
  { value: "nvidia/llama-3.3-nemotron-super-49b-v1", label: "Nemotron Super 49B" },
  { value: "meta/llama-3.1-70b-instruct", label: "Llama 3.1 70B Instruct" },
  { value: "nvidia/llama-3.1-nemotron-70b-instruct", label: "Nemotron 70B Instruct" },
];

// ─── Cluster Colour Palette ──────────────────────────────────

export const CLUSTER_COLORS: string[] = [
  "#6366f1", // indigo
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#f97316", // orange
  "#ec4899", // pink
];

// ─── React Flow Custom Data ──────────────────────────────────

export interface NodeCardData {
  node: AtomicNode;
  color: string;
  isSelected: boolean;
  onSelect: (id: string) => void;
}
