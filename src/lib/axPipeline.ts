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
const CHUNK_CHAR_LIMIT = 8000;

/** Minimum characters that trigger chunked processing.
 *  Bumped from 4000 → 8000: Vercel Edge has a 30s function cap, and
 *  sequential chunks WILL blow past it after 2-3 chunks. By raising the
 *  threshold, most "large" docs (5-8K chars) now fit in a single EXTRACT
 *  call that comfortably completes in <18s. Only truly large inputs
 *  (>8K chars) trigger chunking — and we warn the user about the 30s cap. */
const CHUNK_THRESHOLD = 8000;

// ─── System Prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a semantic reasoning engine that builds knowledge graphs from raw thinking.
You do NOT merely reformat or summarise — you REASON through the semantic space of ideas.
You surface implicit structure the writer already knows but didn't articulate.
You infer missing concepts, bridge gaps, and make hidden relationships explicit.
QUALITY MATTERS: you preserve the writer's original meaning faithfully.
You do NOT over-process, hallucinate, or add unnecessary complexity.
When the original notes are already clear and complete, you recognise that and score high.

CRITICAL OUTPUT RULES:
- Always respond with valid JSON only. No markdown, no explanation, no code fences.
- Every response must be a single valid JSON object parseable by JSON.parse().
- Be CONCISE in summaries: 1-2 short sentences max per node.
- Keep titles short: 2-5 words.
- Use minimal tags: 1-3 per node.
- Do NOT repeat the input text verbatim in summaries — distill the core idea.
- Avoid overly verbose edge labels — use 1-3 word specific verbs.`;

// ─── AX Pipeline ───────────────────────────────────────────────

export interface PipelineStreamCallbacks {
  /** Fired for every structured log line from the NVIDIA client. */
  onLog?: (line: string) => void;
  /** Fired for every content chunk as it arrives (live tokens). */
  onChunk?: (text: string) => void;
}

export interface AXPipelineOptions {
  /** Live event callbacks (for the dark terminal-style log viewer). */
  streamCallbacks?: PipelineStreamCallbacks;
  /**
   * Route LLM calls through /api/nvidia-stream (SSE) instead of /api/nvidia.
   * Default: true — Vercel's Node serverless path silently hangs on
   * gpt-oss-120b, so streaming via Edge runtime is the only reliable path.
   * Each call has a 12s timeout × 2 attempts, with structured log + chunk
   * events streamed to the browser so the user sees live progress.
   *
   * Set to false to fall back to the non-streaming /api/nvidia proxy.
   */
  useStreaming?: boolean;
}

export class AXPipeline {
  private client: NvidiaClient;
  private onIteration: (log: IterationLog) => void;
  private streamCallbacks: PipelineStreamCallbacks;
  private useStreaming: boolean;
  private rawNotes: string = "";

  constructor(
    apiKey: string,
    model: NvidiaModel,
    onIteration: (log: IterationLog) => void,
    options: AXPipelineOptions = {},
  ) {
    this.client = new NvidiaClient(apiKey, model);
    this.onIteration = onIteration;
    this.streamCallbacks = options.streamCallbacks ?? {};
    // Default: streaming ON. Required for gpt-oss-120b on Vercel.
    this.useStreaming = options.useStreaming ?? true;
  }

  /**
   * Routes an LLM call. By default uses the streaming path
   * (/api/nvidia-stream on Edge runtime) because gpt-oss-120b hangs on
   * Vercel's Node serverless. Streaming also gives live log + chunk events
   * for the UI's terminal-style log viewer.
   *
   * If useStreaming=false, falls back to chatJSON (non-streaming /api/nvidia).
   */
  private async callLLMJSON<T>(
    prompt: string,
    phaseLabel: string,
  ): Promise<T> {
    if (this.useStreaming) {
      return await this.client.chatJSONStream<T>(
        prompt,
        SYSTEM_PROMPT,
        this.streamCallbacks.onLog,
        this.streamCallbacks.onChunk,
        phaseLabel,
      );
    }
    return await this.client.chatJSON<T>(prompt, SYSTEM_PROMPT);
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
   * Sleep helper for inter-chunk cooldown and retry backoff.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Compute backoff delay BEFORE a retry attempt.
   *
   * IMPORTANT: NVIDIA's rate-limiting doesn't always return a clean 429.
   * Sometimes it just hangs the connection until our 18s timeout fires.
   * So a timeout (AbortError) is OFTEN rate-limit-induced, and we should
   * still back off before retrying.
   *
   * - Rate-limit (429) errors: 10s backoff
   * - Timeout (AbortError):    5s backoff (was 0s — too aggressive)
   * - Other errors:            5s backoff
   */
  private computeRetryBackoff(errorMsg: string): { delayMs: number; reason: string } {
    const msg = (errorMsg || "").toLowerCase();
    const isRateLimit =
      msg.includes("rate limit") ||
      msg.includes("429") ||
      msg.includes("too many requests") ||
      msg.includes("retry attempt");
    const isTimeout =
      msg.includes("timeout") ||
      msg.includes("aborted") ||
      msg.includes("timed out");

    if (isRateLimit) {
      return { delayMs: 10_000, reason: "rate-limit backoff" };
    }
    if (isTimeout) {
      // 5s — timeout may be rate-limit-induced hang, give NVIDIA some room
      return { delayMs: 5_000, reason: "timeout backoff (may be rate-limit-induced)" };
    }
    return { delayMs: 5_000, reason: "backoff" };
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

    const prompt = `Extract atomic concepts from these notes. Each concept = ONE idea only.

