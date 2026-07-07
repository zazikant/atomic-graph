"use client";

import { useGraphStore, type LiveEvent } from "@/store/graphStore";
import { useEffect, useRef } from "react";

/**
 * Terminal-style live pipeline log viewer.
 *
 * Renders every event from /api/nvidia-stream in real time:
 *   ▶ stage-start llm-call
 *   [nvidia] start  model=openai/gpt-oss-120b max_tokens=32768 ...
 *   [nvidia] ttfb=1550ms done attempt=1 elapsed=1935ms ...
 *   ■ stage-end llm-call 1937ms ✓ 23 chars
 *
 * Color coding:
 *   - sky blue    → stage-start
 *   - emerald     → done / success
 *   - amber       → retry
 *   - rose        → TIMEOUT / ERROR / failure
 *   - zinc        → default info logs
 *
 * Chunk events are NOT rendered (they'd spam the log; liveText already
 * shows them in the live-text panel above this log).
 */
function formatTime(ts: number): string {
  const t = new Date(ts);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
}

function renderEvent(ev: LiveEvent, i: number) {
  const ts = formatTime(ev.ts);
  if (ev.type === "stage-start") {
    return (
      <div key={i} className="text-sky-300">
        <span className="text-zinc-500">{ts}</span>{" "}
        <span className="text-sky-400">▶</span> stage-start{" "}
        <span className="text-sky-200">{ev.stage}</span>
      </div>
    );
  }
  if (ev.type === "log" && ev.line) {
    const isErr = ev.line.includes("TIMEOUT") || ev.line.includes("ERROR");
    const isRetry = ev.line.includes("retry");
    const isDone = ev.line.includes("done");
    const isPipeline = ev.line.startsWith("[pipeline]");
    const cls = isErr
      ? "text-rose-300"
      : isRetry
        ? "text-amber-300"
        : isDone
          ? "text-emerald-300"
          : isPipeline
            ? "text-violet-300"
            : "text-zinc-300";
    return (
      <div key={i} className={cls}>
        <span className="text-zinc-500">{ts}</span> {ev.line}
      </div>
    );
  }
  if (ev.type === "chunk") {
    return null; // hidden to avoid log spam
  }
  if (ev.type === "stage-end") {
    return (
      <div key={i} className={ev.ok ? "text-emerald-300" : "text-rose-300"}>
        <span className="text-zinc-500">{ts}</span>{" "}
        <span className={ev.ok ? "text-emerald-400" : "text-rose-400"}>■</span>{" "}
        stage-end{" "}
        <span className={ev.ok ? "text-emerald-200" : "text-rose-200"}>
          {ev.stage}
        </span>{" "}
        {ev.elapsedMs}ms{" "}
        {ev.ok ? "✓" : "✗"}
        {ev.attempts ? ` (${ev.attempts} attempt${ev.attempts > 1 ? "s" : ""})` : ""}
      </div>
    );
  }
  if (ev.type === "error") {
    return (
      <div key={i} className="text-rose-400 font-bold">
        <span className="text-zinc-500">{ts}</span>{" "}
        <span className="text-rose-400">✗</span> ERROR: {ev.message}
      </div>
    );
  }
  return (
    <div key={i} className="text-zinc-400">
      <span className="text-zinc-500">{ts}</span> {ev.type}
    </div>
  );
}

export function LivePipelineLog() {
  const { liveEvents, showLiveLog, setShowLiveLog } = useGraphStore();
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [liveEvents.length]);

  if (liveEvents.length === 0) return null;

  return (
    <div className="rounded-md bg-zinc-950 text-zinc-100 p-3 max-h-[240px] overflow-hidden flex flex-col">
      <div className="flex items-center justify-between mb-1.5 border-b border-zinc-800 pb-1 shrink-0">
        <span className="text-zinc-400 font-mono text-[10px]">
          live pipeline log ({liveEvents.length} events)
        </span>
        <button
          type="button"
          onClick={() => setShowLiveLog(false)}
          className="text-zinc-500 hover:text-zinc-200 text-[10px] font-mono"
        >
          {showLiveLog ? "hide" : "show"}
        </button>
      </div>
      {showLiveLog && (
        <div
          ref={containerRef}
          className="overflow-y-auto font-mono text-[11px] leading-relaxed flex-1"
        >
          {liveEvents.map((ev, i) => renderEvent(ev, i))}
        </div>
      )}
    </div>
  );
}
