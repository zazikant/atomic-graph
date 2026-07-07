import { NextRequest, NextResponse } from "next/server";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

/**
 * Server-side proxy for Nvidia NIM API.
 *
 * Why: The browser blocks direct requests to integrate.api.nvidia.com
 * due to CORS (no Access-Control-Allow-Origin header). This API route
 * forwards requests from the browser to Nvidia's servers, bypassing CORS.
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

    // Forward the request to Nvidia NIM API
    const nvidiaResponse = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: temperature ?? 0.7,
        max_tokens: max_tokens ?? 4096,
        stream: false,
      }),
    });

    if (!nvidiaResponse.ok) {
      const errorText = await nvidiaResponse.text().catch(() => "Unknown error");
      console.error(`Nvidia API error (${nvidiaResponse.status}):`, errorText);
      return NextResponse.json(
        {
          error: `Nvidia API error (${nvidiaResponse.status})`,
          details: errorText.slice(0, 500),
        },
        { status: nvidiaResponse.status }
      );
    }

    const data = await nvidiaResponse.json();

    // Handle reasoning models: prefer content, fall back to reasoning_content
    const message = data.choices?.[0]?.message;
    if (message && !message.content && message.reasoning_content) {
      message.content = message.reasoning_content;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Proxy error:", error);
    return NextResponse.json(
      {
        error: "Internal proxy error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