Rules:
- Identify explicit AND implicit concepts (what's assumed but not named)
- Infer "glue" concepts that connect ideas but are left unsaid
- Title: 2-5 words. Summary: 1-2 SHORT sentences explaining WHY it matters.
- Preserve the writer's intent. Minor wording differences are NOT new concepts.
- Tags: 1-3 descriptive tags for grouping.
- Be CONCISE — do NOT repeat input text verbatim.

Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }] }

Raw notes:${contextHint}
${chunk}`;

    const result = await this.callLLMJSON<ExtractResult>(prompt, `Extract (section ${chunkIndex + 1}/${totalChunks})`);

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
    // ─── Vercel Edge 30s cap warning ────────────────────────────
    // Each chunk takes ~5-10s on gpt-oss-120b (plus 18s timeout if it
    // hangs). Sequential chunks WILL blow past Vercel Edge's 30s function
    // cap after 2-3 chunks. We can't parallelize (NVIDIA rate-limits),
    // so we warn the user upfront and reduce per-call timeout for
    // multi-chunk inputs to fit more chunks within 30s.
    const EDGE_FUNCTION_BUDGET_MS = 28_000; // 30s cap - 2s buffer
    const ESTIMATED_MS_PER_CHUNK = chunks.length > 1 ? 9_000 : 18_000; // tighter for multi-chunk
    const estimatedTotalMs = chunks.length * ESTIMATED_MS_PER_CHUNK;
    if (estimatedTotalMs > EDGE_FUNCTION_BUDGET_MS) {
      this.emit(
        "retrying",
        1,
        0,
        false,
        undefined,
        `⚠️ Large input: ${chunks.length} sections × ~${ESTIMATED_MS_PER_CHUNK / 1000}s each ≈ ${Math.round(estimatedTotalMs / 1000)}s. Vercel Edge caps at 30s — pipeline may be killed mid-way. Consider splitting into smaller inputs.`,
      );
    }

    this.emit(
      "chunking",
      1,
      0,
      false,
      undefined,
      `Processing ${chunks.length} sections of your notes…`,
    );

    const allNodes: AtomicNode[] = [];
    let succeededChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
      this.emit(
        "extracting",
        1,
        0,
        false,
        undefined,
        `Extracting section ${i + 1} of ${chunks.length}…`,
      );

      // Per-chunk retry with "second round" recovery.
      // Round 1: 3 attempts with 5-10s backoff between each.
      // If all 3 fail: 30s cooldown, then Round 2: 3 more attempts.
      // The 30s cooldown is the key — it's what allows NVIDIA's rate-limit
      // window to fully reset (5s wasn't enough, as seen in production).
      const MAX_CHUNK_ATTEMPTS = 3;
      const MAX_CHUNK_ROUNDS = 2;
      let chunkResult: ExtractResult | null = null;
      let lastChunkError = "";
      let chunkSucceededOnAttempt = 0;

      for (let round = 1; round <= MAX_CHUNK_ROUNDS && chunkResult === null; round++) {
        if (round > 1) {
          // 30s cooldown before second round — gives NVIDIA's rate-limit
          // window time to fully reset. This is the recovery time that
          // the 5s inter-attempt backoff couldn't provide.
          this.emit(
            "retrying",
            1,
            0,
            false,
            undefined,
            `Section ${i + 1} round 2/${MAX_CHUNK_ROUNDS}: 30s cooldown before retrying (NVIDIA rate-limit reset)…`,
          );
          await this.sleep(30_000);
          this.emit(
            "extracting",
            1,
            0,
            false,
            undefined,
            `Section ${i + 1} round 2 — retrying after cooldown…`,
          );
        }

        for (let chunkAttempt = 1; chunkAttempt <= MAX_CHUNK_ATTEMPTS; chunkAttempt++) {
          try {
            if (chunkAttempt > 1) {
              const backoff = this.computeRetryBackoff(lastChunkError);
              this.emit(
                "retrying",
                1,
                0,
                false,
                undefined,
                backoff.delayMs > 0
                  ? `Section ${i + 1} round ${round} attempt ${chunkAttempt}/${MAX_CHUNK_ATTEMPTS} in ${backoff.delayMs / 1000}s (${backoff.reason})…`
                  : `Section ${i + 1} round ${round} attempt ${chunkAttempt}/${MAX_CHUNK_ATTEMPTS} — retrying…`,
              );
              if (backoff.delayMs > 0) {
                await this.sleep(backoff.delayMs);
              }
            }
            chunkResult = await this.callWithRetryAwareness(
              () => this.extractChunk(chunks[i], i, chunks.length),
              1,
              `Extract (section ${i + 1}/${chunks.length}, round ${round}${chunkAttempt > 1 ? `, retry ${chunkAttempt}` : ""})`,
            );
            chunkSucceededOnAttempt = chunkAttempt;
            lastChunkError = "";
            break; // success
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            lastChunkError = msg;
            console.warn(
              `[AX Pipeline] Chunk ${i + 1}/${chunks.length} round ${round} attempt ${chunkAttempt}/${MAX_CHUNK_ATTEMPTS} failed: ${msg}`,
            );
            if (round === MAX_CHUNK_ROUNDS && chunkAttempt === MAX_CHUNK_ATTEMPTS) {
              this.emit(
                "retrying",
                1,
                0,
                false,
                undefined,
                `Section ${i + 1} failed after ${MAX_CHUNK_ROUNDS} rounds × ${MAX_CHUNK_ATTEMPTS} attempts — skipping (will use remaining sections).`,
              );
            }
          }
        }
      }

      if (chunkResult) {
        // Prefix IDs with chunk index to avoid collisions before dedup
        chunkResult.nodes.forEach((node) => {
          node.id = `s${i + 1}_${node.id}`;
        });
        allNodes.push(...chunkResult.nodes);
        succeededChunks++;
      }

      // ─── Inter-chunk cooldown (rate-limit reset) ──────────────
      // Wait before starting the next chunk so NVIDIA's rate-limit window
      // has time to reset. Adaptive based on how the previous chunk went:
      //   - Succeeded on first attempt: 10s (quick breather)
      //   - Succeeded after retries:    30s (something was flaky)
      //   - Failed all attempts:        60s if rate-limit, 30s otherwise
      // Capped at 60s. Same pattern as ax-translator.
      //
      // Note: On Vercel Edge (30s function cap), long cooldowns will get
      // killed. The live log will show the cooldown message. For large
      // inputs with 3+ chunks, use a non-Vercel host.
      if (i < chunks.length - 1) {
        const isRateLimitError = /rate.?limit|429|too many requests/i.test(lastChunkError);
        let delaySec = 10;
        if (chunkResult === null) {
          delaySec = isRateLimitError ? 60 : 30;
        } else if (chunkSucceededOnAttempt > 1) {
          delaySec = 30;
        }
        delaySec = Math.min(delaySec, 60);

        this.emit(
          "retrying",
          1,
          0,
          false,
          undefined,
          `Cooldown: waiting ${delaySec}s before section ${i + 2}/${chunks.length} (lets NVIDIA rate-limit window reset)…`,
        );

        await this.sleep(delaySec * 1000);

        this.emit(
          "extracting",
          1,
          0,
          false,
          undefined,
          `Cooldown complete — starting section ${i + 2}/${chunks.length}.`,
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

    const prompt = `Refine concepts — fix ONLY the validation issues, nothing else.

