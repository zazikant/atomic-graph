import { NvidiaClient } from "./nvidiaClient";
import type {
  AtomicNode,
  ExtractResult,
  LinkResult,
  ValidationResult,
  PipelineResult,
  IterationLog,
  NvidiaModel,
} from "./types";

// ─── System Prompt ───────────────────────────────────────────

const SYSTEM_PROMPT = `You are a knowledge graph engine. Always respond with valid JSON only.
No markdown, no explanation, no code fences, only the JSON object.
Every response must be a single valid JSON object that can be parsed by JSON.parse().`;

// ─── AX Pipeline ─────────────────────────────────────────────

export class AXPipeline {
  private client: NvidiaClient;
  private onIteration: (log: IterationLog) => void;

  constructor(
    apiKey: string,
    model: NvidiaModel,
    onIteration: (log: IterationLog) => void
  ) {
    this.client = new NvidiaClient(apiKey, model);
    this.onIteration = onIteration;
  }

  private emit(phase: IterationLog["phase"], iteration: number, score: number, passed: boolean, issues?: string[]) {
    this.onIteration({
      iteration,
      phase,
      score,
      passed,
      issues,
      timestamp: Date.now(),
    });
  }

  // ─── Step 1: EXTRACT ─────────────────────────────────────

  private async extract(rawNotes: string, previousResult: LinkResult | null): Promise<ExtractResult> {
    const prompt = previousResult
      ? `Given these raw notes, extract atomic concepts. Improve upon the previous extraction if available.
Each concept = one idea only. Keep each concept focused and atomic.
Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }] }

Previous extraction had these issues that need fixing:
${JSON.stringify(previousResult.nodes.slice(0, 20), null, 2)}

Raw notes: ${rawNotes}`
      : `Given these raw notes, extract atomic concepts.
Each concept = one idea only. Keep each concept focused and atomic.
Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }] }

Raw notes: ${rawNotes}`;

    const result = await this.client.chatJSON<ExtractResult>(prompt, SYSTEM_PROMPT);

    // Ensure every node has required fields
    if (!result.nodes || !Array.isArray(result.nodes)) {
      throw new Error("Extract step returned invalid nodes array");
    }

    result.nodes = result.nodes.map((node, i) => ({
      id: node.id || `c${i + 1}`,
      title: node.title || `Concept ${i + 1}`,
      summary: node.summary || "",
      tags: Array.isArray(node.tags) ? node.tags : [],
      content: node.content || node.summary || "",
    }));

    return result;
  }

  // ─── Step 2: LINK ────────────────────────────────────────

  private async link(extracted: ExtractResult): Promise<LinkResult> {
    const prompt = `Given these atomic nodes, identify semantic relationships between them.
Each edge should represent a meaningful conceptual link.
Return JSON: {
  "nodes": [<same nodes as input>],
  "edges": [{ "source": "nodeId", "target": "nodeId", "label": "relationship", "strength": 0.8 }]
}

Nodes: ${JSON.stringify(extracted.nodes, null, 2)}`;

    const result = await this.client.chatJSON<LinkResult>(prompt, SYSTEM_PROMPT);

    // Validate edges reference existing nodes
    const nodeIds = new Set(extracted.nodes.map((n) => n.id));
    const validEdges = (result.edges || [])
      .filter(
        (e) =>
          e.source &&
          e.target &&
          nodeIds.has(e.source) &&
          nodeIds.has(e.target) &&
          e.source !== e.target
      )
      .map((e) => ({
        source: e.source,
        target: e.target,
        label: e.label || "related to",
        strength: typeof e.strength === "number" ? Math.min(1, Math.max(0, e.strength)) : 0.5,
      }));

    return {
      nodes: extracted.nodes,
      edges: validEdges,
    };
  }

  // ─── Step 3: VALIDATE ────────────────────────────────────

