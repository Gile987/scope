// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Extension: arch-diagram
// Architecture diagram canvas with ELK.js auto-layout

import { createServer } from "node:http";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const servers = new Map();

function renderHtml() {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Scope Architecture</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #root { width: 100%; height: 100%; overflow: hidden; background: #0d1117; }
.react-flow__node { font-family: -apple-system, system-ui, sans-serif; font-size: 13px; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
import React from "https://esm.sh/react@18.3.1";
import ReactDOM from "https://esm.sh/react-dom@18.3.1/client?external=react&alias=react:https://esm.sh/react@18.3.1";
import { ReactFlow, Background, Controls, useNodesState, useEdgesState, Position, MarkerType } from "https://esm.sh/@xyflow/react@12.6.0?external=react,react-dom&alias=react:https://esm.sh/react@18.3.1,react-dom:https://esm.sh/react-dom@18.3.1";
import ELK from "https://esm.sh/elkjs@0.9.3/lib/elk.bundled.js";

const { createElement: h } = React;

// Inject React Flow styles
const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "https://esm.sh/@xyflow/react@12.6.0/dist/style.css";
document.head.appendChild(link);

const nodeWidth = 160;
const nodeHeight = 50;

const initialNodes = [
  { id: "portal", data: { label: "Portal" }, style: { background: "#161b22", border: "2px solid #58a6ff", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "cli", data: { label: "CLI" }, style: { background: "#161b22", border: "2px solid #58a6ff", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "api", data: { label: "API" }, style: { background: "#161b22", border: "2px solid #79c0ff", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "queue", data: { label: "Worker Queue" }, style: { background: "#1c1030", border: "2px solid #d2a8ff", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "copilot_worker", data: { label: "Copilot Worker" }, style: { background: "#0d2818", border: "2px solid #7ee787", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "claude_worker", data: { label: "Claude Code Worker" }, style: { background: "#0d2818", border: "2px solid #7ee787", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "vscode_worker", data: { label: "VS Code Web Worker" }, style: { background: "#0d2818", border: "2px solid #7ee787", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "judge", data: { label: "Judge" }, style: { background: "#2a1a00", border: "2px solid #ffa657", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "post_proc", data: { label: "Post Processors" }, style: { background: "#2a1a00", border: "2px solid #ffa657", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "report_agent", data: { label: "Reporting Agent" }, style: { background: "#2d1215", border: "2px solid #ff7b72", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "mongodb", data: { label: "MongoDB" }, style: { background: "#161b22", border: "2px solid #8b949e", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
  { id: "blob", data: { label: "Blob Storage" }, style: { background: "#161b22", border: "2px solid #8b949e", color: "#e6edf3", borderRadius: 8, width: nodeWidth } },
];

const initialEdges = [
  { id: "e1", source: "portal", target: "api", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e2", source: "cli", target: "api", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e3", source: "api", target: "queue", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e4", source: "queue", target: "copilot_worker", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e5", source: "queue", target: "claude_worker", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e6", source: "queue", target: "vscode_worker", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e7", source: "copilot_worker", target: "judge", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e8", source: "claude_worker", target: "judge", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e9", source: "vscode_worker", target: "judge", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e10", source: "judge", target: "post_proc", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e11", source: "post_proc", target: "report_agent", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e" } },
  { id: "e12", source: "api", target: "mongodb", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e", strokeDasharray: "5 5" } },
  { id: "e13", source: "judge", target: "mongodb", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e", strokeDasharray: "5 5" } },
  { id: "e14", source: "copilot_worker", target: "blob", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e", strokeDasharray: "5 5" } },
  { id: "e15", source: "claude_worker", target: "blob", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e", strokeDasharray: "5 5" } },
  { id: "e16", source: "vscode_worker", target: "blob", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e", strokeDasharray: "5 5" } },
  { id: "e17", source: "report_agent", target: "mongodb", markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e" }, style: { stroke: "#8b949e", strokeDasharray: "5 5" } },
];

async function getLayoutedElements(nodes, edges) {
  const elk = new ELK();
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    children: nodes.map((n) => ({ id: n.id, width: nodeWidth, height: nodeHeight })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const layout = await elk.layout(graph);

  const layoutedNodes = nodes.map((node) => {
    const elkNode = layout.children.find((n) => n.id === node.id);
    return {
      ...node,
      position: { x: elkNode.x, y: elkNode.y },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });

  return { nodes: layoutedNodes, edges };
}

const { nodes: layoutedNodes, edges: layoutedEdges } = await getLayoutedElements(initialNodes, initialEdges);

function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  return h(ReactFlow, {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    fitView: true,
    colorMode: "dark",
    proOptions: { hideAttribution: true },
    minZoom: 0.3,
    maxZoom: 2,
  },
    h(Background, { color: "#30363d", gap: 20 }),
    h(Controls, { showInteractive: false })
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(h(App));
</script>
</body>
</html>`;
}

async function startServer(instanceId) {
    const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHtml());
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "arch-diagram",
            displayName: "Architecture Diagram",
            description: "Interactive architecture diagram with ELK.js auto-layout showing system components and their relationships.",
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Scope Architecture", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
