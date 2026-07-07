import { NextRequest, NextResponse } from "next/server";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

// Edge runtime — Vercel's Node serverless path silently hangs on
// openai/gpt-oss-120b (confirmed via extensive testing on the sister
// project ax-translator). Edge uses a different egress that works for
// gpt-oss-120b. Streaming (stream:true + drain) is required because
// gpt-oss-120b emits a long reasoning_content buffer before the final
// answer, and Vercel's fetch appears to hold non-streamed responses
// until the entire payload is ready.
export const maxDuration = 30;
export const runtime = "edge";
export const dynamic = "force-dynamic";

// ─── API Key Resolution ─────────────────────────────────────
// Priority: client-provided key > NVIDIA_API_KEY env var
// For Vercel deployment: set NVIDIA_API_KEY in your project's
// Environment Variables dashboard and no client config is needed.

// ─── Retry Configuration ────────────────────────────────────
// Edge runtime cap is 30s. With 2s backoff × 2 retries we still leave
// room for one full NVIDIA call (~5-10s on gpt-oss-120b).
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2_000;

/**
 * Status codes that warrant a retry (transient / rate-limit errors).
 * - 429: Rate limited
 * - 500: Internal server error (may be transient)
 * - 502: Bad gateway
 * - 503: Service unavailable
 * - 504: Gateway timeout
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Human-readable label for common NVIDIA API error codes.
 */
function describeStatus(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request — the prompt or parameters are invalid";
    case 401:
      return "Unauthorized — check your API key";
    case 403:
      return "Forbidden — your API key does not have access to this model";
    case 404:
      return "Not Found — the model endpoint does not exist";
    case 429:
      return "Rate Limited — too many requests, retrying…";
    case 500:
      return "Server Error — Nvidia experienced an internal error";
    case 502:
      return "Bad Gateway — Nvidia's upstream is unreachable";
    case 503:
      return "Service Unavailable — Nvidia is temporarily offline";
    case 504:
      return "Gateway Timeout — Nvidia took too long to respond";
    default:
      return `HTTP ${status}`;
  }
}

/**
 * Drain a streamed chat completion from NVIDIA and reconstruct a
 * chat.completion-shaped JSON object so existing client code
 * (which expects response.choices[0].message.content) keeps working.
 *
 * Reasoning models (e.g. GPT-OSS 120B) sometimes put the actual output
 * in `reasoning_content` when `content` is empty (e.g. when max_tokens
 * was hit during reasoning). We fall back to reasoning_content.
 */
async function drainStreamToCompletion(
  response: Response,
  modelEcho: string,
): Promise<Record<string, unknown>> {
  if (!response.body) {
    throw new Error("NVIDIA API returned no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nlIdx;
    while ((nlIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        if (json.model) modelEcho = json.model;
        const delta = json.choices?.[0]?.delta;
        const fr = json.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
        if (delta) {
          if (typeof delta.content === "string") content += delta.content;
          if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        }
      } catch {
        // partial JSON across chunks
      }
    }
  }

  const finalContent = content || reasoning || "";

  return {
    id: `chatcmpl-edge-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelEcho,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: finalContent,
          reasoning_content: reasoning || null,
        },
        finish_reason: finishReason || "stop",
      },
    ],
    usage: null,
  };
}

/**
 * Server-side proxy for Nvidia NIM API.
 *
 * Why: The browser blocks direct requests to integrate.api.nvidia.com
 * due to CORS (no Access-Control-Allow-Origin header). This API route
 * forwards requests from the browser to Nvidia's servers, bypassing CORS.
 *
 * Features:
 * - Retry up to 2 times on transient errors (429, 5xx) with 2-second delay
 * - Streams the response from NVIDIA and reconstructs chat.completion JSON
 * - Graceful error handling with descriptive messages
 * - Passes through retry metadata so the client can display status
 *
 * The API key is sent from the browser to this route (same origin),
 * then forwarded to Nvidia. No other server receives the key.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { apiKey, model, messages, temperature, max_tokens } = body;

    // Resolve API key: client override > server env var
    const effectiveApiKey = apiKey || process.env.NVIDIA_API_KEY;

    if (!effectiveApiKey) {
      return NextResponse.json(
        { error: "API key is required. Set NVIDIA_API_KEY environment variable or provide it in the UI." },
        { status: 400 }
      );
    }

    if (!model) {
      return NextResponse.json(
        { error: "Model is required" },
        { status: 400 }
      );
    }

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: "Messages array is required" },
        { status: 400 }
      );
    }

    const requestBody = JSON.stringify({
      model,
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 32768,
      stream: true, // Streaming required — gpt-oss-120b hangs on Vercel with stream:false
    });

    // ─── Retry Loop ───────────────────────────────────────────
    let lastError: string | null = null;
    let lastStatus = 0;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let nvidiaResponse: Response;

      try {
        nvidiaResponse = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${effectiveApiKey}`,
            Accept: "text/event-stream",
          },
          body: requestBody,
        });
      } catch (fetchError) {
        // Network-level error (DNS, timeout, connection refused)
        const msg =
          fetchError instanceof Error
            ? fetchError.message
            : "Network error contacting Nvidia API";

        lastError = `Network error: ${msg}`;
        lastStatus = 0;

        if (attempt < MAX_RETRIES) {
          console.warn(
            `[Nvidia Proxy] Attempt ${attempt}/${MAX_RETRIES} failed — ${msg}. Retrying in ${RETRY_DELAY_MS / 1000}s…`
          );
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        break;
      }

      // ─── Success ───────────────────────────────────────────
      if (nvidiaResponse.ok) {
        const data = await drainStreamToCompletion(nvidiaResponse, model);

        // Attach retry metadata (useful for client awareness)
        if (attempt > 1) {
          data._retryMeta = {
            attempts: attempt,
            succeeded: true,
          };
        }

        return NextResponse.json(data);
      }

      // ─── Non-retryable error — return immediately ──────────
      const errorText = await nvidiaResponse.text().catch(() => "Unknown error");
      lastStatus = nvidiaResponse.status;
      lastError = errorText.slice(0, 500);

      if (!RETRYABLE_STATUS_CODES.has(nvidiaResponse.status)) {
        // Client errors (400, 401, 403, 404) — retrying won't help
        console.error(
          `[Nvidia Proxy] Non-retryable error (${nvidiaResponse.status}): ${lastError}`
        );
        return NextResponse.json(
          {
            error: describeStatus(nvidiaResponse.status),
            details: lastError,
            retryable: false,
          },
          { status: nvidiaResponse.status }
        );
      }

      // ─── Retryable error ───────────────────────────────────
      console.warn(
        `[Nvidia Proxy] Attempt ${attempt}/${MAX_RETRIES} — ${describeStatus(nvidiaResponse.status)}. ${
          attempt < MAX_RETRIES
            ? `Retrying in ${RETRY_DELAY_MS / 1000}s…`
            : "No more retries."
        }`
      );

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }

    // ─── All retries exhausted ───────────────────────────────
    return NextResponse.json(
      {
        error: lastStatus
          ? `${describeStatus(lastStatus)} — all ${MAX_RETRIES} attempts failed`
          : `Network error — all ${MAX_RETRIES} attempts failed`,
        details: lastError,
        retryable: true,
        attemptsExhausted: true,
      },
      { status: lastStatus || 502 }
    );
  } catch (error) {
    console.error("[Nvidia Proxy] Internal error:", error);
    return NextResponse.json(
      {
        error: "Internal proxy error",
        details: error instanceof Error ? error.message : "Unknown error",
        retryable: false,
      },
      { status: 500 }
    );
  }
}