PREVIOUS CONCEPTS:
${nodesCompact}

ORIGINAL NOTES:
${rawNotes.slice(0, 2000)}${rawNotes.length > 2000 ? "\n…" : ""}

Fix rules:
- Add truly missing concepts (not rephrased ones)
- Add bridge concepts that connect clusters
- Split genuinely non-atomic concepts
- Keep all existing valid concepts unchanged
- Be CONCISE: short titles, brief summaries

Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }] }`;

    const result = await this.callLLMJSON<ExtractResult>(prompt, "Extract (refinement)");

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

    const prompt = `Map relationships between these atomic concepts.

Find both direct and implicit relationships:
- Direct: A enables B, A requires B, A is a subtype of B
- Implicit: A and B connected through unstated C
- Causal: A leads to B which enables C

Edge labels: use SPECIFIC verbs ("requires", "enables", "feeds into", "constrains", "extends"), NOT generic "related to".
Keep labels to 1-3 words.

Strength (0.0-1.0):
- 0.9+: definitionally true
- 0.7-0.9: strongly implied
- 0.4-0.7: inferred bridge
- 0.0-0.4: speculative

Only create edges for REAL relationships. Do NOT fabricate connections.
Return ONLY edges — do NOT repeat nodes.

Return JSON: { "edges": [{ "source": "nodeId", "target": "nodeId", "label": "verb", "strength": 0.8 }] }

