import { NextRequest } from "next/server";

/**
 * Streaming NVIDIA proxy (Server-Sent Events) with auto-continue.
 *
 * POST /api/nvidia-stream
 *   { apiKey?, model, messages, temperature?, max_tokens? }
 *
 * Response: text/event-stream
 *   data: {"type":"stage-start","stage":"llm-call","ts":...}
 *   data: {"type":"log","line":"[nvidia] start  model=openai/gpt-oss-20b ...","ts":...}
 *   data: {"type":"chunk","text":"...","ts":...}           // live tokens
 *   data: {"type":"log","line":"[nvidia] continue  round=1/3 ...","ts":...}
 *   data: {"type":"chunk","text":"...","ts":...}           // continuation tokens
 *   data: {"type":"log","line":"[nvidia] done  continuations=1 ...","ts":...}
 *   data: {"type":"stage-end","stage":"llm-call","elapsedMs":1234,"ok":true,"content":"...","continuations":1,"truncated":false,"ts":...}
 *   data: {"type":"error","message":"...","ts":...}
 *
 * Each LLM call is a "controlled call":
 *   - 120s per-call hard timeout. gpt-oss on Vercel Edge can take 8-15s
 *     TTFB for larger outputs; 120s gives the model comfortable room.
 *     On Hobby Vercel kills the function at 30s first, so the effective
 *     budget is the 30s cap regardless.
 *   - 1 attempt per round (pipeline-level retry handled by caller)
 *   - Structured logs at start / ttfb / done / timeout / retry / error
 *
 * Auto-continue on truncation:
 *   When the model returns `finish_reason: "length"` (hit max_tokens
 *   mid-generation), we automatically send another call with the partial
 *   output appended as an assistant message + a generic "continue from
 *   where you left off" user prompt, then concatenate. The browser sees
 *   continuous token streaming with no visible boundary between the
 *   original call and continuation(s). Capped at maxContinuations (default 3).
 *   This is especially important for JSON output (knowledge graphs) where
 *   truncation produces partial, unparseable JSON.
 *
 * Edge runtime: required because Vercel Node serverless path silently hangs on
 * gpt-oss models (confirmed via /api/debug on ax-translator). Edge uses a
 * different egress that works.
 *
 * The SSE stream flushes chunks as they arrive, so the browser sees live tokens
 * + structured logs instead of a 60s silent spinner.
 */
export const maxDuration = 30; // Edge runtime cap on Vercel Hobby
export const dynamic = "force-dynamic";
export const runtime = "edge";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
// Per-call timeout: 120s. Matches ax-translator's DEFAULT_CALL_TIMEOUT_MS.
// On Hobby Vercel Edge still kills the function at 30s, so 120s is a dead
// ceiling there. On Pro (300s Edge cap) this gives the model comfortable room.
const CALL_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 1;
// Max auto-continue rounds when the model returns finish_reason === 'length'.
// Each round re-calls the model with the partial output appended as an
// assistant message, asking it to continue. 3 rounds gives up to 4 total
// calls × max_tokens each of effective output capacity.
const DEFAULT_MAX_CONTINUATIONS = 3;

// Generic continuation prompt used when the model returns finish_reason:'length'.
// This does NOT modify the caller's system/user prompts — it's a fixed
// instruction appended only when a continuation round is needed. Works for
// both free-form text AND JSON output: the model sees its partial output
// in the assistant message and continues from exactly where it left off.
const CONTINUE_USER_PROMPT =
  'Continue your previous response from exactly where you left off. Do not repeat any text you have already produced. Do not add any preamble, acknowledgements, or summary — output only the continuation.';

interface SSEEvent {
  type: string;
  [k: string]: unknown;
}

function sse(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Determines if an error is retryable (timeout, rate limit, or server error).
 * Ported from ax-translator/src/lib/nvidia-client.ts.
 */
function isRetryableError(err: any): boolean {
  const status = err?.status || err?.statusCode || 0;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code)) return true;
  const errName: string = err?.constructor?.name || '';
  if (['APIConnectionError', 'APITimeoutError', 'ConnectionError'].includes(errName)) return true;
  const msg: string = (err?.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('econnreset')) return true;
  return false;
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

interface StreamOnceResult {
  content: string;
  reasoning: string;
  ttfbMs: number | null;
  /**
   * finish_reason from the model:
   *   'stop'       — model finished naturally (clean stop)
   *   'length'     — model hit max_tokens mid-generation (output truncated)
   *   'content_filter' / 'tool_calls' / undefined — other terminal states
   *
   * We use 'length' to trigger an auto-continue call so the user sees the
   * full output instead of a truncated response.
   */
  finishReason: string | null;
}

/**
 * Stream a single chat completion from NVIDIA, accumulating chunks.
 * Throws on timeout or HTTP error. The thrown error carries `.status`
 * so the caller's retry loop can decide retryability via isRetryableError.
 */
