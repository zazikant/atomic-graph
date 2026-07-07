# Atomic Graph — AI Agent Pipeline Steps

## Endpoint

```
POST https://atomic-graph.vercel.app/api/nvidia
Content-Type: application/json
```

All requests use the same base body shape:

```json
{
  "apiKey": "YOUR_NVIDIA_API_KEY",
  "model": "openai/gpt-oss-120b",
  "messages": [
    { "role": "system", "content": "<SYSTEM_PROMPT>" },
    { "role": "user", "content": "<USER_PROMPT>" }
  ]
}
```

The response will be at: `response.choices[0].message.content` (a JSON string — parse it).

---

## System Prompt (same for all steps)

```
You are a semantic reasoning engine that builds knowledge graphs from raw thinking.
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
- Avoid overly verbose edge labels — use 1-3 word specific verbs.
```

---

## Step 1 — EXTRACT

**User prompt:**

```
Extract atomic concepts from these notes. Each concept = ONE idea only.

Rules:
- Identify explicit AND implicit concepts (what's assumed but not named)
- Infer "glue" concepts that connect ideas but are left unsaid
- Title: 2-5 words. Summary: 1-2 SHORT sentences explaining WHY it matters.
- Preserve the writer's intent. Minor wording differences are NOT new concepts.
- Tags: 1-3 descriptive tags for grouping.
- Be CONCISE — do NOT repeat input text verbatim.

Return JSON: { "nodes": [{ "id": "c1", "title": "...", "summary": "...", "tags": ["..."] }] }

Raw notes:
<YOUR NOTES HERE>
```

**Save output:** `nodes[]`

---

## Step 2 — LINK

**User prompt** (use the node list from Step 1):

```
Map relationships between these atomic concepts.

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
<PASTE: c1: Title, c2: Title, ...>
```

**Save output:** `edges[]`

---

## Step 3 — VALIDATE

**User prompt** (use nodes + edges from above):

```
Evaluate this knowledge graph for quality and semantic fidelity.

Axes (weight: semantic fidelity > atomicity > completeness > relationships > structure):
1. SEMANTIC FIDELITY: Does it preserve the writer's meaning?
2. ATOMICITY: Is each concept truly one idea?
3. COMPLETENESS: Are implicit concepts captured?
4. RELATIONSHIP QUALITY: Specific edge labels vs lazy ones?
5. STRUCTURAL INTEGRITY: Orphan nodes? Missing cross-links?

Scoring:
- 0.90-1.00: Faithful, minor wording differences only
- 0.75-0.89: Minor gaps
- 0.50-0.74: Significant gaps
- 0.00-0.49: Major problems

Be FAIR — clear notes + good graph = high score.

ORIGINAL NOTES:
<YOUR NOTES HERE>

Graph: <PASTE FULL JSON: { nodes: [...], edges: [...] }>

Return JSON: { "score": 0.85, "issues": ["..."], "suggestions": ["..."] }
```

**Check:** If `score >= 0.75` (or your threshold) → done, go to Final Output. If not → run Step 4.

---

## Step 4 — REFINE (only if score is below threshold)

**User prompt:**

```
Fix ONLY these specific issues in the knowledge graph.

Rules:
- Preserve writer's wording where accurate
- Only fix SEMANTIC or STRUCTURAL problems, not style
- Missing bridge? INFER and add it.
- Generic edge? Replace with specific verb.
- Non-atomic concept? SPLIT into two and link.
- No speculative additions.
- Be CONCISE: short titles, brief summaries, 1-3 word edge labels.

Return the FULL corrected graph (both nodes and edges).

Return JSON: { "nodes": [...], "edges": [...] }

Issues:
<PASTE issues[] from Step 3>

Current graph: <PASTE FULL JSON: { nodes: [...], edges: [...] }>
```

Then **loop back to Step 3** with the new graph. Repeat until score >= threshold or max iterations reached (default: 3).

---

## Loop Logic

```
repeat up to N iterations (default: 3):
  1. EXTRACT  → nodes[]
  2. LINK     → edges[]
  3. VALIDATE → score, issues[]
  if score >= threshold (default: 0.75):
    break
  else:
  4. REFINE   → updated nodes[], edges[]
    go back to step 3
```

---

## Final Output Format

```json
{
  "nodes": [
    {
      "id": "c1",
      "title": "Short Concept Title",
      "summary": "1-2 sentence explanation of why this matters.",
      "tags": ["tag1", "tag2"]
    }
  ],
  "edges": [
    {
      "source": "c1",
      "target": "c2",
      "label": "enables",
      "strength": 0.85
    }
  ]
}
```

### Edge strength legend

| Strength | Color in UI | Meaning |
|---|---|---|
| >= 0.7 | Bright purple | Strong connection |
| 0.4 – 0.69 | Indigo/blue | Moderate connection |
| < 0.4 | Gray | Weak / speculative |

### Node fields legend

| Field | Meaning |
|---|---|
| `id` | Unique identifier (e.g. c1, c2) |
| `title` | Short concept name (2-5 words) |
| `summary` | Why the concept matters (1-2 sentences) |
| `tags` | Keywords used to group related nodes by color |
| `cluster` | Auto-assigned color group (based on shared tags) |
