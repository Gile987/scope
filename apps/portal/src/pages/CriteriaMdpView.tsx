// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type EdgeProps,
  Position,
  Handle,
  type NodeProps,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
} from "@xyflow/react";
import dagre from "dagre";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { mergeMdpResponses, topologyHash } from "@/lib/mdp-utils";
import { CriteriaFilterBar } from "@/components/CriteriaFilterBar";
import { cn } from "@/lib/utils";
import type { MdpResponse, MdpCriterionState } from "@/types";
import "@xyflow/react/dist/style.css";

// ─── Constants ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;
const NODE_WIDTH = 180;
const NODE_HEIGHT_BASE = 48; // base + per-criterion row height
const NODE_ROW_HEIGHT = 20;

// ─── Dagre layout helper ─────────────────────────────────────────────────────

interface MdpNodeData {
  criteria: MdpCriterionState[];
  visits: number;
  isInitial?: boolean;
  isTerminal?: boolean;
  passedCount: number;
  totalCount: number;
  [key: string]: unknown;
}

function getNodeHeight(criteriaCount: number): number {
  return NODE_HEIGHT_BASE + criteriaCount * NODE_ROW_HEIGHT;
}

function layoutGraph(
  nodes: Node<MdpNodeData>[],
  edges: Edge[],
  criteriaCount: number
): { nodes: Node<MdpNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });

  const nodeHeight = getNodeHeight(criteriaCount);

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: nodeHeight });
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
        y: pos.y - nodeHeight / 2,
      },
    };
  });

  return { nodes: laidOut, edges };
}

// ─── Color interpolation ────────────────────────────────────────────────────

/**
 * Interpolate from red (0%) → amber (50%) → green (100%) based on pass rate.
 */
function passRateColor(rate: number): string {
  if (rate <= 0.5) {
    // red → amber
    const t = rate / 0.5;
    const r = Math.round(239 + (245 - 239) * t);
    const g = Math.round(68 + (158 - 68) * t);
    const b = Math.round(68 + (11 - 68) * t);
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    // amber → green
    const t = (rate - 0.5) / 0.5;
    const r = Math.round(245 + (34 - 245) * t);
    const g = Math.round(158 + (197 - 158) * t);
    const b = Math.round(11 + (94 - 11) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

// ─── Custom MDP state node ──────────────────────────────────────────────────

function MdpStateNodeComponent({ data }: NodeProps<Node<MdpNodeData>>) {
  const passRate = data.totalCount > 0 ? data.passedCount / data.totalCount : 0;
  const borderColor = data.isInitial
    ? "border-slate-500 border-dashed"
    : data.isTerminal
      ? "border-blue-400 border-2"
      : "border-slate-600";

  return (
    <div
      className={cn(
        "rounded-lg border bg-slate-900 px-3 py-2 text-xs font-mono shadow-md min-w-[160px]",
        borderColor
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-slate-500 !w-2 !h-2 !border-0"
      />

      {/* Header: visits badge + pass fraction */}
      <div className="flex items-center justify-between mb-1.5 gap-2">
        {data.isInitial ? (
          <span className="text-slate-400 text-[10px] italic">Start</span>
        ) : (
          <span className="text-slate-300 text-[10px]">
            {data.passedCount}/{data.totalCount}
          </span>
        )}
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
          style={{
            backgroundColor: data.isInitial ? "rgb(100,116,139)" : passRateColor(passRate),
            color: passRate > 0.6 ? "#064e3b" : "#fff",
          }}
        >
          {data.isInitial ? `×${data.visits}` : `${Math.round(passRate * 100)}%`}
        </span>
      </div>

      {/* Heatmap strip: one row per criterion */}
      <div className="flex flex-col gap-0.5">
        {data.criteria.map((c) => (
          <div
            key={c.id}
            className={cn(
              "flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10px] truncate",
              c.passed
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-red-500/20 text-red-300"
            )}
            title={`${c.id}: ${c.passed ? "passed" : "failed"}`}
          >
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full shrink-0",
                c.passed ? "bg-emerald-400" : "bg-red-400"
              )}
            />
            <span className="truncate">{c.id}</span>
          </div>
        ))}
      </div>

      {/* Visit count */}
      <div className="text-[9px] text-slate-500 mt-1 text-right">
        ×{data.visits} visits
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-slate-500 !w-2 !h-2 !border-0"
      />

      {/* Self-loop handles on the right side */}
      <Handle
        type="source"
        position={Position.Right}
        id="self-source"
        className="!bg-slate-500 !w-2 !h-2 !border-0"
        style={{ top: "35%" }}
      />
      <Handle
        type="target"
        position={Position.Right}
        id="self-target"
        className="!bg-slate-500 !w-2 !h-2 !border-0"
        style={{ top: "65%" }}
      />
    </div>
  );
}

const nodeTypes = { mdpState: MdpStateNodeComponent };

// ─── Custom edge with probability label ─────────────────────────────────────

interface MdpEdgeData {
  probability: number;
  count: number;
  [key: string]: unknown;
}

function MdpEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  source,
  target,
  data,
  style,
}: EdgeProps<Edge<MdpEdgeData>>) {
  const isSelfLoop = source === target;

  // For self-loops, draw a custom arc looping out to the right
  const loopOffset = 50;
  const selfLoopPath = isSelfLoop
    ? `M ${sourceX} ${sourceY} C ${sourceX + loopOffset * 2} ${sourceY}, ${targetX + loopOffset * 2} ${targetY}, ${targetX} ${targetY}`
    : undefined;
  const selfLoopLabelX = isSelfLoop ? sourceX + loopOffset * 1.5 : 0;
  const selfLoopLabelY = isSelfLoop ? (sourceY + targetY) / 2 : 0;

  const [bezierPath, bezierLabelX, bezierLabelY] = isSelfLoop
    ? ["" /* unused */, 0, 0]
    : getBezierPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
      });

  const edgePath = isSelfLoop ? selfLoopPath! : bezierPath;
  const labelX = isSelfLoop ? selfLoopLabelX : bezierLabelX;
  const labelY = isSelfLoop ? selfLoopLabelY : bezierLabelY;

  const probability = data?.probability ?? 0;
  const count = data?.count ?? 0;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          <span className="bg-slate-800/90 text-slate-300 text-[9px] font-mono px-1.5 py-0.5 rounded border border-slate-700">
            {Math.round(probability * 100)}% ({count})
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { mdpEdge: MdpEdge };