async function streamOnce({
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  signal,
  onChunk,
}: StreamCallParams): Promise<StreamOnceResult> {
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
    const err: any = new Error(`NVIDIA API error (${response.status}): ${errText.slice(0, 300)}`);
    err.status = response.status;
    throw err;
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
  let finishReason: string | null = null;

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
        // Reasoning models may put final output in reasoning_content if
        // max_tokens was hit during reasoning. If content is empty but
        // reasoning has data, treat reasoning as content.
        if (!content && reasoning) {
          content = reasoning;
          onChunk(content);
        }
        return { content, reasoning, ttfbMs, finishReason };
      }
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            onChunk(delta.content);
          }
          if (typeof delta.reasoning_content === "string") {
            reasoning += delta.reasoning_content;
          }
        }
        // Capture finish_reason as soon as it appears. NVIDIA's SSE stream
        // emits it on the final chunk BEFORE [DONE]. We need it to decide
        // whether to auto-continue (see POST handler below).
        if (choice && typeof choice.finish_reason === "string" && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      } catch {
        // Partial JSON across chunks — wait for more bytes.
      }
    }
  }

  // Stream ended without an explicit [DONE]. Apply the same reasoning
  // fallback in case the model finished on a reasoning-only flush.
  if (!content && reasoning) {
    content = reasoning;
    onChunk(content);
  }
  return { content, reasoning, ttfbMs, finishReason };
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

  const effectiveMaxTokens = max_tokens ?? 32768;
  const maxContinuations = DEFAULT_MAX_CONTINUATIONS;

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
        line: `[nvidia] start  model=${model} max_tokens=${effectiveMaxTokens} temp=${temperature ?? 0.7} timeout=${CALL_TIMEOUT_MS}ms max_continuations=${maxContinuations}`,
      });

      const callStart = Date.now();
      let fullContent = "";
      let fullReasoning = "";
      let attemptsUsed = 0;
      let continuations = 0;
      let stillTruncated = false;
      let lastErr: Error | null = null;
      let fatal = false;

      // The messages array may grow across continuation rounds: each round
      // appends the assistant's partial output + the generic continue prompt.
      let roundMessages = messages;

      // Loop: original call (round 0) + up to maxContinuations continuation rounds.
      for (let round = 0; round <= maxContinuations && !fatal; round++) {
        let roundResult: StreamOnceResult | null = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const controller2 = new AbortController();
          const timeout = setTimeout(() => controller2.abort(), CALL_TIMEOUT_MS);

          try {
            const result = await streamOnce({
              apiKey: resolvedApiKey,
              model,
              messages: roundMessages,
              temperature: temperature ?? 0.7,
              maxTokens: effectiveMaxTokens,
              signal: controller2.signal,
              onChunk: (text) => emit({ type: "chunk", text }),
            });
            clearTimeout(timeout);
            attemptsUsed++;
            roundResult = result;

            const elapsed = Date.now() - callStart;
            emit({
              type: "log",
              line: `[nvidia] round=${round} done  ttfb=${result.ttfbMs ?? "n/a"}ms elapsed=${elapsed}ms content_chars=${result.content.length} (total=${fullContent.length + result.content.length}) finish_reason=${result.finishReason ?? "n/a"}`,
            });
            break;
          } catch (err: unknown) {
            clearTimeout(timeout);
            const e = err as Error;
            const elapsed = Date.now() - callStart;
            lastErr = e;
            if (e.name === "AbortError") {
              emit({ type: "log", line: `[nvidia] TIMEOUT round=${round} attempt=${attempt} after ${CALL_TIMEOUT_MS}ms` });
            } else {
              emit({
                type: "log",
                line: `[nvidia] ERROR round=${round} attempt=${attempt} after ${elapsed}ms: ${e.name}: ${e.message.slice(0, 200)}`,
              });
            }
            // Non-retryable errors surface immediately.
            if (!isRetryableError(e)) {
              fatal = true;
              break;
            }
          }
        }

        if (!roundResult) {
          break; // error or fatal — exit continuation loop
        }

        // Accumulate content/reasoning across rounds.
        fullContent += roundResult.content;
        fullReasoning += roundResult.reasoning;

        if (roundResult.finishReason !== "length") {
          // Model finished naturally — no continuation needed.
          stillTruncated = false;
          break;
        }

        // finish_reason === 'length' → output was truncated.
        // If we have continuation budget left, append the partial output as
        // an assistant message + the generic continue prompt, and loop again.
        if (round >= maxContinuations || !roundResult.content) {
          stillTruncated = true;
          emit({
            type: "log",
            line: `[nvidia] TRUNCATED after ${round + 1} round(s) — exhausted maxContinuations=${maxContinuations}. Output ends mid-structure.`,
          });
          break;
        }

        continuations++;
        emit({
          type: "log",
          line: `[nvidia] continue  round=${round + 1}/${maxContinuations} — model hit max_tokens, resuming from char ${fullContent.length}`,
        });

        // Build the next round's messages: original + assistant's partial + continue prompt.
        roundMessages = [
          ...messages,
          { role: "assistant", content: roundResult.content },
          { role: "user", content: CONTINUE_USER_PROMPT },
        ];
      }

      const elapsed = Date.now() - callStart;

      if (!fullContent) {
        const finalErr = lastErr ?? new Error("unknown error");
        const msg = `NVIDIA call failed (${elapsed}ms): ${finalErr.name}: ${finalErr.message}`;
        emit({
          type: "stage-end",
          stage: "llm-call",
          elapsedMs: elapsed,
          ok: false,
          attempts: attemptsUsed,
        });
        emit({ type: "error", message: msg });
        try { controller.close(); } catch { /* already closed */ }
        return;
      }

      emit({
        type: "log",
        line: `[nvidia] done   elapsed=${elapsed}ms content_chars=${fullContent.length} reasoning_chars=${fullReasoning.length} attempts=${attemptsUsed} continuations=${continuations} truncated=${stillTruncated}`,
      });

      emit({
        type: "stage-end",
        stage: "llm-call",
        elapsedMs: elapsed,
        ok: true,
        content: fullContent,
        attempts: attemptsUsed,
        continuations,
        truncated: stillTruncated,
      });
      try { controller.close(); } catch { /* already closed */ }
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