Nodes (id: title):
${nodeSummary}`;

    const result = await this.callLLMJSON<LinkResult>(prompt, "Link");

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
    // Use a smaller limit to keep total prompt+response within token budgets
    const notesForValidation = this.rawNotes.length > 4000
      ? this.rawNotes.slice(0, 4000) + "\n… (notes truncated)"
      : this.rawNotes;

    const prompt = `Evaluate this knowledge graph for quality and semantic fidelity.

Axes (weight: semantic fidelity > atomicity > completeness > relationships > structure):
1. SEMANTIC FIDELITY: Does it preserve the writer's meaning? Minor wording changes don't lower score.
2. ATOMICITY: Is each concept truly one idea?
3. COMPLETENESS: Are implicit concepts captured?
4. RELATIONSHIP QUALITY: Specific edge labels ("requires") vs lazy ones ("related to")?
5. STRUCTURAL INTEGRITY: Orphan nodes? Missing cross-links?

Scoring:
- 0.90-1.00: Faithful representation, minor wording differences only
- 0.75-0.89: Minor gaps
- 0.50-0.74: Significant gaps
- 0.00-0.49: Major problems

Be FAIR — clear notes + good graph = high score. Don't invent reasons to lower it.

ORIGINAL NOTES:
${notesForValidation}

Graph: ${JSON.stringify(graphCompact)}

Return JSON: { "score": 0.85, "issues": ["..."], "suggestions": ["..."] }
Only list issues affecting MEANING or STRUCTURE.`;

    const result = await this.callLLMJSON<ValidationResult>(prompt, "Validate");

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

    const prompt = `Fix ONLY these specific issues in the knowledge graph.

Rules:
- Preserve writer's wording where accurate
- Only fix SEMANTIC or STRUCTURAL problems, not style
- Missing bridge? INFER and add it.
- Generic edge? Replace with specific verb.
- Non-atomic concept? SPLIT into two and link.
- No speculative additions.
- Be CONCISE: short titles, brief summaries, 1-3 word edge labels.

Return the FULL corrected graph (both nodes and edges). Keep unchanged items as-is.

Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }], "edges": [{ "source": "id", "target": "id", "label": "verb", "strength": 0.8 }] }

Issues:
${issues.map((i) => `- ${i}`).join("\n")}

