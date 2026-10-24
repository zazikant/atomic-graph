"use client";

import { useState } from "react";
import { ConfigBar } from "@/components/ConfigBar";
import { NotesInput } from "@/components/NotesInput";
import { JsonImport } from "@/components/JsonImport";
import { PipelineStatus } from "@/components/PipelineStatus";
import { GraphView } from "@/components/GraphView";
import { useGraphStore } from "@/store/graphStore";
import { FileText, GitBranch, Network, FileJson } from "lucide-react";

type MobileTab = "notes" | "json" | "graph" | "pipeline";
type SidebarTab = "notes" | "json";

export default function Home() {
  const [mobileTab, setMobileTab] = useState<MobileTab>("notes");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("notes");
  const { flowNodes, isRunning } = useGraphStore();

  return (
    <div className="flex flex-col h-[100dvh] bg-[#0a0a1a] overflow-hidden">
      {/* Panel 1 — Config Bar (top) */}
      <ConfigBar />

      {/* ─── Desktop layout: sidebar + graph ─── */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        {/* Panel 2 — Sidebar */}
        <aside className="w-[340px] lg:w-[380px] flex-shrink-0 flex flex-col border-r border-[#2a2a5a] bg-[#0e0e24] overflow-hidden">
          {/* Sidebar tab toggle */}
          <div className="flex border-b border-[#2a2a5a]">
            <button
              onClick={() => setSidebarTab("notes")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 font-mono text-xs transition-colors ${
                sidebarTab === "notes"
                  ? "text-indigo-400 border-b-2 border-indigo-500 bg-[#12122a]/50"
                  : "text-[#8888cc] hover:text-[#c8c8ee] hover:bg-[#12122a]/30"
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              Notes
            </button>
            <button
              onClick={() => setSidebarTab("json")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 font-mono text-xs transition-colors ${
                sidebarTab === "json"
                  ? "text-indigo-400 border-b-2 border-indigo-500 bg-[#12122a]/50"
                  : "text-[#8888cc] hover:text-[#c8c8ee] hover:bg-[#12122a]/30"
              }`}
            >
              <FileJson className="w-3.5 h-3.5" />
              Import JSON
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {sidebarTab === "notes" ? (
              <NotesInput onGraphGenerated={() => {}} />
            ) : (
              <JsonImport onGraphImported={() => {}} />
            )}
          </div>
          <PipelineStatus />
        </aside>

        {/* Panel 3 — Graph View */}
        <main className="flex-1 relative overflow-hidden">
          <GraphView />
        </main>
      </div>

      {/* ─── Mobile layout: tabbed view ─── */}
      <div className="flex md:hidden flex-1 overflow-hidden flex-col">
        {/* Tab content — fills remaining space */}
        <div className="flex-1 overflow-hidden">
          {mobileTab === "notes" && (
            <div className="flex flex-col h-full bg-[#0e0e24]">
              <div className="flex-1 overflow-y-auto">
                <NotesInput onGraphGenerated={() => setMobileTab("graph")} />
              </div>
            </div>
          )}
          {mobileTab === "json" && (
            <div className="flex flex-col h-full bg-[#0e0e24]">
              <div className="flex-1 overflow-y-auto">
                <JsonImport onGraphImported={() => setMobileTab("graph")} />
              </div>
            </div>
          )}
          {mobileTab === "graph" && (
            <div className="h-full w-full">
              <GraphView />
            </div>
          )}
          {mobileTab === "pipeline" && (
            <div className="h-full overflow-y-auto bg-[#0e0e24]">
              <PipelineStatus />
            </div>
          )}
        </div>

        {/* Bottom tab bar */}
        <nav className="flex border-t border-[#2a2a5a] bg-[#12122a] shrink-0">
          <button
            onClick={() => setMobileTab("notes")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-3 font-mono text-xs transition-colors ${
              mobileTab === "notes"
                ? "text-indigo-400 border-t-2 border-indigo-500 -mt-px"
                : "text-[#8888cc]"
            }`}
          >
            <FileText className="w-4 h-4" />
            Notes
          </button>
          <button
            onClick={() => setMobileTab("json")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-3 font-mono text-xs transition-colors ${
              mobileTab === "json"
                ? "text-indigo-400 border-t-2 border-indigo-500 -mt-px"
                : "text-[#8888cc]"
            }`}
          >
            <FileJson className="w-4 h-4" />
            JSON
          </button>
          <button
            onClick={() => setMobileTab("graph")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-3 font-mono text-xs transition-colors ${
              mobileTab === "graph"
                ? "text-indigo-400 border-t-2 border-indigo-500 -mt-px"
                : "text-[#8888cc]"
            }`}
          >
            <Network className="w-4 h-4" />
            Graph
            {flowNodes.length > 0 && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-400" />
            )}
          </button>
          <button
            onClick={() => setMobileTab("pipeline")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-3 font-mono text-xs transition-colors ${
              mobileTab === "pipeline"
                ? "text-indigo-400 border-t-2 border-indigo-500 -mt-px"
                : "text-[#8888cc]"
            }`}
          >
            <GitBranch className="w-4 h-4" />
            Pipeline
            {isRunning && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            )}
          </button>
        </nav>
      </div>
    </div>
  );
}