  private async validate(graph: LinkResult): Promise<ValidationResult> {
    const prompt = `Rate this knowledge graph for semantic accuracy and completeness.
Consider: Are concepts truly atomic? Are links meaningful? Is the graph well-connected?
Return JSON: {
  "score": 0.85,
  "issues": ["issue1", "issue2"],
  "suggestions": ["suggestion1"]
}
Score must be between 0.0 and 1.0.

Graph: ${JSON.stringify(graph, null, 2)}`;

    const result = await this.client.chatJSON<ValidationResult>(prompt, SYSTEM_PROMPT);

    return {
      score: typeof result.score === "number" ? Math.min(1, Math.max(0, result.score)) : 0,
      issues: Array.isArray(result.issues) ? result.issues : [],
      suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    };
  }

  // ─── Step 4: REFINE ──────────────────────────────────────

  private async refine(graph: LinkResult, issues: string[]): Promise<LinkResult> {
    const prompt = `Improve this knowledge graph based on these issues. Fix the problems while keeping valid content.
Return the corrected full graph JSON with both nodes and edges.

Issues to fix:
${issues.map((i) => `- ${i}`).join("\n")}

Current graph: ${JSON.stringify(graph, null, 2)}`;

    const result = await this.client.chatJSON<LinkResult>(prompt, SYSTEM_PROMPT);

    // Validate and normalise the refined result
    const nodeIds = new Set((result.nodes || []).map((n) => n.id));
    const validEdges = (result.edges || [])
      .filter(
        (e) =>
          e.source &&
          e.target &&
          nodeIds.has(e.source) &&
          nodeIds.has(e.target) &&
          e.source !== e.target
      )
      .map((e) => ({
        source: e.source,
        target: e.target,
        label: e.label || "related to",
        strength: typeof e.strength === "number" ? Math.min(1, Math.max(0, e.strength)) : 0.5,
      }));

    const nodes = (result.nodes || graph.nodes).map((node, i) => ({
      id: node.id || graph.nodes[i]?.id || `c${i + 1}`,
      title: node.title || graph.nodes[i]?.title || `Concept ${i + 1}`,
      summary: node.summary || graph.nodes[i]?.summary || "",
      tags: Array.isArray(node.tags) ? node.tags : graph.nodes[i]?.tags || [],
      content: node.content || node.summary || graph.nodes[i]?.content || "",
    }));

    return { nodes, edges: validEdges.length > 0 ? validEdges : graph.edges };
  }

  // ─── Main Pipeline Runner ────────────────────────────────

  async run(
    rawNotes: string,
    iterations: number,
    threshold: number
  ): Promise<PipelineResult> {
    let result: LinkResult | null = null;
    let score = 0;
    let attempt = 0;
    const iterLogs: IterationLog[] = [];

    while (attempt < iterations && score < threshold) {
      attempt++;

      // Step 1: EXTRACT
      this.emit("extracting", attempt, 0, false);
      const extracted = await this.extract(rawNotes, result);

      // Step 2: LINK
      this.emit("linking", attempt, 0, false);
      const linked = await this.link(extracted);

      // Step 3: VALIDATE
      this.emit("validating", attempt, 0, false);
      const validation = await this.validate(linked);
      score = validation.score;

      const passed = score >= threshold;
      this.emit("validating", attempt, score, passed, validation.issues);

      iterLogs.push({
        iteration: attempt,
        phase: passed ? "complete" : "validating",
        score,
        passed,
        issues: validation.issues,
        timestamp: Date.now(),
      });

      // Step 4: REFINE if score below threshold
      if (score < threshold && attempt < iterations) {
        this.emit("refining", attempt, score, false);
        result = await this.refine(linked, validation.issues);
      } else {
        result = linked;
      }
    }

    // Mark final iteration as complete
    this.emit("complete", attempt, score, score >= threshold);

    return {
      result,
      score,
      attempts: attempt,
      iterations: iterLogs,
    };
  }
}
