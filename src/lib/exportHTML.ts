import type { Node, Edge } from "@xyflow/react";
import type { NodeCardData, AtomicNode, GraphEdge } from "./types";

/**
 * Generate a fully self-contained HTML file that renders an interactive
 * React Flow knowledge graph. The file loads React Flow via CDN and
 * embeds all node/edge data inline — no server required.
 *
 * Features preserved in the export:
 * - Drag-and-drop nodes
 * - Zoom and pan
 * - Click nodes to expand full content in a side drawer
 * - Minimap navigation
 * - Animated dashed edges with arrow markers
 * - Dark Obsidian theme
 * - Offline use forever (after initial CDN load)
 */

interface ExportableNode {
  id: string;
  position: { x: number; y: number };
  data: {
    node: AtomicNode;
    color: string;
  };
}

interface ExportableEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  style?: { stroke?: string; strokeWidth?: number };
  animated?: boolean;
  data?: { strength?: number; label?: string };
}

export function generateHTMLExport(
  nodes: Node<NodeCardData>[],
  edges: Edge[]
): string {
  // Serialize only what the standalone HTML needs
  const exportNodes: ExportableNode[] = nodes.map((n) => ({
    id: n.id,
    position: n.position,
    data: {
      node: n.data.node,
      color: n.data.color,
    },
  }));

  const exportEdges: ExportableEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label || e.data?.label,
    style: e.style as { stroke?: string; strokeWidth?: number },
    animated: e.animated,
    data: {
      strength: (e.data as any)?.strength,
      label: (e.data as any)?.label,
    },
  }));

  const graphData = JSON.stringify({ nodes: exportNodes, edges: exportEdges });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Atomic Graph — Knowledge Graph</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { width: 100%; height: 100%; overflow: hidden; }
  body { font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace; background: #0a0a1a; color: #e0e0ff; }

  /* ── Animated Edge ─────────────────────────── */
  @keyframes dash-flow { to { stroke-dashoffset: -20; } }
  .animated-edge { animation: dash-flow 1s linear infinite; }

  /* ── Node Card ─────────────────────────────── */
  .node-card {
    position: relative;
    background: #1e1e3f;
    border: 1px solid #4a4a8a;
    border-radius: 12px;
    padding: 12px 16px;
    width: 220px;
    cursor: pointer;
    transition: border-color 0.2s, box-shadow 0.2s;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }
  .node-card:hover {
    border-color: #6a6aaa;
    box-shadow: 0 0 12px rgba(100, 100, 255, 0.3);
  }
  .node-card .accent-bar {
    position: absolute; left: 0; top: 0; bottom: 0; width: 4px; border-radius: 12px 0 0 12px;
  }
  .node-card h3 { font-size: 13px; font-weight: 700; margin-bottom: 4px; line-height: 1.3; word-wrap: break-word; overflow-wrap: break-word; }
  .node-card p { font-size: 11px; color: #b0b0dd; line-height: 1.5; word-wrap: break-word; overflow-wrap: break-word; margin-bottom: 6px; }
  .node-card .tags { display: flex; gap: 4px; flex-wrap: wrap; }
  .node-card .tag { font-size: 9px; padding: 2px 6px; border-radius: 4px; background: #12122a; color: #8888cc; border: 1px solid #2a2a5a; }

  /* ── Side Drawer ───────────────────────────── */
  .drawer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 999; display: none; }
  .drawer-overlay.open { display: block; }
  .drawer { position: fixed; right: 0; top: 0; bottom: 0; width: 340px; background: #12122a; border-left: 1px solid #2a2a5a; z-index: 1000; padding: 20px; overflow-y: auto; transform: translateX(100%); transition: transform 0.2s ease; }
  .drawer.open { transform: translateX(0); }
  .drawer h2 { font-size: 16px; font-weight: 700; margin-bottom: 8px; word-wrap: break-word; overflow-wrap: break-word; }
  .drawer .summary { font-size: 13px; color: #c8c8ee; line-height: 1.6; margin-bottom: 16px; word-wrap: break-word; overflow-wrap: break-word; }
  .drawer .content { font-size: 12px; color: #b0b0dd; line-height: 1.7; white-space: pre-wrap; margin-bottom: 16px; }
  .drawer .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
  .drawer .tag { font-size: 11px; padding: 3px 8px; border-radius: 6px; background: #1a1a3e; color: #c8c8ee; border: 1px solid #3a3a6a; }
  .drawer .connections h4 { font-size: 11px; color: #8888cc; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .drawer .conn-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; background: #1a1a3e; border: 1px solid #2a2a5a; font-size: 11px; color: #c8c8ee; cursor: pointer; margin-bottom: 4px; }
  .drawer .conn-item:hover { border-color: #4a4a8a; }
  .drawer .conn-label { color: #6666aa; font-size: 10px; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .drawer .close-btn { position: absolute; top: 12px; right: 12px; background: none; border: 1px solid #3a3a6a; border-radius: 6px; color: #8888cc; cursor: pointer; padding: 4px 8px; font-size: 14px; font-family: inherit; }
  .drawer .close-btn:hover { background: #2a2a5a; color: white; }

  /* ── React Flow Overrides ──────────────────── */
  .react-flow__attribution { display: none !important; }
  .react-flow__minimap { border-radius: 8px !important; }
  .react-flow__controls { border-radius: 8px !important; box-shadow: 0 4px 20px rgba(0,0,0,0.4) !important; }
  .react-flow__controls button { background: #1a1a3e !important; border-bottom: 1px solid #2a2a5a !important; color: #c8c8ee !important; fill: #c8c8ee !important; }
  .react-flow__controls button:hover { background: #2a2a5a !important; }
  .react-flow__edge-textbg { fill: #0a0a1a !important; }
  .react-flow__edge-text { fill: #8888cc !important; font-family: 'JetBrains Mono', monospace !important; font-size: 10px !important; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #0a0a1a; }
  ::-webkit-scrollbar-thumb { background: #2a2a5a; border-radius: 3px; }
</style>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xyflow/react@12/dist/style.css" crossorigin />
</head>
<body>
<div id="root"></div>
<div class="drawer-overlay" id="drawerOverlay"></div>
<div class="drawer" id="drawer">
  <button class="close-btn" id="closeDrawer">&times;</button>
  <div id="drawerContent"></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js" crossorigin></script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
<script>
// ── jsx-runtime shim ─────────────────────────────────────────
// The @xyflow/react UMD bundle requires window.jsxRuntime,
// which the standard React UMD build does not expose.
// This shim bridges the gap so the UMD bundle initializes correctly.
window.jsxRuntime = {
  Fragment: React.Fragment,
  jsx: function(type, props, key) {
    if (key !== undefined && props && props.key === undefined) props.key = key;
    return React.createElement(type, props);
  },
  jsxs: function(type, props, key) {
    if (key !== undefined && props && props.key === undefined) props.key = key;
    return React.createElement(type, props);
  }
};
</script>
<script src="https://cdn.jsdelivr.net/npm/@xyflow/react@12/dist/umd/index.js" crossorigin></script>
<script>
(function() {
  var h = React.createElement;
  // The UMD bundle exposes everything on window.ReactFlow (NOT Xyflow)
  var RF = window.ReactFlow;
  var ReactFlow = RF.ReactFlow;
  var Background = RF.Background;
  var Controls = RF.Controls;
  var MiniMap = RF.MiniMap;
  var BackgroundVariant = RF.BackgroundVariant;
  var useNodesState = RF.useNodesState;
  var useEdgesState = RF.useEdgesState;
  var Handle = RF.Handle;
  var Position = RF.Position;
  var MarkerType = RF.MarkerType;

  var GRAPH_DATA = ${graphData};

  // ── Compute label offsets to prevent overlapping ──────────
  var LABEL_SPACING = 16;
  var CLUSTER_RADIUS = 30;
  function computeLabelOffsets(nodes, edges) {
    var offsets = {};
    var midpoints = edges.map(function(e) {
      var src = null, tgt = null;
      for (var k = 0; k < nodes.length; k++) {
        if (nodes[k].id === e.source) src = nodes[k];
        if (nodes[k].id === e.target) tgt = nodes[k];
      }
      if (!src || !tgt) return { id: e.id, mx: 0, my: 0 };
      return {
        id: e.id,
        mx: (src.position.x + 110 + tgt.position.x + 110) / 2,
        my: (src.position.y + 65 + tgt.position.y + 65) / 2
      };
    });
    var visited = {};
    for (var i = 0; i < midpoints.length; i++) {
      if (visited[midpoints[i].id]) continue;
      var cluster = [midpoints[i]];
      visited[midpoints[i].id] = true;
      for (var j = i + 1; j < midpoints.length; j++) {
        if (visited[midpoints[j].id]) continue;
        var ddx = midpoints[i].mx - midpoints[j].mx;
        var ddy = midpoints[i].my - midpoints[j].my;
        if (Math.sqrt(ddx * ddx + ddy * ddy) < CLUSTER_RADIUS) {
          cluster.push(midpoints[j]);
          visited[midpoints[j].id] = true;
        }
      }
      if (cluster.length > 1) {
        cluster.forEach(function(item, idx) {
          offsets[item.id] = (idx - (cluster.length - 1) / 2) * LABEL_SPACING;
        });
      }
    }
    return offsets;
  }
  var labelOffsets = computeLabelOffsets(GRAPH_DATA.nodes, GRAPH_DATA.edges);

  // ── Custom Node Component ────────────────────────
  function AtomicCard({ data, id }) {
    var nodeData = data.node;
    var color = data.color;
    return h('div', {
      className: 'node-card',
      onClick: function(e) { e.stopPropagation(); openDrawer(id); },
    },
      h('div', { className: 'accent-bar', style: { backgroundColor: color } }),
      h(Handle, { type: 'target', position: Position.Top, style: { background: '#6366f1', border: '#4a4a8a', width: 8, height: 8 } }),
      h('h3', { style: { color: color } }, nodeData.title),
      h('p', null, nodeData.summary),
      nodeData.tags && nodeData.tags.length > 0
        ? h('div', { className: 'tags' }, nodeData.tags.slice(0, 3).map(function(t) { return h('span', { className: 'tag', key: t }, t); }))
        : null,
      h(Handle, { type: 'source', position: Position.Bottom, style: { background: '#6366f1', border: '#4a4a8a', width: 8, height: 8 } })
    );
  }

  // ── Custom Edge Component ────────────────────────
  function AnimatedEdge(props) {
    var edgeColor = (props.style && props.style.stroke) || '#6366f1';
    var edgeWidth = (props.style && props.style.strokeWidth) || 1.5;
    var sx = props.sourceX, sy = props.sourceY, tx = props.targetX, ty = props.targetY;
    var midX = (sx + tx) / 2, midY = (sy + ty) / 2;
    var dx = tx - sx, dy = ty - sy;
    var edgeLen = Math.sqrt(dx * dx + dy * dy);
    var cX = midX - dy * 0.2, cY = midY + dx * 0.2;
    var path = 'M ' + sx + ' ' + sy + ' Q ' + cX + ' ' + cY + ' ' + tx + ' ' + ty;
    var label = props.label || (props.data && props.data.label);
    var offset = labelOffsets[props.id] || 0;

    // Perpendicular direction for label offset
    var perpX = edgeLen > 0 ? -dy / edgeLen : 0;
    var perpY = edgeLen > 0 ? dx / edgeLen : -1;
    var lx = midX + perpX * offset;
    var ly = midY + perpY * offset - 8;

    var markerEnd = null;
    if (MarkerType) {
      markerEnd = { type: MarkerType.ArrowClosed, color: edgeColor, width: 20, height: 20 };
    }

    var labelEls = null;
    if (label) {
      var shortLabel = (typeof label === 'string' && label.length > 20) ? label.slice(0, 18) + '\\u2026' : label;
      var labelWidth = (typeof shortLabel === 'string' ? shortLabel.length : 10) * 3.2 + 12;
      labelEls = [
        h('rect', { x: lx - labelWidth / 2, y: ly - 9, width: labelWidth, height: 14, rx: 4, fill: '#0a0a1a', fillOpacity: 0.85 }),
        h('text', { x: lx, y: ly, textAnchor: 'middle', style: { pointerEvents: 'none' }, fill: '#a0a0dd', fontSize: 10, fontFamily: 'monospace' }, shortLabel)
      ];
    }

    return h('g', null,
      h('path', { d: path, fill: 'none', stroke: edgeColor, strokeWidth: edgeWidth + 2, strokeOpacity: 0.15 }),
      h('path', { d: path, fill: 'none', stroke: edgeColor, strokeWidth: edgeWidth, strokeDasharray: '6 4', markerEnd: markerEnd, className: 'animated-edge' }),
      labelEls
    );
  }

  var nodeTypes = { atomicCard: AtomicCard };
  var edgeTypes = { animatedEdge: AnimatedEdge };

  // ── Prepare flow data ────────────────────────────
  var flowNodes = GRAPH_DATA.nodes.map(function(n) {
    return Object.assign({}, n, { type: 'atomicCard' });
  });
  var flowEdges = GRAPH_DATA.edges.map(function(e) {
    return Object.assign({}, e, { type: 'animatedEdge' });
  });

  // ── Drawer Logic ─────────────────────────────────
  var nodeMap = {};
  GRAPH_DATA.nodes.forEach(function(n) { nodeMap[n.id] = n; });

  function openDrawer(nodeId) {
    var n = nodeMap[nodeId];
    if (!n) return;
    var nd = n.data.node;
    var color = n.data.color;

    var connEdges = GRAPH_DATA.edges.filter(function(e) { return e.source === nodeId || e.target === nodeId; });
    var connIds = {};
    connEdges.forEach(function(e) { connIds[e.source] = true; connIds[e.target] = true; });
    delete connIds[nodeId];

    var html = '<h2 style="color:' + color + '">' + nd.title + '</h2>';
    html += '<div class="summary">' + nd.summary + '</div>';
    if (nd.content && nd.content !== nd.summary) {
      html += '<div class="content">' + nd.content + '</div>';
    }
    if (nd.tags && nd.tags.length > 0) {
      html += '<div class="tags">' + nd.tags.map(function(t) { return '<span class="tag">' + t + '</span>'; }).join('') + '</div>';
    }
    if (Object.keys(connIds).length > 0) {
      html += '<div class="connections"><h4>Connections (' + connEdges.length + ')</h4>';
      Object.keys(connIds).forEach(function(cid) {
        var cn = nodeMap[cid];
        if (!cn) return;
        var edge = connEdges.find(function(e) { return (e.source === nodeId && e.target === cid) || (e.target === nodeId && e.source === cid); });
        var label = (edge && edge.data && edge.data.label) || '';
        html += '<div class="conn-item" onclick="window.__openDrawer(\\'' + cid + '\\')"><span style="color:#6366f1">\\u2192</span> ' + cn.data.node.title + (label ? ' <span class="conn-label">' + label + '</span>' : '') + '</div>';
      });
      html += '</div>';
    }

    document.getElementById('drawerContent').innerHTML = html;
    document.getElementById('drawer').classList.add('open');
    document.getElementById('drawerOverlay').classList.add('open');
  }

  window.__openDrawer = openDrawer;

  document.getElementById('closeDrawer').addEventListener('click', function() {
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('drawerOverlay').classList.remove('open');
  });
  document.getElementById('drawerOverlay').addEventListener('click', function() {
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('drawerOverlay').classList.remove('open');
  });

  // ── React App ────────────────────────────────────
  function App() {
    var ns = useNodesState(flowNodes);
    var es = useEdgesState(flowEdges);

    return h(ReactFlow, {
      nodes: ns[0],
      edges: es[0],
      onNodesChange: ns[1],
      onEdgesChange: es[1],
      nodeTypes: nodeTypes,
      edgeTypes: edgeTypes,
      fitView: true,
      fitViewOptions: { padding: 0.2 },
      minZoom: 0.1,
      maxZoom: 2,
      proOptions: { hideAttribution: true },
      style: { background: '#0a0a1a' },
      onPaneClick: function() {
        document.getElementById('drawer').classList.remove('open');
        document.getElementById('drawerOverlay').classList.remove('open');
      }
    },
      h(Background, { variant: BackgroundVariant.Dots, gap: 24, size: 1, color: '#2a2a5a' }),
      h(Controls, null),
      h(MiniMap, {
        nodeColor: function(node) { return (node.data && node.data.color) || '#6366f1'; },
        maskColor: 'rgba(10, 10, 26, 0.85)',
        style: { background: '#12122a', border: '1px solid #2a2a5a', borderRadius: '8px' }
      })
    );
  }

  var root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(h(App));
})();
</script>
</body>
</html>`;
}
