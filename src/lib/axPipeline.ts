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
QUALITY MATTERS: you preserve the writer's original meaning faithfully.
You do NOT over-process, hallucinate, or add unnecessary complexity.
When the original notes are already clear and complete, you recognise that and score high.
Always respond with valid JSON only. No markdown, no explanation, no code fences.
Every response must be a single valid JSON object parseable by JSON.parse().`;

// ─── AX Pipeline ─────────────────────────────────────────────

export class AXPipeline {
  private client: NvidiaClient;
  private onIteration: (log: IterationLog) => void;
  private rawNotes: string = "";

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
- PRESERVE the writer's original intent. Do NOT rephrase in ways that change meaning.
- Minor wording differences ("retains" vs "preserves", "uses" vs "employs") are NOT new concepts.

Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }] }

Raw notes:
${rawNotes}`;

    const refinementPrompt = `You previously extracted atomic concepts, but the validation found specific gaps.
Reason deeper — but ONLY where the critique identified real problems.

PREVIOUS CONCEPTS:
${JSON.stringify(previousResult?.nodes?.slice(0, 30), null, 2)}

ORIGINAL NOTES:
${rawNotes}

IMPROVE by addressing ONLY the specific issues found:
1. If a concept is truly missing (not just rephrased), add it.
2. If a "bridge" concept genuinely connects two clusters, add it.
3. If a concept is genuinely non-atomic (covers two distinct ideas), split it.
4. Do NOT rephrase existing concepts just for style — preserve the writer's wording when it's accurate.
5. Do NOT add speculative concepts that the writer didn't imply.
6. Keep all existing valid concepts — only ADD or SPLIT where genuinely needed.

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

QUALITY RULE: Only create edges where a REAL semantic relationship exists.
Do NOT fabricate connections just to make the graph look more connected.

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

  // ─── Step 3: VALIDATE — quality-aware self-critique ───────

  private async validate(graph: LinkResult): Promise<ValidationResult> {
    const prompt = `You are critically evaluating a knowledge graph for BOTH quality AND semantic fidelity.

The graph was built by reasoning through someone's raw notes. Your job is to judge whether the graph
is a FAITHFUL and COMPLETE representation of the writer's thinking — not whether it looks impressive.

Evaluate on these axes:

1. SEMANTIC FIDELITY (most important): Does the graph faithfully preserve the writer's meaning?
   - Minor wording changes ("retains" vs "preserves") do NOT lower the score — meaning is preserved.
   - Any concept that distorts, over-interprets, or hallucinates beyond what the writer intended DOES lower the score.
   - If the original notes are already clear and well-structured, the graph should score HIGH (0.90+).

2. ATOMICITY: Is every concept truly one idea? Or are some secretly two concepts mashed together?

3. COMPLETENESS: Are there implicit concepts the writer assumed but the graph missed?
   Think about what's BETWEEN the lines — what bridges connect disconnected clusters?
   But do NOT penalise if the notes are simple and don't have hidden depth.

4. RELATIONSHIP QUALITY: Are edges specific (e.g. "requires", "enables") or lazy (e.g. "related to")?

5. STRUCTURAL INTEGRITY: Are there orphan nodes with no edges? Dense clusters missing cross-links?

SCORING GUIDANCE:
- 0.90-1.00: The graph faithfully represents the notes. Minor wording differences only. Well-structured input.
- 0.75-0.89: Good but has minor gaps — a missing bridge concept or a few generic edge labels.
- 0.50-0.74: Significant gaps — missing concepts, broken relationships, or non-atomic nodes.
- 0.00-0.49: Major problems — hallucinated concepts, distorted meaning, or severely incomplete.

Be FAIR. If the notes are clear and the graph captures them well, do NOT invent reasons to lower the score.
If the only issues are minor wording changes that don't affect meaning, score 0.90+.

ORIGINAL NOTES (for comparison):
${this.rawNotes}

Graph: ${JSON.stringify(graph, null, 2)}

Return JSON: {
  "score": 0.85,
  "issues": ["specific issue 1", "specific issue 2"],
  "suggestions": ["specific fix 1", "specific fix 2"]
}
Only list issues that AFFECT MEANING or STRUCTURE, not cosmetic wording differences.`;

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

  // ─── Step 4: REFINE — targeted fixes only ─────────────────

  private async refine(
    graph: LinkResult,
    issues: string[]
  ): Promise<LinkResult> {
    const prompt = `The self-critique found these SPECIFIC issues in your knowledge graph.
Fix ONLY these issues — do NOT rework everything.

CRITICAL QUALITY RULES:
- Preserve the writer's original wording where it's accurate and meaningful.
- Only change what the critique identified as genuinely broken.
- Do NOT rephrase for style — only fix SEMANTIC or STRUCTURAL problems.
- If the critique says "missing bridge concept", INFER what that bridge is and add it.
- If it says "edge too generic", replace with a specific verb — but keep the same meaning.
- If it says "concept not atomic", SPLIT it into two and link them.
- Do NOT add speculative concepts that the writer didn't imply.

Issues to fix:
${issues.map((i) => `- ${i}`).join("\n")}

Current graph: ${JSON.stringify(graph, null, 2)}

Return the corrected full graph JSON with both nodes and edges.
Only ADD or CHANGE what's needed to fix the listed issues. Preserve everything else.`;

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
    this.rawNotes = rawNotes;
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

      // Step 3: VALIDATE — quality-aware self-critique
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

      // Step 4: REFINE — targeted fixes only, if score below threshold
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
