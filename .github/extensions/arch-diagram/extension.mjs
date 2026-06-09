// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Extension: arch-diagram
// Architecture diagram canvas with ELK.js auto-layout

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const __dirname = dirname(fileURLToPath(import.meta.url));
const diagramPath = resolve(__dirname, "../../../docs/architecture/diagram.json");

function loadDiagramData() {
  return JSON.parse(readFileSync(diagramPath, "utf-8"));
}

let diagramData = loadDiagramData();

const servers = new Map();
// SSE clients per instance for pushing updates
const sseClients = new Map(); // instanceId → Set<res>

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
.react-flow__edge-textwrapper .react-flow__edge-text { font-size: 10px; fill: #8b949e; }
.react-flow__edge-text { fill: #8b949e !important; }
.react-flow__edge-textbg { fill: #0d1117 !important; }
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

// Diagram data injected from server
const diagramData = ${JSON.stringify(diagramData)};

// Derive React Flow nodes and edges from semantic data
const groupStyle = { borderRadius: 12, padding: 10 };
const edgeColors = { sync: "#8b949e", async: "#d2a8ff", storage: "#8b949e" };

function colorToBg(color) {
  // Map border color to a dark background
  const map = { "#58a6ff": "#161b22", "#79c0ff": "#161b22", "#7ee787": "#0d2818", "#ffa657": "#2a1a00", "#ff7b72": "#2d1215", "#8b949e": "#161b22" };
  return map[color] || "#161b22";
}

const initialNodes = [
  ...diagramData.groups.map(g => ({
    id: g.id,
    data: { label: g.label },
    style: { ...groupStyle, background: g.color + "0d", border: "1px dashed " + g.color, color: g.color },
  })),
  ...diagramData.nodes.map(n => ({
    id: n.id,
    ...(n.group ? { parentId: n.group, extent: "parent" } : {}),
    data: { label: n.label },
    style: { background: colorToBg(n.color), border: "2px solid " + n.color, color: "#e6edf3", borderRadius: 8, width: nodeWidth },
  })),
];

const initialEdges = diagramData.edges.map(e => ({
  id: e.id,
  source: e.source,
  target: e.target,
  label: e.label,
  markerEnd: { type: MarkerType.ArrowClosed, color: edgeColors[e.type] },
  style: { stroke: edgeColors[e.type], ...(e.type === "storage" ? { strokeDasharray: "5 5" } : {}) },
}));

async function getLayoutedElements(nodes, edges, algorithm = "layered") {
  const elk = new ELK();

  // Build ELK compound graph with groups
  const groupIds = new Set(nodes.filter(n => n.parentId).map(n => n.parentId));
  const groups = nodes.filter((n) => groupIds.has(n.id));
  const leafNodes = nodes.filter((n) => !groupIds.has(n.id));

  const groupChildren = {};
  for (const g of groups) groupChildren[g.id] = [];
  for (const n of leafNodes) {
    if (n.parentId && groupChildren[n.parentId]) {
      groupChildren[n.parentId].push({ id: n.id, width: nodeWidth, height: nodeHeight });
    }
  }

  const topLevelChildren = [];
  for (const g of groups) {
    topLevelChildren.push({
      id: g.id,
      layoutOptions: {
        "elk.padding": "[top=40,left=20,bottom=20,right=20]",
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": "20",
      },
      children: groupChildren[g.id],
    });
  }
  // Add ungrouped nodes
  for (const n of leafNodes) {
    if (!n.parentId) {
      topLevelChildren.push({ id: n.id, width: nodeWidth, height: nodeHeight });
    }
  }

  // Algorithm-specific layout options
  const algoOptions = {
    layered: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    stress: {
      "elk.algorithm": "stress",
      "elk.stress.desiredEdgeLength": "150",
      "elk.spacing.nodeNode": "60",
    },
    force: {
      "elk.algorithm": "force",
      "elk.force.iterations": "300",
      "elk.spacing.nodeNode": "60",
    },
    mrtree: {
      "elk.algorithm": "mrtree",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "40",
      "elk.mrtree.weighting": "CONSTRAINT",
    },
  };

  const graph = {
    id: "root",
    layoutOptions: algoOptions[algorithm] || algoOptions.layered,
    children: topLevelChildren,
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const layout = await elk.layout(graph);

  // Flatten positions from compound layout
  const positions = {};
  for (const child of layout.children) {
    if (child.children) {
      // This is a group — record group position and child positions relative to it
      positions[child.id] = { x: child.x, y: child.y, width: child.width, height: child.height };
      for (const inner of child.children) {
        positions[inner.id] = { x: inner.x, y: inner.y };
      }
    } else {
      positions[child.id] = { x: child.x, y: child.y };
    }
  }

  const layoutedNodes = nodes.map((node) => {
    const pos = positions[node.id];
    if (groupIds.has(node.id)) {
      return {
        ...node,
        position: { x: pos.x, y: pos.y },
        style: { ...node.style, width: pos.width, height: pos.height },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
      };
    }
    return {
      ...node,
      position: { x: pos.x, y: pos.y },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });

  return { nodes: layoutedNodes, edges };
}

const { nodes: layoutedNodes, edges: layoutedEdges } = await getLayoutedElements(initialNodes, initialEdges, diagramData.layout || "layered");

function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);
  const [refreshing, setRefreshing] = React.useState(false);
  const [algorithm, setAlgorithm] = React.useState(diagramData.layout || "layered");

  const relayout = async (algo) => {
    const layout = await getLayoutedElements(initialNodes, initialEdges, algo);
    setNodes(layout.nodes);
    setEdges(layout.edges);
  };

  const handleAlgoChange = async (e) => {
    const algo = e.target.value;
    setAlgorithm(algo);
    await relayout(algo);
  };

  React.useEffect(() => {
    const es = new EventSource("/events");
    es.onmessage = async (event) => {
      const newData = JSON.parse(event.data);
      // Re-derive nodes and edges from updated data
      const newNodes = [
        ...newData.groups.map(g => ({
          id: g.id,
          data: { label: g.label },
          style: { ...groupStyle, background: g.color + "0d", border: "1px dashed " + g.color, color: g.color },
        })),
        ...newData.nodes.map(n => ({
          id: n.id,
          ...(n.group ? { parentId: n.group, extent: "parent" } : {}),
          data: { label: n.label },
          style: { background: colorToBg(n.color), border: "2px solid " + n.color, color: "#e6edf3", borderRadius: 8, width: nodeWidth },
        })),
      ];
      const newEdges = newData.edges.map(e => ({
        id: e.id, source: e.source, target: e.target, label: e.label,
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeColors[e.type] },
        style: { stroke: edgeColors[e.type], ...(e.type === "storage" ? { strokeDasharray: "5 5" } : {}) },
      }));
      const layout = await getLayoutedElements(newNodes, newEdges, algorithm);
      setNodes(layout.nodes);
      setEdges(layout.edges);
      setRefreshing(false);
    };
    return () => es.close();
  }, [algorithm]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetch("/refresh", { method: "POST" });
  };

  const controlStyle = {
    position: "absolute", top: 12, zIndex: 10,
    background: "#161b22", color: "#e6edf3",
    border: "1px solid #3d444d", borderRadius: 6, padding: "6px 12px",
    fontSize: 12, cursor: "pointer",
  };

  return h("div", { style: { width: "100%", height: "100%", position: "relative" } },
    h(ReactFlow, {
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
    ),
    h("select", {
      value: algorithm,
      onChange: handleAlgoChange,
      style: { ...controlStyle, right: 200 },
    },
      h("option", { value: "layered" }, "Layered"),
      h("option", { value: "stress" }, "Stress"),
      h("option", { value: "force" }, "Force"),
      h("option", { value: "mrtree" }, "MR Tree")
    ),
    h("button", {
      onClick: handleRefresh,
      disabled: refreshing,
      style: {
        ...controlStyle, right: 12,
        background: refreshing ? "#30363d" : "#238636",
        display: "flex", alignItems: "center", gap: 6,
      },
    }, refreshing ? "⏳ Analyzing..." : "🔄 Refresh from codebase")
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
        const url = new URL(req.url, "http://localhost");

        if (url.pathname === "/events" && req.method === "GET") {
            // SSE endpoint
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            if (!sseClients.has(instanceId)) sseClients.set(instanceId, new Set());
            sseClients.get(instanceId).add(res);
            req.on("close", () => {
                const clients = sseClients.get(instanceId);
                if (clients) clients.delete(res);
            });
            return;
        }

        if (url.pathname === "/refresh" && req.method === "POST") {
            // Trigger agent to analyze codebase
            res.writeHead(202, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ status: "analyzing" }));
            triggerRefresh(instanceId);
            return;
        }

        if (req.method === "OPTIONS") {
            res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
            res.end();
            return;
        }

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHtml());
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

let session;

async function triggerRefresh(instanceId) {
    // Send message to the agent to analyze the codebase
    const prompt = `Analyze the codebase structure and update docs/architecture/diagram.json to reflect the current architecture. Read the existing file first, then look at the actual project structure (apps/, packages/, workers) and update nodes, edges, and groups accordingly. Keep the same JSON schema. Only update what has changed.`;
    await session.sendAndWait(prompt);
    // Re-read the file after agent updates it
    diagramData = loadDiagramData();
    // Push update to all SSE clients for this instance
    pushUpdate(instanceId);
}

function pushUpdate(instanceId) {
    const clients = sseClients.get(instanceId);
    if (!clients) return;
    const payload = JSON.stringify(diagramData);
    for (const res of clients) {
        res.write(`data: ${payload}\n\n`);
    }
}

session = await joinSession({
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