// ─── Main page component ────────────────────────────────────────────────────

export function CriteriaMdpView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedCriteria =
    searchParams.get("criteria")?.split(",").filter(Boolean) || [];

  // MDP state — managed manually for incremental merging
  const [mdpData, setMdpData] = useState<MdpResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const computedAtRef = useRef<string | undefined>(undefined);
  const prevCriteriaRef = useRef<string>("");

  // Track topology for layout stability
  const prevTopologyRef = useRef<string>("");
  const layoutCacheRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Full fetch (on mount or criteria change)
  const fetchFull = useCallback(async (criteria?: string[]) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.getMdp(
        criteria && criteria.length > 0 ? criteria : undefined
      );
      setMdpData(data);
      computedAtRef.current = data.computedAt;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MDP data");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Incremental fetch
  const fetchDelta = useCallback(async (criteria?: string[]) => {
    if (!computedAtRef.current) return;
    setIsPolling(true);
    try {
      const delta = await api.getMdp(
        criteria && criteria.length > 0 ? criteria : undefined,
        computedAtRef.current
      );
      if (delta.episodeCount > 0) {
        setMdpData((prev) => {
          if (!prev) return delta;
          return mergeMdpResponses(prev, delta);
        });
      }
      computedAtRef.current = delta.computedAt;
    } catch {
      // Silently ignore polling errors
    } finally {
      setIsPolling(false);
    }
  }, []);

  // Initial fetch + refetch when criteria change
  useEffect(() => {
    const criteriaKey = selectedCriteria.join(",");
    if (criteriaKey !== prevCriteriaRef.current) {
      prevCriteriaRef.current = criteriaKey;
      computedAtRef.current = undefined;
      fetchFull(selectedCriteria.length > 0 ? selectedCriteria : undefined);
    }
  }, [selectedCriteria, fetchFull]);

  // On mount
  useEffect(() => {
    prevCriteriaRef.current = selectedCriteria.join(",");
    fetchFull(selectedCriteria.length > 0 ? selectedCriteria : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling
  useEffect(() => {
    const interval = setInterval(() => {
      fetchDelta(selectedCriteria.length > 0 ? selectedCriteria : undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [selectedCriteria, fetchDelta]);

  // Build React Flow graph
  const { flowNodes, flowEdges } = useMemo(() => {
    if (!mdpData || mdpData.nodes.length === 0)
      return { flowNodes: [], flowEdges: [] };

    const criteriaCount = mdpData.nodes[0]?.criteria.length || 0;

    // Build nodes
    const rawNodes: Node<MdpNodeData>[] = mdpData.nodes.map((node) => {
      const passedCount = node.criteria.filter((c) => c.passed).length;
      return {
        id: node.id,
        type: "mdpState",
        position: { x: 0, y: 0 },
        data: {
          criteria: node.criteria,
          visits: node.visits,
          isInitial: node.isInitial,
          isTerminal: node.isTerminal,
          passedCount,
          totalCount: node.criteria.length,
        },
      };
    });

    // Build edges
    const maxCount = Math.max(...mdpData.edges.map((e) => e.count), 1);
    const rawEdges: Edge<MdpEdgeData>[] = mdpData.edges.map((edge) => {
      const thickness = Math.max(1, (edge.count / maxCount) * 4);
      const isSelfLoop = edge.source === edge.target;
      return {
        id: `${edge.source}->${edge.target}`,
        source: edge.source,
        target: edge.target,
        type: "mdpEdge",
        animated: edge.probability >= 0.8,
        ...(isSelfLoop && {
          sourceHandle: "self-source",
          targetHandle: "self-target",
        }),
        data: {
          probability: edge.probability,
          count: edge.count,
        },
        style: {
          stroke: isSelfLoop ? "#94a3b8" : "#64748b",
          strokeWidth: thickness,
        },
      };
    });

    // Check if topology changed
    const currentTopology = topologyHash(mdpData);
    if (currentTopology === prevTopologyRef.current && layoutCacheRef.current.size > 0) {
      // Reuse cached positions
      const positioned = rawNodes.map((node) => {
        const cached = layoutCacheRef.current.get(node.id);
        return cached
          ? { ...node, position: cached }
          : node;
      });
      return { flowNodes: positioned, flowEdges: rawEdges };
    }

    // Run dagre layout
    const laid = layoutGraph(rawNodes, rawEdges, criteriaCount);
    prevTopologyRef.current = currentTopology;

    // Cache positions
    layoutCacheRef.current = new Map();
    for (const node of laid.nodes) {
      layoutCacheRef.current.set(node.id, node.position);
    }

    return { flowNodes: laid.nodes, flowEdges: laid.edges };
  }, [mdpData]);

  // Criteria filter handlers
  const handleToggleCriterion = (id: string) => {
    const newSelected = selectedCriteria.includes(id)
      ? selectedCriteria.filter((c) => c !== id)
      : [...selectedCriteria, id];

    if (newSelected.length === 0) {
      searchParams.delete("criteria");
    } else {
      searchParams.set("criteria", newSelected.join(","));
    }
    setSearchParams(searchParams, { replace: true });
  };

  const handleClearCriteria = () => {
    searchParams.delete("criteria");
    setSearchParams(searchParams, { replace: true });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            MDP State Transitions
            {mdpData && (
              <span className="text-lg font-normal text-muted-foreground ml-2">
                ({mdpData.episodeCount} episodes)
              </span>
            )}
          </h1>
          <p className="text-muted-foreground">
            Markov Decision Process view of criteria states across all runs
          </p>
        </div>
        {isPolling && (
          <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Criteria filter */}
      {mdpData && (
        <CriteriaFilterBar
          availableCriteria={mdpData.availableCriteria}
          selectedCriteria={selectedCriteria}
          onToggle={handleToggleCriterion}
          onClear={handleClearCriteria}
          title="Criteria Projection"
          emptyDescription="Select criteria to project the MDP to a sub-state-space. All criteria included by default."
          selectedDescription={(count) =>
            `Projected to ${count} criteria. States differing only in excluded criteria are merged.`
          }
        />
      )}

      {/* Error state */}
      {error && (
        <div className="rounded-md border border-red-800 bg-red-950/50 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Graph */}
      {isLoading ? (
        <div className="h-[600px] rounded-md border bg-slate-950 flex items-center justify-center text-sm text-slate-500">
          Loading MDP graph…
        </div>
      ) : flowNodes.length === 0 ? (
        <div className="h-[600px] rounded-md border bg-slate-950 flex items-center justify-center text-sm text-slate-500">
          No completed runs with criteria data found.
        </div>
      ) : (
        <div className="h-[600px] rounded-md border bg-slate-950 overflow-hidden relative">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
            className="[&_.react-flow__renderer]:!bg-transparent"
          >
            <Background color="#1e293b" gap={16} />
            <Controls className="!bg-slate-800 !border-slate-700 [&_button]:!bg-slate-800 [&_button]:!border-slate-700 [&_button]:!text-slate-300 [&_button:hover]:!bg-slate-700" />
            <MiniMap
              nodeColor={(node) => {
                const data = node.data as MdpNodeData;
                if (data.isInitial) return "#64748b";
                const rate = data.totalCount > 0 ? data.passedCount / data.totalCount : 0;
                return passRateColor(rate);
              }}
              className="!bg-slate-900 !border-slate-700"
            />
          </ReactFlow>

          {/* Legend */}
          <div className="absolute bottom-2 left-14 flex items-center gap-3 text-[10px] text-slate-400 bg-slate-950/80 rounded px-2 py-1 z-10">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400" /> Passed
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-red-400" /> Failed
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 border-t border-dashed border-slate-500" /> Initial
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded border-2 border-blue-400" /> Terminal
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
