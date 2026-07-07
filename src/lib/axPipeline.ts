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

// ─── Constants ─────────────────────────────────────────────────

/** Maximum characters per chunk for extraction. Keeps prompts manageable
 *  even for very large inputs (books, research papers, etc.) */
const CHUNK_CHAR_LIMIT = 6000;

/** Minimum characters that trigger chunked processing */
const CHUNK_THRESHOLD = 4000;

// ─── System Prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a semantic reasoning engine that builds knowledge graphs from raw thinking.
You do NOT merely reformat or summarise — you REASON through the semantic space of ideas.
You surface implicit structure the writer already knows but didn't articulate.
You infer missing concepts, bridge gaps, and make hidden relationships explicit.
QUALITY MATTERS: you preserve the writer's original meaning faithfully.
You do NOT over-process, hallucinate, or add unnecessary complexity.
When the original notes are already clear and complete, you recognise that and score high.
Always respond with valid JSON only. No markdown, no explanation, no code fences.
Every response must be a single valid JSON object parseable by JSON.parse().`;

// ─── AX Pipeline ───────────────────────────────────────────────

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
    issues?: string[],
    detail?: string
  ) {
    this.onIteration({
      iteration,
      phase,
      score,
      passed,
      issues,
      detail,
      timestamp: Date.now(),
    });
  }

  /**
   * Wrap an async API call with rate-limit / transient error detection.
   */
  private async callWithRetryAwareness<T>(
    fn: () => Promise<T>,
    iteration: number,
    phaseLabel: string
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      const isRateLimit =
        msg.includes("rate limit") ||
        msg.includes("Rate limit") ||
        msg.includes("429") ||
        msg.includes("retry attempt") ||
        msg.includes("too many requests");

      const isTransient =
        msg.includes("server error") ||
        msg.includes("Server Error") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("504") ||
        msg.includes("temporary");

      if (isRateLimit) {
        this.emit(
          "retrying",
          iteration,
          0,
          false,
          undefined,
          `Rate limited during ${phaseLabel} — all proxy retries exhausted. Please wait and try again.`
        );
      } else if (isTransient) {
        this.emit(
          "retrying",
          iteration,
          0,
          false,
          undefined,
          `Transient server error during ${phaseLabel} — all proxy retries exhausted. Try again shortly.`
        );
      }

      throw error;
    }
  }

  // ─── Chunking Utilities ────────────────────────────────────────

  /**
   * Split raw notes into sensible chunks at paragraph/sentence boundaries.
   * Each chunk is at most CHUNK_CHAR_LIMIT characters.
   * Tries to split at paragraph breaks first, then sentence boundaries.
   */
  private splitIntoChunks(text: string): string[] {
    if (text.length <= CHUNK_CHAR_LIMIT) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= CHUNK_CHAR_LIMIT) {
        chunks.push(remaining);
        break;
      }

      // Try to split at paragraph break
      let splitIndex = remaining.lastIndexOf("\n\n", CHUNK_CHAR_LIMIT);
      if (splitIndex < CHUNK_CHAR_LIMIT * 0.3) {
        // Try newline
        splitIndex = remaining.lastIndexOf("\n", CHUNK_CHAR_LIMIT);
      }
      if (splitIndex < CHUNK_CHAR_LIMIT * 0.3) {
        // Try sentence boundary (. ! ?)
        const sentenceMatch = remaining
          .slice(0, CHUNK_CHAR_LIMIT)
          .match(/[.!?]\s+/g);
        if (sentenceMatch) {
          const lastSentence = sentenceMatch[sentenceMatch.length - 1];
          splitIndex =
            remaining.slice(0, CHUNK_CHAR_LIMIT).lastIndexOf(lastSentence) +
            lastSentence.length;
        }
      }
      if (splitIndex < CHUNK_CHAR_LIMIT * 0.3) {
        // Hard split at limit
        splitIndex = CHUNK_CHAR_LIMIT;
      }

      chunks.push(remaining.slice(0, splitIndex).trim());
      remaining = remaining.slice(splitIndex).trim();
    }

    return chunks.filter((c) => c.length > 0);
  }

  /**
   * Deduplicate nodes by title similarity.
   * If two nodes have very similar titles (case-insensitive, trimmed),
   * keep the one with more content and merge tags.
   */
  private deduplicateNodes(nodes: AtomicNode[]): AtomicNode[] {
    const seen = new Map<string, AtomicNode>();

    for (const node of nodes) {
      const key = node.title.toLowerCase().trim();

      if (seen.has(key)) {
        // Merge tags
        const existing = seen.get(key)!;
        const mergedTags = [...new Set([...existing.tags, ...node.tags])];
        existing.tags = mergedTags;
        // Keep the longer summary/content
        if ((node.summary || "").length > (existing.summary || "").length) {
          existing.summary = node.summary;
        }
        if ((node.content || "").length > (existing.content || "").length) {
          existing.content = node.content;
        }
      } else {
        seen.set(key, { ...node });
      }
    }

    // Re-index IDs sequentially
    return Array.from(seen.values()).map((node, i) => ({
      ...node,
      id: `c${i + 1}`,
    }));
  }

  // ─── Step 1: EXTRACT — reason through semantic space ──────────

  private async extractChunk(
    chunk: string,
    chunkIndex: number,
    totalChunks: number
  ): Promise<ExtractResult> {
    const contextHint =
      totalChunks > 1
        ? `\n\n[This is part ${chunkIndex + 1} of ${totalChunks} of the input. Focus on concepts in this section. Use tags to link related ideas across sections.]`
        : "";

    const prompt = `You are reasoning through the semantic space of someone's raw thinking.

