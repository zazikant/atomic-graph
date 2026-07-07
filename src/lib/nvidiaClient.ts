import type { NvidiaModel } from "./types";

/**
 * Nvidia NIM API wrapper — routes through our Next.js proxy
 * to avoid browser CORS restrictions.
 *
 * Flow: Browser → /api/nvidia (same origin) → integrate.api.nvidia.com
 *
 * The API key is sent from the browser to our proxy only,
 * then forwarded to Nvidia. No other server receives it.
 *
 * The proxy handles retry logic (3 attempts, 15s delay) for rate limits
 * and transient errors. This client surfaces retry info and handles
 * rejections gracefully with user-friendly messages.
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
   * Send a chat completion request through our server-side proxy.
   * The proxy forwards to Nvidia NIM API, bypassing CORS.
   * Handles reasoning models that return output in reasoning_content.
   *
   * The proxy retries up to 3 times on 429/5xx errors with 15s delay.
   * If all retries are exhausted, throws a descriptive error.
   */
  async chat(userPrompt: string, systemPrompt?: string): Promise<string> {
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    messages.push({ role: "user", content: userPrompt });

    const response = await fetch("/api/nvidia", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiKey: this.apiKey,
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 16384,
      }),
    });

    if (!response.ok) {
      let errorMsg = `API error (${response.status})`;
      let retryable = false;
      let attemptsExhausted = false;

      try {
        const errBody = await response.json();
        errorMsg = errBody.error || errBody.details || errorMsg;
        retryable = errBody.retryable ?? false;
        attemptsExhausted = errBody.attemptsExhausted ?? false;
      } catch {
        // couldn't parse error body
      }

      // Provide user-friendly error messages based on common scenarios
      if (attemptsExhausted) {
        throw new Error(
          `Nvidia API rate limit reached — all 3 retry attempts failed after 15-second delays. Please wait a moment and try again.`
        );
      }

      if (response.status === 401) {
        throw new Error(
          "Invalid API key. Please check your Nvidia API key in the config bar and try again."
        );
      }

      if (response.status === 403) {
        throw new Error(
          "Access denied — your API key does not have permission to use this model. Check your Nvidia account permissions."
        );
      }

      if (response.status === 429) {
        throw new Error(
          "Rate limited by Nvidia — too many requests. Please wait a moment before trying again."
        );
      }

      if (response.status >= 500) {
        throw new Error(
          `Nvidia server error (${response.status}): ${errorMsg}. This is usually temporary — try again in a moment.`
        );
      }

      throw new Error(errorMsg);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;

    if (!message) {
      throw new Error("Nvidia API returned no message in response");
    }

    // Reasoning models (e.g. GPT-OSS 120B) may put the actual output
    // in `reasoning_content` when `content` is null.
    // The proxy already handles this, but double-check here too.
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
   * If parsing fails due to truncation, retries once with a prompt
   * requesting shorter output.
   */
  async chatJSON<T>(userPrompt: string, systemPrompt?: string): Promise<T> {
    const raw = await this.chat(userPrompt, systemPrompt);
    try {
      return parseLLMJson<T>(raw);
    } catch (parseError) {
      // If the response was truncated (common with reasoning models),
      // try to recover what we can rather than failing entirely.
      const recovered = recoverTruncatedJSON<T>(raw);
      if (recovered !== null) {
        console.warn('[NvidiaClient] Recovered truncated JSON response');
        return recovered;
      }
      throw parseError;
    }
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

/**
 * Attempt to recover useful data from a truncated JSON response.
 *
 * Reasoning models (like GPT-OSS 120B) can produce very long responses
 * that get cut off mid-JSON when max_tokens is reached. This function
 * tries to close open brackets and parse what was returned.
 *
 * Recovery strategies:
 * 1. Find the deepest complete array/object and close all open brackets
 * 2. For nodes arrays: return whatever nodes were fully written
 * 3. For edges arrays: return whatever edges were fully written
 */
export function recoverTruncatedJSON<T>(raw: string): T | null {
  let cleaned = raw.trim();

  // Strip markdown code fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Extract JSON-like content
  const jsonStart = cleaned.search(/\{/);
  if (jsonStart === -1) return null;
  cleaned = cleaned.slice(jsonStart);

  // Strategy 1: Try to close open brackets progressively
  // Count open vs close brackets
  const opens = { curly: 0, square: 0 };
  for (const ch of cleaned) {
    if (ch === "{") opens.curly++;
    else if (ch === "}") opens.curly--;
    else if (ch === "[") opens.square++;
    else if (ch === "]") opens.square--;
  }

  // Try appending closing brackets
  let attempt = cleaned;

  // First remove any trailing incomplete content (partial string, etc.)
  // Find the last complete value in the JSON
  attempt = attempt.replace(/,\s*$/, ""); // Remove trailing comma
  attempt = attempt.replace(/"[^"]*$/, ""); // Remove incomplete string
  attempt = attempt.replace(/:\s*$/, ""); // Remove trailing key with no value
  attempt = attempt.replace(/,\s*"[^"]*"?\s*:\s*$/, ""); // Remove trailing key-value pair start

  // Close open brackets
  for (let i = 0; i < opens.square; i++) attempt += "]";
  for (let i = 0; i < opens.curly; i++) attempt += "}";

  try {
    return JSON.parse(attempt) as T;
  } catch {
    // Strategy 2: Find the last complete object in the top-level arrays
    // and close around it
    try {
      const result: Record<string, unknown> = {};

      // Try to recover "nodes" array
      const nodesMatch = cleaned.match(/"nodes"\s*:\s*\[/);
      if (nodesMatch) {
        const nodesStart = cleaned.indexOf("[", cleaned.indexOf('"nodes"'));
        const recoveredNodes = recoverArrayElements(cleaned, nodesStart);
        if (recoveredNodes && recoveredNodes.length > 0) {
          result.nodes = recoveredNodes;
        }
      }

      // Try to recover "edges" array
      const edgesMatch = cleaned.match(/"edges"\s*:\s*\[/);
      if (edgesMatch) {
        const edgesStart = cleaned.indexOf("[", cleaned.indexOf('"edges"'));
        const recoveredEdges = recoverArrayElements(cleaned, edgesStart);
        if (recoveredEdges && recoveredEdges.length > 0) {
          result.edges = recoveredEdges;
        }
      }

      // Try to recover "score"
      const scoreMatch = cleaned.match(/"score"\s*:\s*([\d.]+)/);
      if (scoreMatch) {
        result.score = parseFloat(scoreMatch[1]);
      }

      // Try to recover "issues"
      const issuesMatch = cleaned.match(/"issues"\s*:\s*\[/);
      if (issuesMatch) {
        const issuesStart = cleaned.indexOf("[", cleaned.indexOf('"issues"'));
        const recoveredIssues = recoverArrayElements(cleaned, issuesStart);
        if (recoveredIssues && recoveredIssues.length > 0) {
          result.issues = recoveredIssues;
        }
      }

      // Try to recover "suggestions"
      const suggestionsMatch = cleaned.match(/"suggestions"\s*:\s*\[/);
      if (suggestionsMatch) {
        const suggestionsStart = cleaned.indexOf("[", cleaned.indexOf('"suggestions"'));
        const recoveredSuggestions = recoverArrayElements(cleaned, suggestionsStart);
        if (recoveredSuggestions && recoveredSuggestions.length > 0) {
          result.suggestions = recoveredSuggestions;
        }
      }

      if (Object.keys(result).length > 0) {
        return result as T;
      }
    } catch {
      // Recovery failed
    }
  }

  return null;
}

/**
 * Recover complete JSON objects from a possibly-truncated array.
 * Scans from the array start position and collects fully-formed
 * { ... } objects that can be parsed individually.
 */
function recoverArrayElements(text: string, arrayStartIndex: number): unknown[] | null {
  if (arrayStartIndex === -1) return null;

  const elements: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escape = false;

  for (let i = arrayStartIndex; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        // Complete object found
        const objStr = text.slice(objStart, i + 1);
        try {
          elements.push(JSON.parse(objStr));
        } catch {
          // Skip malformed objects
        }
        objStart = -1;
      }
    }
  }

  return elements;
}
