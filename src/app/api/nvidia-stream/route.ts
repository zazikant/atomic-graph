import { NextRequest } from "next/server";

/**
 * Streaming NVIDIA proxy (Server-Sent Events).
 *
 * POST /api/nvidia-stream
 *   { apiKey?, model, messages, temperature?, max_tokens? }
 *
 * Response: text/event-stream
 *   data: {"type":"stage-start","stage":"llm-call","ts":...}
 *   data: {"type":"log","line":"[nvidia] start  model=openai/gpt-oss-120b ...","ts":...}
 *   data: {"type":"chunk","text":"...","ts":...}           // live tokens
 *   data: {"type":"log","line":"[nvidia] ttfb=523ms done ...","ts":...}
 *   data: {"type":"stage-end","stage":"llm-call","elapsedMs":1234,"ok":true,"content":"...","ts":...}
 *   data: {"type":"error","message":"...","ts":...}
 *
 * Each LLM call is a "controlled call":
 *   - 12s per-call hard timeout (gpt-oss-120b on Vercel Edge can take 8-15s TTFB;
 *     12s is the sweet spot — gives slow calls room, fails fast on hangs)
 *   - Up to 2 attempts (1 retry) with 500ms backoff
 *   - Structured logs at start / ttfb / done / timeout / retry / error
 *
 * Edge runtime: required because Vercel Node serverless path silently hangs on
 * gpt-oss-120b (confirmed via /api/debug on ax-translator). Edge uses a different
 * egress that works for gpt-oss-120b (60-70% success rate observed).
 *
 * The SSE stream flushes chunks as they arrive, so the browser sees live tokens
 * + structured logs instead of a 60s silent spinner.
 */
export const maxDuration = 30; // Edge runtime cap on Vercel Hobby
export const dynamic = "force-dynamic";
export const runtime = "edge";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
// Per-call timeout: 18s.
// gpt-oss-120b on Vercel Edge can take 8-15s TTFB for larger JSON outputs
// (LINK step returns 5-15 edges with labels + strengths — bigger than
// EXTRACT node titles). 12s was too tight and caused LINK to time out
// silently, producing graphs with nodes but no edges.
//
// 1 attempt only (was 2): 18s + 500ms backoff + 18s = 36.5s exceeds
// Edge's 30s cap. With 1 attempt we stay safely under 30s. Pipeline-level
// retry in axPipeline.ts handles the second attempt instead.
const CALL_TIMEOUT_MS = 18_000;
const MAX_ATTEMPTS = 1;

interface SSEEvent {
  type: string;
  [k: string]: unknown;
}

function sse(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

interface StreamCallParams {
  apiKey: string;
  model: string;
  messages: { role: string; content: string }[];
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
  onChunk: (text: string) => void;
}

/**
 * Stream a single chat completion from NVIDIA, accumulating chunks.
 * Throws on timeout or HTTP error.
 */
async function streamOnce({
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  signal,
  onChunk,
}: StreamCallParams): Promise<{ content: string; reasoning: string; ttfbMs: number | null }> {
  const callStart = Date.now();
  const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`NVIDIA API error (${response.status}): ${errText.slice(0, 300)}`);
  }
  if (!response.body) {
    throw new Error("NVIDIA API returned no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let ttfbMs: number | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfbMs === null) ttfbMs = Date.now() - callStart;

    buffer += decoder.decode(value, { stream: true });
    let nlIdx;
    while ((nlIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        return { content, reasoning, ttfbMs };
      }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (delta) {
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            onChunk(delta.content);
          }
          if (typeof delta.reasoning_content === "string") {
            reasoning += delta.reasoning_content;
          }
        }
      } catch {
        // Partial JSON across chunks — wait for more bytes.
      }
    }
  }

  // Reasoning models may put final output in reasoning_content if max_tokens
  // was hit during reasoning. If content is empty but reasoning has data,
  // treat reasoning as content (matches existing NvidiaClient behavior).
  if (!content && reasoning) {
    content = reasoning;
    onChunk(content);
  }

  return { content, reasoning, ttfbMs };
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, model, messages, temperature, max_tokens } = body;

  const resolvedApiKey = apiKey || process.env.NVIDIA_API_KEY;

  if (!resolvedApiKey) {
    return new Response(
      JSON.stringify({
        error:
          "API key is required. Set NVIDIA_API_KEY env var on the server, or pass apiKey in the request body.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!model) {
    return new Response(JSON.stringify({ error: "Model is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: "Messages array is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: SSEEvent) => {
        try {
          controller.enqueue(encoder.encode(sse({ ...event, ts: Date.now() })));
        } catch {
          // Controller may be closed if client disconnected.
        }
      };

      emit({ type: "stage-start", stage: "llm-call" });
      emit({
        type: "log",
        line: `[nvidia] start  model=${model} max_tokens=${max_tokens ?? 32768} temp=${temperature ?? 0.7} timeout=${CALL_TIMEOUT_MS}ms`,
      });

      const callStart = Date.now();
      let lastErr: Error | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller2 = new AbortController();
        const timeout = setTimeout(() => controller2.abort(), CALL_TIMEOUT_MS);

        try {
          const { content, reasoning, ttfbMs } = await streamOnce({
            apiKey: resolvedApiKey,
            model,
            messages,
            temperature: temperature ?? 0.7,
            maxTokens: max_tokens ?? 32768,
            signal: controller2.signal,
            onChunk: (text) => emit({ type: "chunk", text }),
          });
          clearTimeout(timeout);

          const elapsed = Date.now() - callStart;
          emit({
            type: "log",
            line: `[nvidia] ttfb=${ttfbMs ?? "n/a"}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${content.length} reasoning_chars=${reasoning.length}`,
          });

          if (!content) {
            throw new Error(
              `empty content (reasoning_chars=${reasoning.length}, finish_reason may be "length" — increase max_tokens)`,
            );
          }

          emit({
            type: "stage-end",
            stage: "llm-call",
            elapsedMs: elapsed,
            ok: true,
            content,
            attempts: attempt,
          });
          try {
            controller.close();
          } catch {
            // already closed
          }
          return;
        } catch (err: unknown) {
          clearTimeout(timeout);
          const e = err as Error;
          const elapsed = Date.now() - callStart;
          lastErr = e;
          if (e.name === "AbortError") {
            emit({ type: "log", line: `[nvidia] TIMEOUT attempt=${attempt} after ${CALL_TIMEOUT_MS}ms` });
          } else {
            emit({
              type: "log",
              line: `[nvidia] ERROR attempt=${attempt} after ${elapsed}ms: ${e.name}: ${e.message.slice(0, 200)}`,
            });
          }
          if (attempt < MAX_ATTEMPTS) {
            const backoff = 500 * attempt;
            emit({ type: "log", line: `[nvidia] retry  backing off ${backoff}ms before attempt ${attempt + 1}` });
            await new Promise((r) => setTimeout(r, backoff));
          }
        }
      }

      const elapsed = Date.now() - callStart;
      const finalErr = lastErr ?? new Error("unknown error");
      const msg = `NVIDIA call failed after ${MAX_ATTEMPTS} attempts (${elapsed}ms): ${finalErr.name}: ${finalErr.message}`;
      emit({
        type: "stage-end",
        stage: "llm-call",
        elapsedMs: elapsed,
        ok: false,
        attempts: MAX_ATTEMPTS,
      });
      emit({ type: "error", message: msg });
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