STEP 1 — What are the atomic concepts?
Break the notes into indivisible ideas — each concept must be ONE idea only.
Do NOT merely list keywords from the text. Instead:
- Identify every explicit concept the writer names
- Infer implicit concepts the writer assumes but doesn't name (e.g. if they mention "RAG needs embeddings", the concept "vector similarity search" is implicit)
- Surface the "glue" concepts that connect ideas but are left unsaid
- Each concept gets a concise title and a 1-2 sentence summary explaining WHY it matters in this context
- PRESERVE the writer's original intent. Do NOT rephrase in ways that change meaning.
- Minor wording differences ("retains" vs "preserves", "uses" vs "employs") are NOT new concepts.
- Use descriptive tags that help group related concepts across sections.

Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }] }

Raw notes:${contextHint}
${chunk}`;

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

  /**
   * Extract concepts from notes. For large inputs, splits into chunks,
   * processes each chunk separately, then merges and deduplicates.
   */
  private async extract(
    rawNotes: string,
    previousResult: LinkResult | null
  ): Promise<ExtractResult> {
    // ─── Refinement path (not first pass) ─────────────────────
    if (previousResult) {
      return this.extractRefinement(rawNotes, previousResult);
    }

    // ─── First pass: check if chunking is needed ──────────────
    const chunks = this.splitIntoChunks(rawNotes);

    if (chunks.length === 1) {
      // Small input — process directly
      return this.extractChunk(rawNotes, 0, 1);
    }

    // ─── Large input: chunked extraction ──────────────────────
    this.emit(
      "chunking",
      1,
      0,
      false,
      undefined,
      `Processing ${chunks.length} sections of your notes…`
    );

    const allNodes: AtomicNode[] = [];
    let succeededChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        this.emit(
          "extracting",
          1,
          0,
          false,
          undefined,
          `Extracting section ${i + 1} of ${chunks.length}…`
        );

        const chunkResult = await this.callWithRetryAwareness(
          () => this.extractChunk(chunks[i], i, chunks.length),
          1,
          `Extract (section ${i + 1}/${chunks.length})`
        );

        // Prefix IDs with chunk index to avoid collisions before dedup
        chunkResult.nodes.forEach((node) => {
          node.id = `s${i + 1}_${node.id}`;
        });

        allNodes.push(...chunkResult.nodes);
        succeededChunks++;
      } catch (error) {
        // Partial processing: log the error but continue with other chunks
        console.warn(
          `[AX Pipeline] Chunk ${i + 1}/${chunks.length} failed:`,
          error instanceof Error ? error.message : error
        );
        this.emit(
          "retrying",
          1,
          0,
          false,
          undefined,
          `Section ${i + 1} failed — continuing with remaining sections`
        );
      }
    }

    if (allNodes.length === 0) {
      throw new Error(
        `All ${chunks.length} sections failed to extract. Please try again.`
      );
    }

    // Deduplicate across chunks
    const deduplicated = this.deduplicateNodes(allNodes);

    this.emit(
      "extracting",
      1,
      0,
      false,
      undefined,
      `Extracted ${deduplicated.length} concepts from ${succeededChunks}/${chunks.length} sections`
    );

    return { nodes: deduplicated };
  }

  private async extractRefinement(
    rawNotes: string,
    previousResult: LinkResult | null
  ): Promise<ExtractResult> {
    const nodesCompact = previousResult?.nodes
      ?.slice(0, 50)
      .map((n) => `${n.id}: ${n.title}`)
      .join("\n");

    const prompt = `You previously extracted atomic concepts, but the validation found specific gaps.
Reason deeper — but ONLY where the critique identified real problems.

PREVIOUS CONCEPTS:
${nodesCompact}

ORIGINAL NOTES:
${rawNotes.slice(0, 3000)}${rawNotes.length > 3000 ? "\n… (notes truncated for brevity)" : ""}

