"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { NodeCardData } from "@/lib/types";
import { Tag, Link2 } from "lucide-react";

/**
 * Custom React Flow node — renders as an Obsidian-style card with
 * title, summary, tags, and coloured accent bar.
 */
function NodeCardComponent({ data, selected }: NodeProps & { data: NodeCardData }) {
  const { node, color, onSelect } = data;

  return (
    <div
      className="group relative"
      onClick={() => onSelect(node.id)}
    >
      {/* Accent bar */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl"
        style={{ backgroundColor: color }}
      />

      <div
        className={`
          relative bg-[#1e1e3f] border rounded-xl p-3 pl-4 cursor-pointer
          transition-all duration-200 w-[220px]
          ${selected
            ? "border-indigo-400 shadow-[0_0_20px_rgba(99,102,241,0.4)]"
            : "border-[#4a4a8a] hover:border-[#6a6aaa] hover:shadow-[0_0_12px_rgba(100,100,255,0.3)]"
          }
        `}
      >
        {/* Target Handle (top) */}
        <Handle
          type="target"
          position={Position.Top}
          className="!bg-[#6366f1] !border-[#4a4a8a] !w-2 !h-2"
        />

        {/* Title */}
        <h3
          className="font-mono text-sm font-bold leading-tight mb-1 break-words"
          style={{ color }}
        >
          {node.title}
        </h3>

        {/* Summary */}
        <p className="text-[#b0b0dd] font-mono text-[11px] leading-relaxed mb-2 break-words">
          {node.summary}
        </p>

        {/* Tags */}
        {node.tags && node.tags.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            <Tag className="w-2.5 h-2.5 text-[#6666aa]" />
            {node.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-block px-1.5 py-0.5 rounded text-[9px] font-mono bg-[#12122a] text-[#8888cc] border border-[#2a2a5a]"
              >
                {tag}
              </span>
            ))}
            {node.tags.length > 3 && (
              <span className="text-[9px] font-mono text-[#6666aa]">
                +{node.tags.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Connection hint */}
        <div className="absolute bottom-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Link2 className="w-3 h-3 text-[#6366f1]" />
        </div>

        {/* Source Handle (bottom) */}
        <Handle
          type="source"
          position={Position.Bottom}
          className="!bg-[#6366f1] !border-[#4a4a8a] !w-2 !h-2"
        />
      </div>
    </div>
  );
}

export const NodeCard = memo(NodeCardComponent);
