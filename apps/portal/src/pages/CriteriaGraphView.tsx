// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { List, Plus, X } from "lucide-react";
import type { CriteriaGraphData } from "@/types";
import { GATE_ORDER, GATE_METADATA, isCriterionCompatibleWithGate, type GateId } from "@/lib/gates";
import { useVisibleGates } from "@/hooks/useVisibleGates";
import { useRef, useState, useMemo } from "react";

// Simple DAG layout using topological sort + layering
function layoutGraph(graph: CriteriaGraphData) {
  const { nodes, edges } = graph;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    children.set(n.id, []);
  }
  for (const e of edges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    children.get(e.source)?.push(e.target);
  }

  // Topological layering (Kahn's algorithm)
  const layers: string[][] = [];
  let queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);

  while (queue.length > 0) {
    layers.push([...queue]);
    const next: string[] = [];
    for (const id of queue) {
      for (const child of children.get(id) ?? []) {
        const deg = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, deg);
        if (deg === 0) next.push(child);
      }
    }
    queue = next;
  }

  // Assign positions with dynamic node widths
  const NODE_H = 60;
  const H_GAP = 40;
  const V_GAP = 80;
  const CHAR_WIDTH_PX = 7.5; // slightly wider for SVG text rendering
  const NODE_PADDING_PX = 40;
  const NODE_MIN_W = 180;

  const nodeWidths = new Map<string, number>();
  for (const n of nodes) {
    const w = Math.max(NODE_MIN_W, Math.ceil(n.id.length * CHAR_WIDTH_PX + NODE_PADDING_PX));
    nodeWidths.set(n.id, w);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (let layer = 0; layer < layers.length; layer++) {
    const row = layers[layer];
    const totalWidth = row.reduce((sum, id) => sum + (nodeWidths.get(id) ?? NODE_MIN_W), 0) + (row.length - 1) * H_GAP;
    let curX = -totalWidth / 2;
    for (let i = 0; i < row.length; i++) {
      const w = nodeWidths.get(row[i]) ?? NODE_MIN_W;
      positions.set(row[i], {
        x: curX + w / 2,
        y: layer * (NODE_H + V_GAP),
      });
      curX += w + H_GAP;
    }
  }

  const totalH = layers.length * (NODE_H + V_GAP) - V_GAP;
  const allX = [...positions.entries()].map(([id, p]) => {
    const w = nodeWidths.get(id) ?? NODE_MIN_W;
    return [p.x - w / 2, p.x + w / 2];
  }).flat();
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const totalW = maxX - minX;

  return { nodeMap, positions, nodeWidths, NODE_MIN_W, NODE_H, totalW, totalH, minX, edges };
}

