import type { NvidiaModel } from "./types";

const BASE_URL = "https://integrate.api.nvidia.com/v1";

/**
 * Nvidia NIM API wrapper — OpenAI-compatible endpoint.
 * Matches the pattern from the user's OpenAI SDK example:
 *   baseURL: 'https://integrate.api.nvidia.com/v1'
 *   model: 'openai/gpt-oss-120b'
 *
 * Handles reasoning models (GPT-OSS 120B) that return output
 * in `reasoning_content` instead of `content`.
 *
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
   * Uses temperature=0.7 and max_tokens=4096 (reasoning models need
   * more tokens because chain-of-thought eats into the budget).
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
        temperature: 0.7,
        max_tokens: 4096,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Nvidia API error (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;

    if (!message) {
      throw new Error("Nvidia API returned no message in response");
    }

    // Reasoning models (e.g. GPT-OSS 120B) may put the actual output
    // in `reasoning_content` when `content` is null.
    // Priority: content → reasoning_content → throw error
    const content = message.content || message.reasoning_content;

    if (!content) {
      throw new Error(
        "Nvidia API returned an empty response (both content and reasoning_content are null)"
      );
    }

    return content as string;
  }

  /**
   * Call the LLM and attempt to parse the response as JSON.
   * Handles common LLM output quirks (markdown code blocks, extra text,
   * reasoning model outputs that may include chain-of-thought before JSON).
   */
  async chatJSON<T>(userPrompt: string, systemPrompt?: string): Promise<T> {
    const raw = await this.chat(userPrompt, systemPrompt);
    return parseLLMJson<T>(raw);
  }
}

/**
 * Robust JSON parser for LLM outputs.
 * Strips markdown code fences, extracts JSON objects,
 * and handles reasoning model outputs that may contain
 * chain-of-thought text before/after the JSON.
 */
export function parseLLMJson<T>(raw: string): T {
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  let cleaned = raw.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try to find a JSON object or array in the response
  // (reasoning models may have text before/after the JSON)
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
