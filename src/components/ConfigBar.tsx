"use client";

import { useGraphStore } from "@/store/graphStore";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Settings, Key, Cpu, RotateCcw, Target } from "lucide-react";

export function ConfigBar() {
  const { config, setConfig } = useGraphStore();

  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-3 bg-[#12122a] border-b border-[#2a2a5a]">
      {/* Logo / Title */}
      <div className="flex items-center gap-2 mr-4">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
          <Settings className="w-4 h-4 text-white" />
        </div>
        <span className="text-[#e0e0ff] font-mono font-bold text-sm tracking-wide hidden sm:inline">
          Atomic Graph
        </span>
      </div>

      {/* API Key */}
      <div className="flex items-center gap-2 min-w-[200px]">
        <Key className="w-4 h-4 text-[#8888cc] shrink-0" />
        <Input
          type="password"
          placeholder="Nvidia API Key"
          value={config.apiKey}
          onChange={(e) => setConfig({ apiKey: e.target.value })}
          className="h-8 bg-[#1a1a3e] border-[#3a3a6a] text-[#e0e0ff] placeholder-[#6666aa] text-xs font-mono focus:border-indigo-500 focus:ring-indigo-500/30"
        />
      </div>

      {/* Model Badge — single model */}
      <div className="flex items-center gap-2">
        <Cpu className="w-4 h-4 text-[#8888cc] shrink-0" />
        <Badge
          variant="secondary"
          className="bg-[#1a1a3e] text-[#c8c8ee] font-mono text-xs border border-[#3a3a6a] px-3 py-1"
        >
          GPT-OSS 120B
        </Badge>
      </div>

      {/* Iterations Slider */}
      <div className="flex items-center gap-2">
        <RotateCcw className="w-4 h-4 text-[#8888cc] shrink-0" />
        <Label className="text-[#aaaadd] text-xs font-mono whitespace-nowrap">
          Iter: {config.iterations}
        </Label>
        <Slider
          min={1}
          max={5}
          step={1}
          value={[config.iterations]}
          onValueChange={([val]) => setConfig({ iterations: val })}
          className="w-[80px]"
        />
      </div>

      {/* Confidence Threshold */}
      <div className="flex items-center gap-2">
        <Target className="w-4 h-4 text-[#8888cc] shrink-0" />
        <Label className="text-[#aaaadd] text-xs font-mono whitespace-nowrap">
          Threshold: {config.confidenceThreshold.toFixed(2)}
        </Label>
        <Input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={config.confidenceThreshold}
          onChange={(e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val) && val >= 0 && val <= 1) {
              setConfig({ confidenceThreshold: val });
            }
          }}
          className="h-8 w-[70px] bg-[#1a1a3e] border-[#3a3a6a] text-[#e0e0ff] text-xs font-mono"
        />
      </div>
    </div>
  );
}
