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
   * Streaming chat — calls /api/nvidia-stream (SSE) and emits live events
   * via the onLog/onChunk callbacks. Returns the final content string.
   *
   * This is the preferred path for gpt-oss-120b on Vercel because:
   *   1. Edge runtime works for gpt-oss-120b (Node serverless hangs)
   *   2. Per-call 12s timeout + 1 retry fails fast with clear errors
   *   3. Live log/chunk events let the UI show progress in real time
   *
   * Falls back to the non-streaming chat() if the SSE endpoint itself
   * fails (e.g. 4xx error from the route).
   */
  async chatStream(
    userPrompt: string,
    systemPrompt: string | undefined,
    onLog?: (line: string) => void,
    onChunk?: (text: string) => void,
    phaseLabel?: string,
  ): Promise<string> {
    const messages: { role: "system" | "user"; content: string }[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });

    if (phaseLabel) {
      onLog?.(`[pipeline] ${phaseLabel} — calling /api/nvidia-stream`);
    }

    const response = await fetch("/api/nvidia-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: this.apiKey,
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 32768,
      }),
    });

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => "(no body)");
      throw new Error(`Stream request failed (HTTP ${response.status}): ${errText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let errorMessage: string | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIdx;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const ev = JSON.parse(data);
            if (ev.type === "log" && typeof ev.line === "string") {
              onLog?.(ev.line);
            } else if (ev.type === "chunk" && typeof ev.text === "string") {
              content += ev.text;
              onChunk?.(ev.text);
            } else if (ev.type === "stage-end" && ev.content) {
              // Server sends the final accumulated content as a safety net
              content = ev.content as string;
            } else if (ev.type === "error" && typeof ev.message === "string") {
              errorMessage = ev.message;
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
    }

    if (errorMessage) {
      throw new Error(errorMessage);
    }
    if (!content) {
      throw new Error("Stream ended without content");
    }
    return content;
  }

  /**
   * Streaming variant of chatJSON — calls chatStream and parses the result.
   * Same recovery chain as chatJSON (parseLLMJson → recoverTruncatedJSON).
   */
  async chatJSONStream<T>(
    userPrompt: string,
    systemPrompt: string | undefined,
    onLog?: (line: string) => void,
    onChunk?: (text: string) => void,
    phaseLabel?: string,
  ): Promise<T> {
    const raw = await this.chatStream(userPrompt, systemPrompt, onLog, onChunk, phaseLabel);
    try {
      return parseLLMJson<T>(raw);
    } catch (parseError) {
      const recovered = recoverTruncatedJSON<T>(raw);
      if (recovered !== null) {
        console.warn(`[NvidiaClient] Recovered truncated JSON (${raw.length} chars, keys: ${Object.keys(recovered as object).join(", ")})`);
        return recovered;
      }
      const errMsg = parseError instanceof Error ? parseError.message : String(parseError);
      throw new Error(
        `${errMsg}\nRecovery attempted on ${raw.length}-character response but could not extract valid JSON.`,
      );
    }
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
        max_tokens: 32768,
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
   *
   * Recovery chain:
   * 1. Try normal JSON parse with balanced bracket extraction
   * 2. Try truncation recovery (close brackets, recover partial data)
   * 3. If recovery returns partial data, return it (caller decides how to handle)
   * 4. If all recovery fails, throw the original parse error
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
        console.warn(`[NvidiaClient] Recovered truncated JSON (${raw.length} chars input, recovered keys: ${Object.keys(recovered as object).join(', ')})`);
        return recovered;
      }

      // Enhanced error message with context about why recovery failed
      const errMsg = parseError instanceof Error ? parseError.message : String(parseError);
      throw new Error(
        `${errMsg}\nRecovery attempted on ${raw.length}-character response but could not extract valid JSON. This usually means the output was truncated mid-structure.`
      );
    }
  }
}

/**
 * Robust JSON parser for LLM outputs.
 * Strips markdown code fences, extracts JSON objects,
 * and handles reasoning model outputs that may contain
 * chain-of-thought text before/after the JSON.
 *
 * Strategy order:
 * 1. Direct parse of full cleaned text
 * 2. Extract balanced JSON using bracket matching (not greedy regex)
 * 3. Fix common issues (trailing commas, unquoted values)
 * 4. Fall through to truncation recovery (caller responsibility)
 */
export function parseLLMJson<T>(raw: string): T {
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  let cleaned = raw.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Strategy 1: Try direct parse of the full text
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Continue to more sophisticated parsing
  }

  // Strategy 2: Extract balanced JSON using bracket matching.
  // The old regex (\{[\s\S]*\}) was too greedy — it matched from the
  // first { to the LAST }, which could include post-JSON reasoning text.
  // Instead, find the first { or [ and match its closing bracket carefully.
  const jsonStr = extractBalancedJSON(cleaned);
  if (jsonStr) {
    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      // Continue to fixes
    }
  }

  // Strategy 3: Fix common issues like trailing commas
  if (jsonStr) {
    const fixed = jsonStr.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(fixed) as T;
    } catch {
      // Continue
    }
  }

  // Strategy 4: Try the greedy regex as a last resort before failing
  const greedyMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (greedyMatch) {
    try {
      return JSON.parse(greedyMatch[1]) as T;
    } catch {
      // Greedy match didn't work either
    }
  }

  throw new Error(
    `Failed to parse LLM JSON response. Output length: ${raw.length} chars.\nFirst 300 chars: ${raw.slice(0, 300)}\nLast 300 chars: ${raw.slice(-300)}`
  );
}

/**
 * Extract a balanced JSON object or array from text that may contain
 * extra content before or after the JSON.
 *
 * Uses bracket depth tracking to find the correct closing bracket,
 * respecting strings (so brackets inside strings are ignored).
 */
function extractBalancedJSON(text: string): string | null {
  const startCurly = text.indexOf("{");
  const startSquare = text.indexOf("[");

  let startIdx: number;
  let openCh: string;
  let closeCh: string;

  if (startCurly === -1 && startSquare === -1) return null;
  if (startCurly === -1) {
    startIdx = startSquare;
    openCh = "[";
    closeCh = "]";
  } else if (startSquare === -1) {
    startIdx = startCurly;
    openCh = "{";
    closeCh = "}";
  } else {
    startIdx = Math.min(startCurly, startSquare);
    openCh = startIdx === startCurly ? "{" : "[";
    closeCh = startIdx === startCurly ? "}" : "]";
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
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

    if (ch === openCh || ch === "{" || ch === "[") {
      if (ch === openCh && depth === 0) {
        depth = 1;
      } else if (depth > 0) {
        depth++;
      }
    } else if (ch === closeCh || ch === "}" || ch === "]") {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          return text.slice(startIdx, i + 1);
        }
      }
    }
  }

  // If we never found a balanced close, return null
  return null;
}

/**
 * Attempt to recover useful data from a truncated JSON response.
 *
 * Reasoning models (like GPT-OSS 120B) can produce very long responses
 * that get cut off mid-JSON when max_tokens is reached. This function
 * uses multiple strategies to salvage as much data as possible.
 *
 * Recovery strategies (in order):
 * 1. Close open brackets after removing trailing incomplete content
 * 2. Truncate to the last complete array element and close brackets
 * 3. Extract individual complete objects from known array fields
 * 4. Regex-based field extraction for scalar values
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

  // Strategy 1: Progressive bracket closure with smart truncation
  const attempt1 = closeOpenBrackets(cleaned);
  if (attempt1 !== null) {
    console.warn(`[JSON Recovery] Strategy 1 succeeded — bracket closure`);
    return attempt1 as T;
  }

  // Strategy 2: Truncate to last complete top-level array element
  // then close brackets. This handles cases where an array element is
  // partially written and the bracket closure in Strategy 1 fails.
  const attempt2 = truncateToLastCompleteElement(cleaned);
  if (attempt2 !== null) {
    console.warn(`[JSON Recovery] Strategy 2 succeeded — truncate to last complete element`);
    return attempt2 as T;
  }

  // Strategy 3: Extract individual complete objects from known array fields
  const attempt3 = recoverFieldsIndividually(cleaned);
  if (attempt3 !== null) {
    console.warn(`[JSON Recovery] Strategy 3 succeeded — individual field recovery`);
    return attempt3 as T;
  }

  return null;
}

/**
 * Strategy 1: Find the last complete value boundary in truncated JSON,
 * remove everything after it, close all open brackets.
 *
 * Instead of regex-based stripping (which is fragile), this scans backwards
 * from the end to find the last "safe" truncation point — the end of a
 * complete JSON value (string, number, boolean, null, object, or array).
 */
function closeOpenBrackets(cleaned: string): Record<string, unknown> | null {
  // First, count bracket depth respecting strings
  let curlyDepth = 0, squareDepth = 0;
  let inString = false, escape = false;

  for (const ch of cleaned) {
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") curlyDepth++;
    else if (ch === "}") curlyDepth--;
    else if (ch === "[") squareDepth++;
    else if (ch === "]") squareDepth--;
  }

  // If already balanced, it should have parsed normally — skip
  if (curlyDepth === 0 && squareDepth === 0) return null;

  // Find the rightmost point where we can safely truncate.
  // We scan backwards to find the last complete value.
  let attempt = findLastSafeTruncation(cleaned);
  if (attempt === null) return null;

  // Count open brackets after truncation
  let newCurly = 0, newSquare = 0;
  let inStr = false, esc = false;
  for (const ch of attempt) {
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") newCurly++;
    else if (ch === "}") newCurly--;
    else if (ch === "[") newSquare++;
    else if (ch === "]") newSquare--;
  }

  // Close open brackets
  for (let i = 0; i < newSquare; i++) attempt += "]";
  for (let i = 0; i < newCurly; i++) attempt += "}";

  // Fix trailing commas before closing brackets
  attempt = attempt.replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(attempt) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Find the last safe truncation point in a possibly-truncated JSON string.
 * Scans backwards to find the end of the last complete JSON value.
 *
 * A "safe" truncation point is after:
 * - A closing } of an object
 * - A closing ] of an array
 * - A complete string (closed quote)
 * - A number (digits, possibly with decimal, minus, exponent)
 * - true, false, null
 *
 * We then remove any trailing comma after that value.
 */
function findLastSafeTruncation(text: string): string | null {
  // Pre-compute string state at each position — this is needed for
  // all cases and the fallback
  const stringState: boolean[] = new Array(text.length).fill(false);
  let isStr = false, isEsc = false;
  for (let j = 0; j < text.length; j++) {
    if (isEsc) { isEsc = false; stringState[j] = isStr; continue; }
    if (text[j] === "\\" && isStr) { isEsc = true; stringState[j] = isStr; continue; }
    if (text[j] === '"') isStr = !isStr;
    stringState[j] = isStr;
  }

  const endsInString = stringState[text.length - 1];

  // If we end inside an incomplete string, we need to find where that string
  // started and remove the entire incomplete value (or key-value pair).
  if (endsInString) {
    // Find the opening " of the current incomplete string.
    // An opening quote is a " where the state BEFORE it is false
    // but the state AFTER it is true. Since stringState[j] records
    // the state AFTER processing character j, we look for a " where
    // stringState[j] is true but stringState[j-1] is false (or j===0).
    let stringStartQuote = -1;
    for (let j = text.length - 1; j >= 0; j--) {
      if (text[j] === '"') {
        const stateBefore = j > 0 ? stringState[j - 1] : false;
        const stateAfter = stringState[j];
        if (!stateBefore && stateAfter) {
          stringStartQuote = j;
          break;
        }
      }
    }

    if (stringStartQuote >= 0) {
      // We found the opening quote of the incomplete string.
      // The strategy is to find the INCOMPLETE CONTAINER (object or array)
      // that contains this string and remove it entirely.
      let beforeQuote = stringStartQuote - 1;
      while (beforeQuote >= 0 && /\s/.test(text[beforeQuote])) beforeQuote--;

      if (beforeQuote >= 0) {
        const prevChar = text[beforeQuote];
        if (prevChar === ":") {
          // The incomplete string is a VALUE after a key.
          // The entire object containing this key-value pair is incomplete.
          // Find the opening { of this object and remove everything from there.
          let objOpenIdx = -1;
          // Scan backwards from beforeQuote, tracking bracket depth,
          // to find the { that opened the current object
          let depth = 0;
          for (let k = beforeQuote; k >= 0; k--) {
            if (text[k] === "}" && !stringState[k]) depth++;
            else if (text[k] === "{" && !stringState[k]) {
              if (depth === 0) {
                objOpenIdx = k;
                break;
              }
              depth--;
            }
          }

          if (objOpenIdx >= 0) {
            // Found the opening { of the incomplete object.
            // Truncate before this object, removing any preceding comma.
            let beforeObj = objOpenIdx - 1;
            while (beforeObj >= 0 && /\s/.test(text[beforeObj])) beforeObj--;
            if (beforeObj >= 0 && text[beforeObj] === ",") {
              // There's a comma before the object — truncate before the comma
              return text.slice(0, beforeObj).replace(/,\s*$/, "");
            }
            if (beforeObj >= 0 && text[beforeObj] === "[") {
              // The object is the first element in an array — truncate after the [
              return text.slice(0, beforeObj + 1);
            }
            if (beforeObj >= 0 && text[beforeObj] === "{") {
              // The object is a nested value — truncate after the parent {
              return text.slice(0, beforeObj + 1);
            }
            // Fallback: truncate before the object
            return text.slice(0, objOpenIdx).replace(/,\s*$/, "");
          }

          // Couldn't find the opening { — fallback: remove just the key-value pair
          return text.slice(0, beforeQuote).replace(/,\s*$/, "");
        }
        if (prevChar === "," || prevChar === "[") {
          // The incomplete string is an element in an array
          // Truncate before this element
          return text.slice(0, beforeQuote + (prevChar === "[" ? 1 : 0)).replace(/,\s*$/, "");
        }
      }

      // Fallback: just truncate before the opening quote
      return text.slice(0, stringStartQuote).replace(/,\s*$/, "");
    }
  }

  // Not inside a string — scan from end
  let i = text.length - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return null;

  const ch = text[i];

  // Case 1: Ends with } or ] — complete object/array close
  if ((ch === "}" || ch === "]") && !stringState[i]) {
    let end = i;
    let k = i - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    if (k >= 0 && text[k] === ",") end = k;
    return text.slice(0, end + 1).replace(/,\s*$/, "");
  }

  // Case 2: Ends with " — complete string (since we handled incomplete strings above)
  if (ch === '"' && !stringState[i]) {
    let result = text.slice(0, i + 1);
    result = result.replace(/,\s*$/, "");
    return result;
  }

  // Case 3: Ends with a digit — might be a complete number
  if (/\d/.test(ch)) {
    let numEnd = i;
    let j = i;
    while (j >= 0 && /[0-9.eE+\-]/.test(text[j])) j--;
    let beforeNum = j;
    while (beforeNum >= 0 && /\s/.test(text[beforeNum])) beforeNum--;
    if (beforeNum >= 0 && (text[beforeNum] === ":" || text[beforeNum] === "," || text[beforeNum] === "[")) {
      let result = text.slice(0, numEnd + 1);
      result = result.replace(/,\s*$/, "");
      return result;
    }
  }

  // Fallback: Find the last } or ] that's not inside a string
  for (let j = text.length - 1; j >= 0; j--) {
    if ((text[j] === "}" || text[j] === "]") && !stringState[j]) {
      let result = text.slice(0, j + 1);
      result = result.replace(/,\s*$/, "");
      return result;
    }
  }

  return null;
}

/**
 * Strategy 2: Find the last complete array element (at any nesting level),
 * truncate after it, then close all open brackets.
 *
 * This is more aggressive than Strategy 1 — it discards the partially-written
 * array element entirely, but produces valid JSON.
 *
 * Only matches object boundaries (},{) and array closes (}]) not
 * internal commas within objects, which could corrupt data.
 */
function truncateToLastCompleteElement(cleaned: string): Record<string, unknown> | null {
  // Pre-compute string state to avoid matching inside strings
  const stringState: boolean[] = new Array(cleaned.length).fill(false);
  let isStr = false, isEsc = false;
  for (let j = 0; j < cleaned.length; j++) {
    if (isEsc) { isEsc = false; stringState[j] = isStr; continue; }
    if (cleaned[j] === "\\" && isStr) { isEsc = true; stringState[j] = isStr; continue; }
    if (cleaned[j] === '"') isStr = !isStr;
    stringState[j] = isStr;
  }

  // Find the last } that's outside a string — this marks the end of a complete object
  let lastCompleteObjEnd = -1;
  for (let j = cleaned.length - 1; j >= 0; j--) {
    if (cleaned[j] === "}" && !stringState[j]) {
      lastCompleteObjEnd = j;
      break;
    }
  }

  // Also find the last ] outside a string
  let lastCompleteArrEnd = -1;
  for (let j = cleaned.length - 1; j >= 0; j--) {
    if (cleaned[j] === "]" && !stringState[j]) {
      lastCompleteArrEnd = j;
      break;
    }
  }

  // Use whichever is later
  let bestIdx = Math.max(lastCompleteObjEnd, lastCompleteArrEnd);
  if (bestIdx <= 0) return null;

  let truncated = cleaned.slice(0, bestIdx + 1);

  // Remove trailing comma
  truncated = truncated.replace(/,\s*$/, "");

  // Count and close open brackets
  let curly = 0, square = 0;
  let inStr = false, esc = false;
  for (const ch of truncated) {
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
  }

  for (let i = 0; i < square; i++) truncated += "]";
  for (let i = 0; i < curly; i++) truncated += "}";

  truncated = truncated.replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(truncated) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Strategy 3: Extract individual complete objects from known array fields
 * (nodes, edges, issues, suggestions) and scalar values (score).
 */
function recoverFieldsIndividually(cleaned: string): Record<string, unknown> | null {
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

    // Try to recover "issues" array
    const issuesMatch = cleaned.match(/"issues"\s*:\s*\[/);
    if (issuesMatch) {
      const issuesStart = cleaned.indexOf("[", cleaned.indexOf('"issues"'));
      const recoveredIssues = recoverArrayElements(cleaned, issuesStart);
      if (recoveredIssues && recoveredIssues.length > 0) {
        result.issues = recoveredIssues;
      }
    }

    // Try to recover "suggestions" array
    const suggestionsMatch = cleaned.match(/"suggestions"\s*:\s*\[/);
    if (suggestionsMatch) {
      const suggestionsStart = cleaned.indexOf("[", cleaned.indexOf('"suggestions"'));
      const recoveredSuggestions = recoverArrayElements(cleaned, suggestionsStart);
      if (recoveredSuggestions && recoveredSuggestions.length > 0) {
        result.suggestions = recoveredSuggestions;
      }
    }

    if (Object.keys(result).length > 0) {
      return result;
    }
  } catch {
    // Recovery failed
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
