"use client";

import { useGraphStore } from "@/store/graphStore";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  GitBranch,
  AlertTriangle,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

const PHASE_LABELS: Record<string, string> = {
  extracting: "Extracting Concepts",
  linking: "Linking Relationships",
  validating: "Validating Quality",
  refining: "Refining Output",
  complete: "Complete",
};

const PHASE_ICONS: Record<string, React.ReactNode> = {
  extracting: <GitBranch className="w-3 h-3" />,
  linking: <GitBranch className="w-3 h-3" />,
  validating: <ShieldCheck className="w-3 h-3" />,
  refining: <AlertTriangle className="w-3 h-3" />,
  complete: <CheckCircle2 className="w-3 h-3" />,
};

function getQualityLabel(score: number): { label: string; icon: React.ReactNode } {
  if (score >= 0.90) {
    return {
      label: "Excellent — faithful & complete",
      icon: <Sparkles className="w-3 h-3" />,
    };
  }
  if (score >= 0.75) {
    return {
      label: "Good — minor gaps only",
      icon: <ShieldCheck className="w-3 h-3" />,
    };
  }
  if (score >= 0.50) {
    return {
      label: "Fair — some gaps found",
      icon: <AlertTriangle className="w-3 h-3" />,
    };
  }
  return {
    label: "Low — significant gaps",
    icon: <XCircle className="w-3 h-3" />,
  };
}

export function PipelineStatus() {
  const {
    iterationLogs,
    pipelineScore,
    pipelineAttempts,
    pipelineError,
    isRunning,
  } = useGraphStore();

  const lastLog = iterationLogs[iterationLogs.length - 1];
  const currentPhase = lastLog?.phase;
  const quality = getQualityLabel(pipelineScore);

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-[#2a2a5a]">
        <GitBranch className="w-4 h-4 text-[#8888cc]" />
        <h2 className="text-[#e0e0ff] font-mono text-sm font-semibold">
          AX Pipeline
        </h2>
        {isRunning && (
          <Loader2 className="w-3 h-3 text-indigo-400 animate-spin ml-auto" />
        )}
      </div>

      <div className="p-3 space-y-3">
        {/* Current Phase */}
        {currentPhase && (
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-5 h-5 rounded bg-[#1a1a3e] text-indigo-400">
              {PHASE_ICONS[currentPhase]}
            </div>
            <span className="text-[#c8c8ee] font-mono text-xs">
              {PHASE_LABELS[currentPhase] || currentPhase}
            </span>
          </div>
        )}

        {/* Quality / Semantic Fidelity Score */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[#8888cc] font-mono text-xs">
              Quality
            </span>
            <span className="text-[#e0e0ff] font-mono text-xs font-bold">
              {(pipelineScore * 100).toFixed(0)}%
            </span>
          </div>
          <Progress
            value={pipelineScore * 100}
            className="h-2 bg-[#1a1a3e]"
          />
        </div>

        {/* Iterations Summary */}
        <div className="flex items-center gap-2">
          <span className="text-[#8888cc] font-mono text-xs">
            Attempts:
          </span>
          <Badge
            variant="secondary"
            className="bg-[#1a1a3e] text-[#c8c8ee] font-mono text-xs border border-[#3a3a6a]"
          >
            {pipelineAttempts}
          </Badge>
        </div>

        {/* Error */}
        {pipelineError && (
          <div className="flex items-start gap-2 p-2 rounded bg-red-950/40 border border-red-900/50">
            <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span className="text-red-300 font-mono text-xs leading-relaxed">
              {pipelineError}
            </span>
          </div>
        )}

        {/* Iteration Logs */}
        {iterationLogs.length > 0 && (
          <ScrollArea className="max-h-[160px]">
            <div className="space-y-1.5">
              {iterationLogs.map((log, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-2 py-1.5 rounded bg-[#12122a] border border-[#2a2a5a]"
                >
                  <span className="text-[#8888cc] font-mono text-[10px] w-4 text-center">
                    {log.iteration}
                  </span>
                  {log.passed ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <XCircle className="w-3 h-3 text-red-400" />
                  )}
                  <span className="text-[#c8c8ee] font-mono text-[11px] flex-1 truncate">
                    {PHASE_LABELS[log.phase] || log.phase}
                  </span>
                  <span className="text-[#8888cc] font-mono text-[10px]">
                    {(log.score * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        {/* Quality Rating Badge */}
        {!isRunning && pipelineScore > 0 && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-center">
              <Badge
                className={`font-mono text-xs px-3 py-1 gap-1 ${
                  pipelineScore >= 0.90
                    ? "bg-emerald-900/50 text-emerald-300 border border-emerald-700/50"
                    : pipelineScore >= 0.75
                    ? "bg-emerald-900/30 text-emerald-400 border border-emerald-700/30"
                    : pipelineScore >= 0.50
                    ? "bg-amber-900/50 text-amber-300 border border-amber-700/50"
                    : "bg-red-900/50 text-red-300 border border-red-700/50"
                }`}
              >
                {quality.icon}
                {quality.label}
              </Badge>
            </div>
            <p className="text-[#5555aa] font-mono text-[10px] text-center leading-relaxed">
              {pipelineScore >= 0.90
                ? "Semantic fidelity verified. Meaning faithfully preserved."
                : pipelineScore >= 0.75
                ? "Minor gaps only. Core meaning captured accurately."
                : pipelineScore >= 0.50
                ? "Some concepts or relationships may be missing or imprecise."
                : "Significant gaps. Consider refining your notes or increasing iterations."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
