// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
  Position,
  Handle,
  type NodeProps,
} from "@xyflow/react";
import dagre from "dagre";
import { api } from "@/lib/api";
import type { LogEvent, CriterionResult } from "@/types";
import { cn } from "@/lib/utils";
import "@xyflow/react/dist/style.css";

// ─── Types ───────────────────────────────────────────────────────────────────

type CriterionStatus = "pending" | "passed" | "failed" | "skipped";

interface CriterionNodeData {
  label: string;
  prompt: string;
  status: CriterionStatus;
  iteration?: number;
  feedback?: string;
  [key: string]: unknown;
}

// ─── Dagre layout helper ─────────────────────────────────────────────────────

const NODE_WIDTH = 160;
const NODE_HEIGHT = 44;

function layoutGraph(
  nodes: Node<CriterionNodeData>[],
  edges: Edge[]
): { nodes: Node<CriterionNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 50 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const laidOut = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });

  return { nodes: laidOut, edges };
}

// ─── Custom node component ──────────────────────────────────────────────────

const statusStyles: Record<CriterionStatus, string> = {
  pending:
    "bg-slate-800 border-slate-600 text-slate-300",
  passed:
    "bg-emerald-900/60 border-emerald-500 text-emerald-200",
  failed:
    "bg-red-900/60 border-red-500 text-red-200",
  skipped:
    "bg-slate-800/50 border-slate-700 border-dashed text-slate-500",
};

const statusDot: Record<CriterionStatus, string> = {
  pending: "bg-slate-500",
  passed: "bg-emerald-400",
  failed: "bg-red-400",
  skipped: "bg-slate-600",
};

function CriterionNode({ data }: NodeProps<Node<CriterionNodeData>>) {
  const status = data.status as CriterionStatus;
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs font-mono shadow-sm min-w-[140px] max-w-[180px] text-center",
        statusStyles[status]
      )}
      title={data.prompt}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-500 !w-2 !h-2 !border-0" />
      <div className="flex items-center justify-center gap-1.5 truncate">
        <span className={cn("w-2 h-2 rounded-full shrink-0", statusDot[status])} />
        <span className="truncate">{data.label}</span>
      </div>
      {data.iteration !== undefined && (
        <div className="text-[10px] opacity-60 mt-0.5">iter {data.iteration}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-slate-500 !w-2 !h-2 !border-0" />
    </div>
  );
}

const nodeTypes = { criterion: CriterionNode };

// ─── Build the filtered subgraph ────────────────────────────────────────────

function collectAncestors(
  criteriaIds: string[],
  nodeMap: Map<string, { id: string; prompt: string; dependsOn: string[] }>
): Set<string> {
  const included = new Set<string>();
  const queue = [...criteriaIds];

  while (queue.length > 0) {
    const id = queue.pop()!;
    if (included.has(id)) continue;
    const node = nodeMap.get(id);
    if (!node) continue;
    included.add(id);
    for (const dep of node.dependsOn) {
      if (!included.has(dep)) queue.push(dep);
    }
  }
  return included;
}

// ─── Extract criteria results from streaming logs ───────────────────────────

function extractCriteriaStatus(logs: LogEvent[]): Map<string, CriterionResult & { iteration?: number }> {
  const statusMap = new Map<string, CriterionResult & { iteration?: number }>();

  for (const log of logs) {
    if (!log.data) continue;

    if (log.data.type === "criterion_result") {
      const d = log.data;
      statusMap.set(d.criterionId as string, {
        criterionId: d.criterionId as string,
        passed: d.passed as boolean,
        evaluated: d.evaluated as boolean,
        feedback: (d.feedback as string) ?? "",
        iteration: d.iteration as number | undefined,
      });
    }

    // Also handle the batch criteria_dag_status event
    if (log.data.type === "criteria_dag_status" && Array.isArray(log.data.results)) {
      const iteration = log.data.iteration as number | undefined;
      for (const r of log.data.results as Array<Record<string, unknown>>) {
        statusMap.set(r.criterionId as string, {
          criterionId: r.criterionId as string,
          passed: r.passed as boolean,
          evaluated: r.evaluated as boolean,
          feedback: (r.feedback as string) ?? "",
          iteration,
        });
      }
    }
  }

  return statusMap;
}

// ─── Main component ─────────────────────────────────────────────────────────

interface CriteriaGraphViewProps {
  /** The criteria IDs selected for this run's scenario */
  scenarioCriteria: string[];
  /** Streaming log events — used to derive real-time criteria status */
  logs: LogEvent[];
}

export function CriteriaGraphView({ scenarioCriteria, logs }: CriteriaGraphViewProps) {
  // Fetch the full criteria graph from the API
  const { data: graphData, isLoading } = useQuery({
    queryKey: ["criteria-graph"],
    queryFn: () => api.getCriteriaGraph(),
    staleTime: 5 * 60 * 1000, // Graph structure rarely changes
  });

  // Derive criteria status from streaming logs
  const criteriaStatus = useMemo(() => extractCriteriaStatus(logs), [logs]);

  // Build the filtered React Flow graph
  const { flowNodes, flowEdges } = useMemo(() => {
    if (!graphData) return { flowNodes: [], flowEdges: [] };

    const nodeMap = new Map(graphData.nodes.map((n) => [n.id, n]));
    const included = collectAncestors(scenarioCriteria, nodeMap);

    // If no criteria match the graph, return empty
    if (included.size === 0) return { flowNodes: [], flowEdges: [] };

    // Build nodes
    const rawNodes: Node<CriterionNodeData>[] = [];
    for (const id of included) {
      const node = nodeMap.get(id);
      if (!node) continue;

      const result = criteriaStatus.get(id);
      let status: CriterionStatus = "pending";
      if (result) {
        if (!result.evaluated) status = "skipped";
        else if (result.passed) status = "passed";
        else status = "failed";
      }

      rawNodes.push({
        id,
        type: "criterion",
        position: { x: 0, y: 0 }, // Will be set by dagre
        data: {
          label: id,
          prompt: node.prompt,
          status,
          iteration: result?.iteration,
          feedback: result?.feedback,
        },
      });
    }

    // Build edges (only for included nodes)
    const rawEdges: Edge[] = graphData.edges
      .filter((e) => included.has(e.source) && included.has(e.target))
      .map((e) => ({
        id: `${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        style: { stroke: "#475569" },
        animated: false,
      }));

    const laid = layoutGraph(rawNodes, rawEdges);
    return { flowNodes: laid.nodes, flowEdges: laid.edges };
  }, [graphData, scenarioCriteria, criteriaStatus]);

  if (isLoading) {
    return (
      <div className="h-[250px] rounded-md border bg-slate-950 flex items-center justify-center text-xs text-slate-500">
        Loading criteria graph…
      </div>
    );
  }

  if (flowNodes.length === 0) {
    return null; // No graph to show (v1 scenario or no matching criteria)
  }

  return (
    <div className="h-[250px] rounded-md border bg-slate-950 overflow-hidden">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        className="[&_.react-flow__renderer]:!bg-transparent"
      >
        <Background color="#1e293b" gap={16} />
      </ReactFlow>

      {/* Legend */}
      <div className="absolute bottom-2 right-2 flex items-center gap-3 text-[10px] text-slate-400 bg-slate-950/80 rounded px-2 py-1">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-500" /> Pending</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" /> Passed</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" /> Failed</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-600" /> Skipped</span>
      </div>
    </div>
  );
}
