"use client";

import { useGraphStore } from "@/store/graphStore";
import { X, Tag, Link2, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

export function NodeDrawer() {
  const { flowNodes, flowEdges, selectedNodeId, setSelectedNodeId } =
    useGraphStore();

  if (!selectedNodeId) return null;

  const node = flowNodes.find((n) => n.id === selectedNodeId);
  if (!node) return null;

  const { node: data, color } = node.data;

  // Find connected edges
  const connectedEdges = flowEdges.filter(
    (e) => e.source === selectedNodeId || e.target === selectedNodeId
  );

  const connectedNodeIds = new Set<string>();
  connectedEdges.forEach((e) => {
    connectedNodeIds.add(e.source);
    connectedNodeIds.add(e.target);
  });
  connectedNodeIds.delete(selectedNodeId);

  const connectedNodes = flowNodes.filter((n) => connectedNodeIds.has(n.id));

  return (
    <div className="absolute right-0 top-0 bottom-0 w-[320px] bg-[#12122a] border-l border-[#2a2a5a] z-50 flex flex-col animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="flex items-start justify-between px-4 py-3 border-b border-[#2a2a5a] gap-2">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <div
            className="w-2 h-2 rounded-full mt-1.5 shrink-0"
            style={{ backgroundColor: color }}
          />
          <h3 className="text-[#e0e0ff] font-mono text-sm font-bold leading-snug break-words">
            {data.title}
          </h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSelectedNodeId(null)}
          className="h-7 w-7 text-[#8888cc] hover:text-white hover:bg-[#2a2a5a]"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Summary */}
          <div>
            <h4 className="text-[#8888cc] font-mono text-xs mb-1 uppercase tracking-wider">
              Summary
            </h4>
            <p className="text-[#c8c8ee] font-mono text-sm leading-relaxed break-words">
              {data.summary}
            </p>
          </div>

          {/* Full Content */}
          {data.content && data.content !== data.summary && (
            <div>
              <h4 className="text-[#8888cc] font-mono text-xs mb-1 uppercase tracking-wider">
                Content
              </h4>
              <p className="text-[#b0b0dd] font-mono text-sm leading-relaxed whitespace-pre-wrap">
                {data.content}
              </p>
            </div>
          )}

          {/* Tags */}
          {data.tags && data.tags.length > 0 && (
            <div>
              <h4 className="text-[#8888cc] font-mono text-xs mb-2 uppercase tracking-wider">
                Tags
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {data.tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="bg-[#1a1a3e] text-[#c8c8ee] font-mono text-xs border border-[#3a3a6a]"
                  >
                    <Tag className="w-2.5 h-2.5 mr-1" />
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Connections */}
          {connectedNodes.length > 0 && (
            <div>
              <h4 className="text-[#8888cc] font-mono text-xs mb-2 uppercase tracking-wider">
                Connections ({connectedEdges.length})
              </h4>
              <div className="space-y-1.5">
                {connectedNodes.map((cn) => {
                  const edge = connectedEdges.find(
                    (e) =>
                      (e.source === selectedNodeId && e.target === cn.id) ||
                      (e.target === selectedNodeId && e.source === cn.id)
                  );
                  return (
                    <div
                      key={cn.id}
                      className="flex items-start gap-2 px-2 py-1.5 rounded bg-[#1a1a3e] border border-[#2a2a5a] cursor-pointer hover:border-[#4a4a8a] transition-colors"
                      onClick={() => setSelectedNodeId(cn.id)}
                    >
                      <Link2 className="w-3 h-3 text-[#6366f1] shrink-0 mt-0.5" />
                      <span className="text-[#c8c8ee] font-mono text-xs flex-1 line-clamp-2">
                        {cn.data.node.title}
                      </span>
                      {edge?.label && (
                        <span className="text-[#6666aa] font-mono text-[10px] truncate max-w-[120px] shrink-0">
                          {edge.label}
                        </span>
                      )}
                      <ExternalLink className="w-2.5 h-2.5 text-[#5555aa] shrink-0 mt-0.5" />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
