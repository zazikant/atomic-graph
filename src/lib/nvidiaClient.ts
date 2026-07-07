import type { NvidiaModel } from "./types";

const BASE_URL = "https://integrate.api.nvidia.com/v1";

/**
 * Nvidia NIM API wrapper — OpenAI-compatible endpoint.
 * All calls are made directly from the browser to Nvidia's servers.
 * The API key is never sent to any other server.
 */
export class NvidiaClient {
  private apiKey: string;
  private model: NvidiaModel;

  constructor(apiKey: string, model: NvidiaModel) {
    this.apiKey = apiKey;
    this.model = model;
  }

  updateConfig(apiKey: string, model: NvidiaModel) {
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * Send a chat completion request that forces strict JSON output.
   * The system prompt enforces JSON-only responses.
   */
  async chat(userPrompt: string, systemPrompt?: string): Promise<string> {
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    messages.push({ role: "user", content: userPrompt });

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.2,
        top_p: 0.7,
        max_tokens: 4096,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Nvidia API error (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();

    if (!data.choices?.[0]?.message?.content) {
      throw new Error("Nvidia API returned an empty response");
    }

    return data.choices[0].message.content as string;
  }

  /**
   * Call the LLM and attempt to parse the response as JSON.
   * Handles common LLM output quirks (markdown code blocks, extra text).
   */
  async chatJSON<T>(userPrompt: string, systemPrompt?: string): Promise<T> {
    const raw = await this.chat(userPrompt, systemPrompt);
    return parseLLMJson<T>(raw);
  }
}

/**
 * Robust JSON parser for LLM outputs.
 * Strips markdown code fences and extracts JSON objects.
 */
export function parseLLMJson<T>(raw: string): T {
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  let cleaned = raw.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try to find a JSON object or array in the response
  const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    cleaned = jsonMatch[1];
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    // Last resort: try to fix common issues like trailing commas
    const fixed = cleaned.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(fixed) as T;
    } catch {
      throw new Error(
        `Failed to parse LLM JSON response: ${(e as Error).message}\nRaw: ${raw.slice(0, 500)}`
      );
    }
  }
}
