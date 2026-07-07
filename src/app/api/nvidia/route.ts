import { NextRequest, NextResponse } from "next/server";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

// ─── Retry Configuration ────────────────────────────────────
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 15_000; // 15 seconds between retry attempts

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
 * Server-side proxy for Nvidia NIM API.
 *
 * Why: The browser blocks direct requests to integrate.api.nvidia.com
 * due to CORS (no Access-Control-Allow-Origin header). This API route
 * forwards requests from the browser to Nvidia's servers, bypassing CORS.
 *
 * Features:
 * - Retry up to 3 times on transient errors (429, 5xx) with 15-second delay
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

    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
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
      max_tokens: max_tokens ?? 16384,
      stream: false,
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
            Authorization: `Bearer ${apiKey}`,
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
        const data = await nvidiaResponse.json();

        // Handle reasoning models: prefer content, fall back to reasoning_content
        const message = data.choices?.[0]?.message;
        if (message && !message.content && message.reasoning_content) {
          message.content = message.reasoning_content;
        }

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
