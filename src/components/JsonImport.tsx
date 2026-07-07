"use client";

import { useState } from "react";
import { useGraphStore } from "@/store/graphStore";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FileJson, Upload, Trash2, AlertCircle, CheckCircle2 } from "lucide-react";

interface JsonImportProps {
  onGraphImported?: () => void;
}

export function JsonImport({ onGraphImported }: JsonImportProps) {
  const { importGraphFromJSON, resetPipeline } = useGraphStore();

  const [jsonText, setJsonText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  const handleImport = () => {
    setImportError(null);
    setImportSuccess(false);

    if (!jsonText.trim()) {
      setImportError("Please paste a JSON graph first.");
      return;
    }

    const result = importGraphFromJSON(jsonText);

    if (result.success) {
      setImportSuccess(true);
      setTimeout(() => setImportSuccess(false), 3000);
      onGraphImported?.();
    } else {
      setImportError(result.error || "Failed to import JSON.");
    }
  };

  const handleReset = () => {
    setJsonText("");
    setImportError(null);
    setImportSuccess(false);
    resetPipeline();
  };

  const nodeCount = (() => {
    try {
      const data = JSON.parse(jsonText);
      return Array.isArray(data.nodes) ? data.nodes.length : 0;
    } catch {
      return 0;
    }
  })();

  const edgeCount = (() => {
    try {
      const data = JSON.parse(jsonText);
      return Array.isArray(data.edges) ? data.edges.length : 0;
    } catch {
      return 0;
    }
  })();

  const isValidJson = (() => {
    try {
      JSON.parse(jsonText);
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#2a2a5a]">
        <FileJson className="w-4 h-4 text-[#8888cc]" />
        <h2 className="text-[#e0e0ff] font-mono text-sm font-semibold">
          Import JSON
        </h2>
      </div>

      {/* Info hint */}
      <div className="px-3 pt-3">
        <p className="text-[#6666aa] font-mono text-[11px] leading-relaxed">
          Paste a JSON graph (same format as the exported JSON) to visualize it directly — no AI processing needed.
        </p>
      </div>

      {/* Textarea */}
      <div className="flex-1 p-3 min-h-0">
        <Textarea
          placeholder={'{\n  "nodes": [\n    { "id": "n1", "title": "Idea", "summary": "...", "tags": [] }\n  ],\n  "edges": [\n    { "source": "n1", "target": "n2", "label": "enables", "strength": 0.8 }\n  ]\n}'}
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.target.value);
            setImportError(null);
            setImportSuccess(false);
          }}
          className="h-full min-h-[140px] bg-[#12122a] border-[#2a2a5a] text-[#c8c8ee] placeholder-[#5555aa] text-xs font-mono resize-none focus:border-indigo-500 focus:ring-indigo-500/20"
        />
      </div>

      {/* Preview info */}
      {jsonText.trim() && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-3 px-2.5 py-1.5 rounded-lg bg-[#12122a] border border-[#2a2a5a]">
            {isValidJson ? (
              <>
                <span className="text-[#8888cc] font-mono text-[10px]">
                  {nodeCount} nodes
                </span>
                <span className="text-[#3a3a6a]">·</span>
                <span className="text-[#8888cc] font-mono text-[10px]">
                  {edgeCount} edges
                </span>
                {nodeCount > 0 && (
                  <>
                    <span className="text-[#3a3a6a]">·</span>
                    <span className="text-emerald-400/80 font-mono text-[10px]">
                      valid
                    </span>
                  </>
                )}
              </>
            ) : (
              <span className="text-amber-400/80 font-mono text-[10px]">
                invalid JSON
              </span>
            )}
          </div>
        </div>
      )}

      {/* Error / Success messages */}
      {importError && (
        <div className="px-3 pb-2">
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-950/40 border border-red-800/40">
            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
            <span className="text-red-300 font-mono text-xs leading-relaxed">{importError}</span>
          </div>
        </div>
      )}
      {importSuccess && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-950/40 border border-emerald-800/40">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="text-emerald-300 font-mono text-xs">Graph imported successfully!</span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 p-3 border-t border-[#2a2a5a]">
        <Button
          onClick={handleImport}
          disabled={!jsonText.trim() || !isValidJson}
          className="flex-1 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-mono text-sm h-10 shadow-lg shadow-indigo-500/20 transition-all duration-200"
        >
          <Upload className="w-4 h-4 mr-2" />
          Import Graph
        </Button>
        <Button
          variant="outline"
          onClick={handleReset}
          className="border-[#3a3a6a] text-[#aaaadd] hover:bg-[#2a2a5a] hover:text-white font-mono text-sm h-10"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
