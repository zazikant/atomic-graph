"use client";

import { ConfigBar } from "@/components/ConfigBar";
import { NotesInput } from "@/components/NotesInput";
import { PipelineStatus } from "@/components/PipelineStatus";
import { GraphView } from "@/components/GraphView";

export default function Home() {
  return (
    <div className="flex flex-col h-screen bg-[#0a0a1a] overflow-hidden">
      {/* Panel 1 — Config Bar (top) */}
      <ConfigBar />

      {/* Main content — sidebar + graph */}
      <div className="flex flex-1 overflow-hidden">
        {/* Panel 2 — Notes Input + Pipeline Status (left sidebar, 30%) */}
        <aside className="w-full md:w-[340px] lg:w-[380px] flex-shrink-0 flex flex-col border-r border-[#2a2a5a] bg-[#0e0e24] overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <NotesInput />
          </div>
          <PipelineStatus />
        </aside>

        {/* Panel 3 — Graph View (main area, 70%) */}
        <main className="flex-1 relative overflow-hidden">
          <GraphView />
        </main>
      </div>
    </div>
  );
}
