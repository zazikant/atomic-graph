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

const SYSTEM_PROMPT = `You are a semantic reasoning engine that builds knowledge graphs from raw thinking.
You do NOT merely reformat or summarise — you REASON through the semantic space of ideas.
You surface implicit structure the writer already knows but didn't articulate.
You infer missing concepts, bridge gaps, and make hidden relationships explicit.
Always respond with valid JSON only. No markdown, no explanation, no code fences.
Every response must be a single valid JSON object parseable by JSON.parse().`;

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

  private emit(
    phase: IterationLog["phase"],
    iteration: number,
    score: number,
    passed: boolean,
    issues?: string[]
  ) {
    this.onIteration({
      iteration,
      phase,
      score,
      passed,
      issues,
      timestamp: Date.now(),
    });
  }

  // ─── Step 1: EXTRACT — reason through semantic space ──────

  private async extract(
    rawNotes: string,
    previousResult: LinkResult | null
  ): Promise<ExtractResult> {
    const firstPassPrompt = `You are reasoning through the semantic space of someone's raw thinking.

STEP 1 — What are the atomic concepts?
Break the notes into indivisible ideas — each concept must be ONE idea only.
Do NOT merely list keywords from the text. Instead:
- Identify every explicit concept the writer names
- Infer implicit concepts the writer assumes but doesn't name (e.g. if they mention "RAG needs embeddings", the concept "vector similarity search" is implicit)
- Surface the "glue" concepts that connect ideas but are left unsaid
- Each concept gets a concise title and a 1-2 sentence summary explaining WHY it matters in this context

Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }] }

Raw notes:
${rawNotes}`;

    const refinementPrompt = `You previously extracted atomic concepts, but the validation found gaps.
Reason deeper into the semantic space:

PREVIOUS CONCEPTS:
${JSON.stringify(previousResult?.nodes?.slice(0, 30), null, 2)}

ORIGINAL NOTES:
${rawNotes}

IMPROVE by:
1. Are there concepts the writer implied but didn't name? Add them.
2. Are there "bridge" concepts that connect two existing ideas but are missing? Add them.
3. Are any concepts too broad? Split them into truly atomic units.
4. Are any summaries shallow? Deepen them to explain WHY the concept matters.
5. Keep all existing valid concepts — only ADD or SPLIT, never remove.

Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }] }`;

    const prompt = previousResult ? refinementPrompt : firstPassPrompt;

    const result = await this.client.chatJSON<ExtractResult>(prompt, SYSTEM_PROMPT);

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

  // ─── Step 2: LINK — surface hidden relationships ──────────

  private async link(extracted: ExtractResult): Promise<LinkResult> {
    const prompt = `You are mapping the RELATIONSHIPS between atomic concepts — both explicit and implicit.

Given these atomic nodes, identify semantic relationships. Do NOT stop at surface-level "related to" links.
Instead, reason through:
- DIRECT relationships: A enables B, A requires B, A is a subtype of B
- IMPLICIT relationships: A and B are connected through C (but C wasn't stated)
- CAUSAL chains: A leads to B which enables C
- MISSING bridges: if two concepts seem disconnected, what implicit concept links them?

Edge labels must be SPECIFIC verbs/phrases: "requires", "enables", "feeds into", "is mediated by", "constrains", "extends", NOT generic "related to".

Strength (0.0-1.0): how certain and direct is this link?
- 0.9+: definitionally true (e.g. "RAG requires embeddings")
- 0.7-0.9: strongly implied (e.g. "embeddings enable vector search")
- 0.4-0.7: inferred bridge (e.g. "agent loop connects tools to RAG")
- 0.0-0.4: speculative but plausible

Return JSON: {
  "nodes": [<same nodes as input>],
  "edges": [{ "source": "nodeId", "target": "nodeId", "label": "specific relationship", "strength": 0.8 }]
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
        label: e.label || "relates to",
        strength:
          typeof e.strength === "number"
            ? Math.min(1, Math.max(0, e.strength))
            : 0.5,
      }));

    return {
      nodes: extracted.nodes,
      edges: validEdges,
    };
  }

  // ─── Step 3: VALIDATE — self-critique the semantic graph ──

  private async validate(graph: LinkResult): Promise<ValidationResult> {
    const prompt = `You are critically evaluating a knowledge graph. This graph was built by reasoning through someone's raw notes — NOT by reformatting them.

Evaluate on these axes:
1. ATOMICITY: Is every concept truly one idea? Or are some secretly two concepts mashed together?
2. COMPLETENESS: Are there implicit concepts the writer assumed but the graph missed?
   Think about what's BETWEEN the lines — what bridges connect disconnected clusters?
3. RELATIONSHIP QUALITY: Are edges specific (e.g. "requires", "enables") or lazy (e.g. "related to")?
4. STRUCTURAL INTEGRITY: Are there orphan nodes with no edges? Are there dense clusters missing cross-links?
5. SEMANTIC DEPTH: Does the graph reveal structure the writer didn't articulate? Or does it merely restate what was written?

Be harsh. A score of 0.75 means you found minor gaps. Below 0.5 means significant missing structure.

Return JSON: {
  "score": 0.85,
  "issues": ["specific issue 1", "specific issue 2"],
  "suggestions": ["specific fix 1", "specific fix 2"]
}

Graph: ${JSON.stringify(graph, null, 2)}`;

    const result = await this.client.chatJSON<ValidationResult>(
      prompt,
      SYSTEM_PROMPT
    );

    return {
      score:
        typeof result.score === "number"
          ? Math.min(1, Math.max(0, result.score))
          : 0,
      issues: Array.isArray(result.issues) ? result.issues : [],
      suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    };
  }

  // ─── Step 4: REFINE — fill the gaps the critique found ────

  private async refine(
    graph: LinkResult,
    issues: string[]
  ): Promise<LinkResult> {
    const prompt = `The self-critique found these issues in your knowledge graph. Fix them by reasoning DEEPER.

CRITICAL: You are not just reformatting — you are SURFACING IMPLICIT STRUCTURE.
If the critique says "missing bridge concept", INFER what that bridge is and add it.
If it says "edge too generic", replace "related to" with a specific verb.
If it says "concept not atomic", SPLIT it into two and link them.

Issues to fix:
${issues.map((i) => `- ${i}`).join("\n")}

Current graph: ${JSON.stringify(graph, null, 2)}

Return the corrected full graph JSON with both nodes and edges.
You may ADD new nodes for missing bridge concepts, SPLIT non-atomic nodes, and REPLACE weak edges with specific ones.`;

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
        label: e.label || "relates to",
        strength:
          typeof e.strength === "number"
            ? Math.min(1, Math.max(0, e.strength))
            : 0.5,
      }));

    const nodes = (result.nodes || graph.nodes).map((node, i) => ({
      id: node.id || graph.nodes[i]?.id || `c${i + 1}`,
      title: node.title || graph.nodes[i]?.title || `Concept ${i + 1}`,
      summary: node.summary || graph.nodes[i]?.summary || "",
      tags: Array.isArray(node.tags) ? node.tags : graph.nodes[i]?.tags || [],
      content:
        node.content || node.summary || graph.nodes[i]?.content || "",
    }));

    return {
      nodes,
      edges: validEdges.length > 0 ? validEdges : graph.edges,
    };
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

      // Step 1: EXTRACT — reason through semantic space
      this.emit("extracting", attempt, 0, false);
      const extracted = await this.extract(rawNotes, result);

      // Step 2: LINK — surface hidden relationships
      this.emit("linking", attempt, 0, false);
      const linked = await this.link(extracted);

      // Step 3: VALIDATE — self-critique
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

      // Step 4: REFINE — fill the gaps the critique found
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
