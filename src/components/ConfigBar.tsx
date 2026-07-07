"use client";

import { useGraphStore } from "@/store/graphStore";
import { NVIDIA_MODELS } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

      {/* Model Selector */}
      <div className="flex items-center gap-2">
        <Cpu className="w-4 h-4 text-[#8888cc] shrink-0" />
        <Select
          value={config.model}
          onValueChange={(val) => setConfig({ model: val as typeof config.model })}
        >
          <SelectTrigger className="h-8 w-[220px] bg-[#1a1a3e] border-[#3a3a6a] text-[#e0e0ff] text-xs font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-[#1a1a3e] border-[#3a3a6a]">
            {NVIDIA_MODELS.map((m) => (
              <SelectItem
                key={m.value}
                value={m.value}
                className="text-[#e0e0ff] text-xs font-mono focus:bg-[#2a2a5a] focus:text-white"
              >
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
