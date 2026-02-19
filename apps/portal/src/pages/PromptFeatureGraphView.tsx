// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { List, Plus } from "lucide-react";
import type { PromptFeatureGraphData } from "@/types";
import { useRef, useState, useMemo } from "react";

// Simple DAG layout using topological sort + layering
function layoutGraph(graph: PromptFeatureGraphData) {
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

  // Assign positions
  const NODE_W = 180;
  const NODE_H = 60;
  const H_GAP = 40;
  const V_GAP = 80;

  const positions = new Map<string, { x: number; y: number }>();
  for (let layer = 0; layer < layers.length; layer++) {
    const row = layers[layer];
    const totalWidth = row.length * NODE_W + (row.length - 1) * H_GAP;
    const startX = -totalWidth / 2 + NODE_W / 2;
    for (let i = 0; i < row.length; i++) {
      positions.set(row[i], {
        x: startX + i * (NODE_W + H_GAP),
        y: layer * (NODE_H + V_GAP),
      });
    }
  }

  const totalH = layers.length * (NODE_H + V_GAP) - V_GAP;
  const allX = [...positions.values()].map((p) => p.x);
  const minX = Math.min(...allX) - NODE_W / 2;
  const maxX = Math.max(...allX) + NODE_W / 2;
  const totalW = maxX - minX;

  return { nodeMap, positions, NODE_W, NODE_H, totalW, totalH, minX, edges };
}

export function PromptFeatureGraphView() {
  const { data: graph, isLoading } = useQuery({
    queryKey: ["prompt-features-graph"],
    queryFn: api.getPromptFeatureGraph,
  });

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Compute layout
  const layout = useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[500px] w-full" />
      </div>
    );
  }

  if (!graph || !layout) {
    return (
      <div className="text-center py-12 text-muted-foreground">No prompt feature data</div>
    );
  }

  const { nodeMap, positions, NODE_W, NODE_H, totalW, totalH, minX, edges } = layout;
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Prompt Feature Graph</h1>
          <p className="text-muted-foreground">
            Dependency DAG — {graph.nodes.length} features, {graph.edges.length} edges
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/prompt-features">
            <Button variant="outline" className="gap-1.5">
              <List className="h-4 w-4" /> List View
            </Button>
          </Link>
          <Link to="/prompt-features/new">
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" /> New Feature
            </Button>
          </Link>
        </div>
      </div>

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
                  id="pf-arrowhead"
                  markerWidth="10"
                  markerHeight="7"
                  refX="10"
                  refY="3.5"
                  orient="auto"
                >
                  <polygon points="0 0, 10 3.5, 0 7" className="fill-muted-foreground/50" />
                </marker>
                <marker
                  id="pf-arrowhead-active"
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
                    markerEnd={isActive ? "url(#pf-arrowhead-active)" : "url(#pf-arrowhead)"}
                  />
                );
              })}

              {/* Nodes */}
              {[...positions.entries()].map(([id, pos]) => {
                const node = nodeMap.get(id);
                if (!node) return null;
                const deps = node.dependsOn?.length ?? 0;
                const isActive = hoveredNode ? hoveredNodes.has(id) : true;
                return (
                  <g
                    key={id}
                    transform={`translate(${pos.x - NODE_W / 2}, ${pos.y})`}
                    onMouseEnter={() => setHoveredNode(id)}
                    onMouseLeave={() => setHoveredNode(null)}
                    className="cursor-pointer"
                  >
                    <Link to={`/prompt-features/${id}`}>
                      <rect
                        width={NODE_W}
                        height={NODE_H}
                        rx={8}
                        className={
                          isActive
                            ? "fill-background stroke-primary stroke-2"
                            : "fill-muted/50 stroke-muted-foreground/20 stroke-1"
                        }
                      />
                      <text
                        x={NODE_W / 2}
                        y={NODE_H / 2 - 4}
                        textAnchor="middle"
                        className={`text-xs font-mono font-medium ${isActive ? "fill-foreground" : "fill-muted-foreground/50"}`}
                      >
                        {id}
                      </text>
                      <text
                        x={NODE_W / 2}
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
          Feature node
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