IMPROVE by addressing ONLY the specific issues found:
1. If a concept is truly missing (not just rephrased), add it.
2. If a "bridge" concept genuinely connects two clusters, add it.
3. If a concept is genuinely non-atomic (covers two distinct ideas), split it.
4. Do NOT rephrase existing concepts just for style — preserve the writer's wording when it's accurate.
5. Do NOT add speculative concepts that the writer didn't imply.
6. Keep all existing valid concepts — only ADD or SPLIT where genuinely needed.

Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }] }`;

    const result = await this.client.chatJSON<ExtractResult>(prompt, SYSTEM_PROMPT);

    if (!result.nodes || !Array.isArray(result.nodes)) {
      throw new Error("Extract refinement returned invalid nodes array");
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

  // ─── Step 2: LINK — surface hidden relationships ──────────────

  private async link(extracted: ExtractResult): Promise<LinkResult> {
    const nodeSummary = extracted.nodes
      .map((n) => `${n.id}: ${n.title}`)
      .join("\n");

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

IMPORTANT: Return ONLY the edges array — do NOT repeat the nodes.
Return JSON: { "edges": [{ "source": "nodeId", "target": "nodeId", "label": "specific relationship", "strength": 0.8 }] }

Nodes (id: title):
${nodeSummary}`;

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

  // ─── Step 3: VALIDATE — quality-aware self-critique ───────────

  private async validate(graph: LinkResult): Promise<ValidationResult> {
    // Use compact representation to save tokens
    const graphCompact = {
      nodes: graph.nodes.map((n) => ({ id: n.id, title: n.title, summary: n.summary, tags: n.tags })),
      edges: graph.edges.map((e) => ({ source: e.source, target: e.target, label: e.label, strength: e.strength })),
    };

    // Truncate original notes if very large (validator doesn't need every word)
    const notesForValidation = this.rawNotes.length > 6000
      ? this.rawNotes.slice(0, 6000) + "\n… (notes truncated for validation)"
      : this.rawNotes;

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
${notesForValidation}

Graph: ${JSON.stringify(graphCompact)}

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

  // ─── Step 4: REFINE — targeted fixes only ────────────────────

  private async refine(
    graph: LinkResult,
    issues: string[]
  ): Promise<LinkResult> {
    // Use compact representation to save tokens
    const graphCompact = {
      nodes: graph.nodes.map((n) => ({ id: n.id, title: n.title, summary: n.summary, tags: n.tags })),
      edges: graph.edges.map((e) => ({ source: e.source, target: e.target, label: e.label, strength: e.strength })),
    };

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

IMPORTANT: Return the FULL corrected graph with both nodes and edges. Keep all existing nodes and edges that don't need changes. Only ADD or CHANGE what's needed to fix the listed issues.

Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }], "edges": [{ "source": "nodeId", "target": "nodeId", "label": "...", "strength": 0.8 }] }

Issues to fix:
${issues.map((i) => `- ${i}`).join("\n")}

Current graph: ${JSON.stringify(graphCompact)}`;

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

  // ─── Main Pipeline Runner ──────────────────────────────────────

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
      // (handles chunking for large inputs internally)
      this.emit("extracting", attempt, 0, false);
      let extracted: ExtractResult;
      try {
        extracted = await this.callWithRetryAwareness(
          () => this.extract(rawNotes, result),
          attempt,
          "Extract"
        );
      } catch (extractError) {
        // Partial processing: if we have a previous result, continue with it
        if (result) {
          console.warn("[AX Pipeline] Extract failed, using previous result");
          extracted = { nodes: result.nodes };
        } else {
          throw extractError;
        }
      }

      // Step 2: LINK — surface hidden relationships
      this.emit("linking", attempt, 0, false);
      let linked: LinkResult;
      try {
        linked = await this.callWithRetryAwareness(
          () => this.link(extracted),
          attempt,
          "Link"
        );
      } catch (linkError) {
        // Partial processing: continue with extracted nodes, no edges
        console.warn("[AX Pipeline] Link failed, using nodes without edges");
        linked = { nodes: extracted.nodes, edges: [] };
      }

      // Step 3: VALIDATE — quality-aware self-critique
      this.emit("validating", attempt, 0, false);
      try {
        const validation = await this.callWithRetryAwareness(
          () => this.validate(linked),
          attempt,
          "Validate"
        );
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
          try {
            result = await this.callWithRetryAwareness(
              () => this.refine(linked, validation.issues),
              attempt,
              "Refine"
            );
          } catch (refineError) {
            // Partial processing: use linked result as-is
            console.warn("[AX Pipeline] Refine failed, using linked result");
            result = linked;
          }
        } else {
          result = linked;
        }
      } catch (validateError) {
        // Validation failed — use linked result with a default score
        console.warn("[AX Pipeline] Validate failed, using default score");
        score = 0.7; // Assume decent quality
        result = linked;

        iterLogs.push({
          iteration: attempt,
          phase: "validating",
          score,
          passed: score >= threshold,
          issues: ["Validation step failed — using estimated score"],
          timestamp: Date.now(),
        });

        if (score >= threshold) break;
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