export function CriteriaGraphView() {
  const { data: graph, isLoading } = useQuery({
    queryKey: ["criteria-graph"],
    queryFn: api.getCriteriaGraph,
  });

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedGates, setSelectedGates] = useState<GateId[]>([]);
  const visibleGates = useVisibleGates();

  const toggleGate = (gate: GateId) =>
    setSelectedGates((prev) => (prev.includes(gate) ? prev.filter((g) => g !== gate) : [...prev, gate]));

  // Gate option counts come from the unfiltered graph so they stay stable.
  const gateCounts = useMemo(() => {
    const counts = new Map<GateId, number>();
    for (const gate of GATE_ORDER) {
      counts.set(gate, (graph?.nodes ?? []).filter((n) => isCriterionCompatibleWithGate(n.gates, gate)).length);
    }
    return counts;
  }, [graph]);

  // Filter to nodes compatible with any selected gate (OR); drop edges whose
  // endpoints were filtered out so the DAG layout stays consistent.
  const filteredGraph = useMemo<CriteriaGraphData | null>(() => {
    if (!graph) return null;
    if (selectedGates.length === 0) return graph;
    const nodes = graph.nodes.filter((n) => selectedGates.some((g) => isCriterionCompatibleWithGate(n.gates, g)));
    const kept = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target));
    return { nodes, edges };
  }, [graph, selectedGates]);

  // Compute layout
  const layout = useMemo(() => (filteredGraph ? layoutGraph(filteredGraph) : null), [filteredGraph]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[500px] w-full" />
      </div>
    );
  }

  if (!graph) {
    return (
      <div className="text-center py-12 text-muted-foreground">No criteria data</div>
    );
  }

  const gateFilterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Gate:</span>
      {visibleGates.map((gate) => {
        const active = selectedGates.includes(gate);
        const count = gateCounts.get(gate) ?? 0;
        return (
          <button key={gate} type="button" onClick={() => toggleGate(gate)} className="focus:outline-none">
            <Badge variant={active ? "default" : "outline"} className="cursor-pointer gap-1">
              {GATE_METADATA[gate].label}
              <span className="opacity-60">{count}</span>
            </Badge>
          </button>
        );
      })}
      {selectedGates.length > 0 && (
        <button
          type="button"
          onClick={() => setSelectedGates([])}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" /> Clear
        </button>
      )}
    </div>
  );

  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Criteria Graph</h1>
        <p className="text-muted-foreground">
          Dependency DAG — {filteredGraph!.nodes.length}
          {selectedGates.length > 0 ? ` of ${graph.nodes.length}` : ""} criteria, {filteredGraph!.edges.length} edges
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Link to="/criteria">
          <Button variant="outline" className="gap-1.5">
            <List className="h-4 w-4" /> List View
          </Button>
        </Link>
        <Link to="/criteria/new">
          <Button className="gap-1.5">
            <Plus className="h-4 w-4" /> New Criterion
          </Button>
        </Link>
      </div>
    </div>
  );

  if (!layout || filteredGraph!.nodes.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        {gateFilterBar}
        <div className="text-center py-12 text-muted-foreground">
          No criteria are compatible with the selected gate{selectedGates.length > 1 ? "s" : ""}.
        </div>
      </div>
    );
  }

  const { nodeMap, positions, nodeWidths, NODE_MIN_W, NODE_H, totalW, totalH, minX, edges } = layout;
  const PADDING = 60;
  const viewBox = `${minX - PADDING} ${-PADDING} ${totalW + PADDING * 2} ${totalH + PADDING * 2 + NODE_H}`;

  // Edges connected to hovered node
  const hoveredEdges = new Set<string>();
  const hoveredNodes = new Set<string>();
  if (hoveredNode) {
    hoveredNodes.add(hoveredNode);
    for (const e of edges) {
      if (e.source === hoveredNode || e.target === hoveredNode) {
        hoveredEdges.add(`${e.source}->${e.target}`);
        hoveredNodes.add(e.source);
        hoveredNodes.add(e.target);
      }
    }
  }

  return (
    <div className="space-y-6">
      {header}
      {gateFilterBar}

      <Card>
        <CardContent className="p-2">
          <div ref={containerRef} className="overflow-auto max-h-[70vh] rounded">
            <svg
              ref={svgRef}
              viewBox={viewBox}
              className="w-full min-h-[400px]"
              style={{ minWidth: Math.max(600, totalW + PADDING * 2) }}
            >
              <defs>
                <marker
                  id="arrowhead"
                  markerWidth="10"
                  markerHeight="7"
                  refX="10"
                  refY="3.5"
                  orient="auto"
                >
                  <polygon points="0 0, 10 3.5, 0 7" className="fill-muted-foreground/50" />
                </marker>
                <marker
                  id="arrowhead-active"
                  markerWidth="10"
                  markerHeight="7"
                  refX="10"
                  refY="3.5"
                  orient="auto"
                >
                  <polygon points="0 0, 10 3.5, 0 7" className="fill-primary" />
                </marker>
              </defs>

              {/* Edges */}
              {edges.map((e) => {
                const from = positions.get(e.source);
                const to = positions.get(e.target);
                if (!from || !to) return null;
                const edgeKey = `${e.source}->${e.target}`;
                const isActive = hoveredEdges.has(edgeKey);
                return (
                  <line
                    key={edgeKey}
                    x1={from.x}
                    y1={from.y + NODE_H}
                    x2={to.x}
                    y2={to.y}
                    strokeWidth={isActive ? 2 : 1}
                    className={isActive ? "stroke-primary" : "stroke-muted-foreground/30"}
                    markerEnd={isActive ? "url(#arrowhead-active)" : "url(#arrowhead)"}
                  />
                );
              })}

              {/* Nodes */}
              {[...positions.entries()].map(([id, pos]) => {
                const node = nodeMap.get(id);
                if (!node) return null;
                const deps = node.dependsOn?.length ?? 0;
                const isActive = hoveredNode ? hoveredNodes.has(id) : true;
                const nodeW = nodeWidths.get(id) ?? NODE_MIN_W;
                return (
                  <g
                    key={id}
                    transform={`translate(${pos.x - nodeW / 2}, ${pos.y})`}
                    onMouseEnter={() => setHoveredNode(id)}
                    onMouseLeave={() => setHoveredNode(null)}
                    className="cursor-pointer"
                  >
                    <Link to={`/criteria/${id}`}>
                      <rect
                        width={nodeW}
                        height={NODE_H}
                        rx={8}
                        className={
                          isActive
                            ? "fill-background stroke-primary stroke-2"
                            : "fill-muted/50 stroke-muted-foreground/20 stroke-1"
                        }
                      />
                      <text
                        x={nodeW / 2}
                        y={NODE_H / 2 - 4}
                        textAnchor="middle"
                        className={`text-xs font-mono font-medium ${isActive ? "fill-foreground" : "fill-muted-foreground/50"}`}
                      >
                        {id}
                      </text>
                      <text
                        x={nodeW / 2}
                        y={NODE_H / 2 + 12}
                        textAnchor="middle"
                        className={`text-[10px] ${isActive ? "fill-muted-foreground" : "fill-muted-foreground/30"}`}
                      >
                        {deps > 0 ? `${deps} dep${deps > 1 ? "s" : ""}` : "root"}
                      </text>
                    </Link>
                  </g>
                );
              })}
            </svg>
          </div>
        </CardContent>
      </Card>

      {/* Legend */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded border-2 border-primary bg-background" />
          Criterion node
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-6 h-0.5 bg-muted-foreground/30" />
          Dependency edge (parent → child)
        </div>
        <span>Hover a node to highlight its connections</span>
      </div>
    </div>
  );
}
