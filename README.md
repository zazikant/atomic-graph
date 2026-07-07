# Atomic Graph

Transform raw notes into interactive knowledge graphs using AI semantic reasoning.

![Atomic Graph](https://img.shields.io/badge/AI-Nvidia%20NIM-76B900?style=flat-square) ![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square) ![React Flow](https://img.shields.io/badge/React_Flow-12-blue?style=flat-square)

## How It Works

1. **Paste** your raw notes, ideas, or unstructured thinking
2. **AI reasons** through the semantic space of your ideas using a DSPy-style AX Pipeline:
   - **EXTRACT** — Surface explicit and implicit atomic concepts
   - **LINK** — Map relationships with specific verb-labeled edges
   - **VALIDATE** — Quality-aware self-critique with semantic fidelity scoring
   - **REFINE** — Targeted fixes only where needed (iterates until threshold met)
3. **Explore** the interactive Obsidian-style knowledge graph — drag, zoom, click nodes for detail

## Features

- **Semantic Reasoning** — Goes beyond summarization to infer hidden structure and bridge concepts
- **Self-Validating Pipeline** — Quality scoring with automatic refinement loops
- **Interactive Graph** — React Flow powered with dagre auto-layout, minimap, and node drawer
- **Export** — PNG, JSON, and self-contained HTML (works offline forever)
- **Rate Limit Handling** — 3 retries with 15s delay on 429/5xx errors
- **Large Input Support** — Automatic chunking for long documents
- **Truncated JSON Recovery** — Gracefully handles LLM output truncation with multi-strategy repair
- **Mobile Responsive** — Tabbed interface on small screens
- **Dark Obsidian Theme** — Monospace, neon accents, animated edges

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/zazikant/atomic-graph&env=NVIDIA_API_KEY)

### One Environment Variable

Set `NVIDIA_API_KEY` in your Vercel project's **Settings → Environment Variables**.

Get your API key at [build.nvidia.com](https://build.nvidia.com/).

That's it — no other configuration needed.

## Local Development

```bash
# Clone
git clone https://github.com/zazikant/atomic-graph.git
cd atomic-graph

# Install
npm install

# Set your API key
cp .env.example .env
# Edit .env and add your NVIDIA_API_KEY

# Run
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Architecture

```
Browser → /api/nvidia (Next.js API proxy) → Nvidia NIM API
```

- The API proxy bypasses CORS and handles retries server-side
- `NVIDIA_API_KEY` is resolved: client override → server env var
- The DSPy-style AX Pipeline runs entirely client-side, calling the proxy for each step

## Tech Stack

- **Next.js 16** — App Router with API proxy
- **React Flow v12** — Interactive graph visualization
- **Dagre** — Automatic graph layout
- **Zustand** — State management
- **Tailwind CSS 4** — Styling
- **Nvidia NIM** — AI inference (GPT-OSS 120B)

## License

MIT
