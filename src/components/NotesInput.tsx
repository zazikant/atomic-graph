"use client";

import { useGraphStore } from "@/store/graphStore";
import { AXPipeline } from "@/lib/axPipeline";
import { buildFlowGraph, applyDagreLayout } from "@/lib/graphLayout";
import { CLUSTER_COLORS } from "@/lib/types";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, FileText, Trash2 } from "lucide-react";

interface NotesInputProps {
  onGraphGenerated?: () => void;
}

export function NotesInput({ onGraphGenerated }: NotesInputProps) {
  const {
    rawNotes,
    setRawNotes,
    config,
    isRunning,
    setIsRunning,
    setPipelineError,
    setPipelineResult,
    addIterationLog,
    resetPipeline,
    setSelectedNodeId,
  } = useGraphStore();

  const handleGenerate = async () => {
    if (!rawNotes.trim()) {
      setPipelineError("Please paste some notes before generating.");
      return;
    }

    setPipelineError(null);
    setIsRunning(true);
    resetPipeline();

    try {
      const pipeline = new AXPipeline(
        config.apiKey,
        config.model,
        (log) => {
          addIterationLog(log);
        }
      );

      const result = await pipeline.run(
        rawNotes,
        config.iterations,
        config.confidenceThreshold
      );

      if (result.result) {
        const { nodes, edges } = buildFlowGraph(
          result.result.nodes,
          result.result.edges,
          CLUSTER_COLORS,
          (id) => setSelectedNodeId(id)
        );

        const laidOutNodes = applyDagreLayout(nodes, edges);

        setPipelineResult(
          laidOutNodes,
          edges,
          result.score,
          result.attempts
        );

        // Notify parent (mobile tab switch)
        onGraphGenerated?.();
      } else {
        setPipelineError("Pipeline completed but produced no results. Try again with different notes.");
        setIsRunning(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error occurred";
      setPipelineError(message);
      setIsRunning(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#2a2a5a]">
        <FileText className="w-4 h-4 text-[#8888cc]" />
        <h2 className="text-[#e0e0ff] font-mono text-sm font-semibold">
          Raw Notes
        </h2>
      </div>

      {/* Textarea */}
      <div className="flex-1 p-3 min-h-0">
        <Textarea
          placeholder={"Paste your raw thoughts here...\n\nExample:\nI want to build an AI agent that can browse the web, remember past conversations, and use tools like calendar and email. It should know when to ask for help vs act autonomously. RAG might help with memory. Not sure if I need a vector DB or just context window tricks."}
          value={rawNotes}
          onChange={(e) => setRawNotes(e.target.value)}
          className="h-full min-h-[140px] bg-[#12122a] border-[#2a2a5a] text-[#c8c8ee] placeholder-[#5555aa] text-sm font-mono resize-none focus:border-indigo-500 focus:ring-indigo-500/20"
          disabled={isRunning}
        />
      </div>

      {/* Actions */}
      <div className="flex gap-2 p-3 border-t border-[#2a2a5a]">
        <Button
          onClick={handleGenerate}
          disabled={isRunning || !rawNotes.trim()}
          className="flex-1 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-mono text-sm h-10 shadow-lg shadow-indigo-500/20 transition-all duration-200"
        >
          {isRunning ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-2" />
              Generate Graph
            </>
          )}
        </Button>
        <Button
          variant="outline"
          onClick={resetPipeline}
          disabled={isRunning}
          className="border-[#3a3a6a] text-[#aaaadd] hover:bg-[#2a2a5a] hover:text-white font-mono text-sm h-10"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