Current graph: ${JSON.stringify(graphCompact)}`;

    const result = await this.callLLMJSON<LinkResult>(prompt, "Refine");

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

      // ─── Pre-LINK cooldown ──────────────────────────────────────
      // EXTRACT just burned NVIDIA rate-limit budget. LINK runs immediately
      // after and often fails because the rate-limit window hasn't reset.
      // Wait 10s (or 30s if EXTRACT had retries) before starting LINK.
      {
        const preLinkDelay = 10_000; // 10s default cooldown before LINK
        this.emit(
          "retrying",
          attempt,
          0,
          false,
          undefined,
          `Cooldown: waiting 10s before LINK (lets NVIDIA rate-limit window reset after EXTRACT)…`,
        );
        await this.sleep(preLinkDelay);
        this.emit(
          "linking",
          attempt,
          0,
          false,
          undefined,
        );
      }

      // ─── Step 2: LINK — surface hidden relationships ─────────────
      // LINK is mandatory — a graph without edges is useless. Same round-
      // based retry pattern as chunked EXTRACT: 3 attempts per round,
      // 30s cooldown between rounds, up to 2 rounds. If all rounds fail,
      // throw and abort the pipeline.
      //
      // Each /api/nvidia-stream call has an 18s timeout × 1 attempt.
      // Rate-limit-aware backoff between retries: 10s for 429 errors,
      // 5s for timeouts (may be rate-limit-induced hangs).
      let linked: LinkResult | null = null;
      const MAX_LINK_ATTEMPTS = 3;
      const MAX_LINK_ROUNDS = 2;
      let lastLinkError = "";

      for (let linkRound = 1; linkRound <= MAX_LINK_ROUNDS && linked === null; linkRound++) {
        if (linkRound > 1) {
          this.emit(
            "retrying",
            attempt,
            0,
            false,
            undefined,
            `Link round 2/${MAX_LINK_ROUNDS}: 30s cooldown before retrying (NVIDIA rate-limit reset)…`,
          );
          await this.sleep(30_000);
          this.emit(
            "linking",
            attempt,
            0,
            false,
            undefined,
          );
        }

        for (let linkAttempt = 1; linkAttempt <= MAX_LINK_ATTEMPTS; linkAttempt++) {
          try {
            if (linkAttempt > 1) {
              const backoff = this.computeRetryBackoff(lastLinkError);
              this.emit(
                "retrying",
                attempt,
                0,
                false,
                undefined,
                backoff.delayMs > 0
                  ? `Link round ${linkRound} attempt ${linkAttempt}/${MAX_LINK_ATTEMPTS} in ${backoff.delayMs / 1000}s (${backoff.reason})…`
                  : `Link round ${linkRound} attempt ${linkAttempt}/${MAX_LINK_ATTEMPTS} — retrying…`,
              );
              if (backoff.delayMs > 0) {
                await this.sleep(backoff.delayMs);
              }
            }
            linked = await this.callWithRetryAwareness(
              () => this.link(extracted),
              attempt,
              `Link (round ${linkRound}${linkAttempt > 1 ? `, retry ${linkAttempt}` : ""})`,
            );
            lastLinkError = "";
            break; // success
          } catch (linkError) {
            const msg = linkError instanceof Error ? linkError.message : String(linkError);
            lastLinkError = msg;
            console.warn(
              `[AX Pipeline] Link round ${linkRound} attempt ${linkAttempt}/${MAX_LINK_ATTEMPTS} failed: ${msg}`,
            );
            if (linkRound === MAX_LINK_ROUNDS && linkAttempt === MAX_LINK_ATTEMPTS) {
              this.emit(
                "retrying",
                attempt,
                0,
                false,
                undefined,
                `Link failed after ${MAX_LINK_ROUNDS} rounds × ${MAX_LINK_ATTEMPTS} attempts — edges are mandatory. Aborting pipeline.`,
              );
            }
          }
        }
      }

      // Edges are mandatory: if LINK failed all rounds, abort the pipeline
      if (linked === null) {
        throw new Error(
          `Could not generate edges after ${MAX_LINK_ROUNDS} rounds × ${MAX_LINK_ATTEMPTS} attempts. ` +
          `Last error: ${lastLinkError}. Please click Generate again — NVIDIA's rate limit ` +
          `may have cleared by then.`
        );
      }

      // ─── Pre-VALIDATE cooldown ──────────────────────────────────
      // LINK just burned NVIDIA rate-limit budget. VALIDATE runs immediately
      // after and may fail. 10s cooldown gives NVIDIA time to reset.
      {
        this.emit(
          "retrying",
          attempt,
          0,
          false,
          undefined,
          `Cooldown: waiting 10s before VALIDATE (lets NVIDIA rate-limit window reset after LINK)…`,
        );
        await this.sleep(10_000);
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
