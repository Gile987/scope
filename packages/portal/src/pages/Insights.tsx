// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { BarChart3, TrendingUp, CheckCircle, Clock, RefreshCw, X, Filter } from "lucide-react";
import type { AnalysisResponse, TaskWorkerGroup } from "@/types";

// Color palette for chart lines (distinct colors for different groups)
const COLORS = [
  "hsl(221, 83%, 53%)",   // blue
  "hsl(142, 71%, 45%)",   // green
  "hsl(38, 92%, 50%)",    // orange
  "hsl(262, 83%, 58%)",   // purple
  "hsl(346, 77%, 50%)",   // red
  "hsl(199, 89%, 48%)",   // cyan
];

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatNumber(value: number | null, decimals = 1): string {
  if (value === null) return "—";
  return value.toFixed(decimals);
}

function getGroupKey(group: TaskWorkerGroup): string {
  return `${group.task} (${group.workerType})`;
}

function truncateTask(task: string, maxLength = 35): string {
  return task.length > maxLength ? task.substring(0, maxLength - 3) + "..." : task;
}

// Summary cards showing overall stats
function SummaryCards({ data }: { data: AnalysisResponse }) {
  const { summary } = data;
  
  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Runs</CardTitle>
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{summary.totalRuns}</div>
          <p className="text-xs text-muted-foreground">
            {summary.completedRuns} completed
          </p>
        </CardContent>
      </Card>
      
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Pass Rate</CardTitle>
          <CheckCircle className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{formatPercent(summary.overallPassRate)}</div>
          <p className="text-xs text-muted-foreground">
            {summary.passedRuns} of {summary.completedRuns} passed
          </p>
        </CardContent>
      </Card>
      
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Avg Iterations</CardTitle>
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {formatNumber(summary.avgIterationsToPass)}
          </div>
          <p className="text-xs text-muted-foreground">
            to pass (when successful)
          </p>
        </CardContent>
      </Card>
      
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Task Groups</CardTitle>
          <Clock className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.groups.length}</div>
          <p className="text-xs text-muted-foreground">
            task + worker combinations
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// Pass@k table
function PassAtKTable({ data }: { data: AnalysisResponse }) {
  const { groups, kValues } = data;
  
  if (groups.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pass@k by Task & Worker</CardTitle>
          <CardDescription>No completed runs to analyze</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pass@k by Task & Worker</CardTitle>
        <CardDescription>
          Probability of at least one correct solution in k attempts
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="max-w-[200px]">Task</TableHead>
              <TableHead>Worker</TableHead>
              <TableHead className="text-center">Runs</TableHead>
              <TableHead className="text-center">Passed</TableHead>
              {kValues.map(k => (
                <TableHead key={k} className="text-center">pass@{k}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <TableRow key={getGroupKey(group)}>
                <TableCell className="font-medium max-w-[200px] truncate" title={group.task}>
                  {truncateTask(group.task)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono text-xs">
                    {group.workerType}
                  </Badge>
                </TableCell>
                <TableCell className="text-center">{group.completed}</TableCell>
                <TableCell className="text-center">
                  <span className={group.passed > 0 ? "text-green-600" : "text-muted-foreground"}>
                    {group.passed}
                  </span>
                  {group.rejected > 0 && (
                    <span className="text-red-500 ml-1">/ {group.rejected}</span>
                  )}
                </TableCell>
                {kValues.map(k => (
                  <TableCell key={k} className="text-center font-mono">
                    <span className={group.passAtK[k] >= 0.5 ? "text-green-600" : group.passAtK[k] > 0 ? "text-yellow-600" : "text-muted-foreground"}>
                      {formatPercent(group.passAtK[k])}
                    </span>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// Success@≤T CDF chart
function SuccessAtTChart({ data }: { data: AnalysisResponse }) {
  const { groups, maxT } = data;
  
  // Filter to only groups with passed runs
  const groupsWithData = groups.filter(g => g.passed > 0);
  
  if (groupsWithData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Success@≤T (CDF)</CardTitle>
          <CardDescription>No passed runs to visualize</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  
  // Transform data for recharts: array of { iteration: 1, "group1": 0.3, "group2": 0.5, ... }
  const chartData = Array.from({ length: maxT }, (_, i) => {
    const point: Record<string, number | string> = { iteration: i + 1 };
    for (const group of groupsWithData) {
      point[getGroupKey(group)] = group.successAtT[i] ?? 0;
    }
    return point;
  });
  
  return (
    <Card>
      <CardHeader>
        <CardTitle>Success@≤T (CDF)</CardTitle>
        <CardDescription>
          Probability of successful completion within T iterations
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="iteration"
                label={{ value: "Iterations (T)", position: "insideBottom", offset: -5 }}
                tick={{ fontSize: 12 }}
              />
              <YAxis
                domain={[0, 1]}
                tickFormatter={(v: number) => formatPercent(v)}
                tick={{ fontSize: 12 }}
                label={{ value: "P(success ≤ T)", angle: -90, position: "insideLeft" }}
              />
              <Tooltip
                formatter={(value: number) => formatPercent(value)}
                labelFormatter={(label: string | number) => `≤${label} iterations`}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                formatter={(value: string) => {
                  const group = groupsWithData.find(g => getGroupKey(g) === value);
                  return group ? `${value} (n=${group.passed})` : value;
                }}
              />
              {groupsWithData.map((group, idx) => (
                <Line
                  key={getGroupKey(group)}
                  type="monotone"
                  dataKey={getGroupKey(group)}
                  stroke={COLORS[idx % COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// Iteration statistics table
function IterationStatsTable({ data }: { data: AnalysisResponse }) {
  const { groups } = data;
  
  const groupsWithStats = groups.filter(g => g.iterationStats !== null);
  
  if (groupsWithStats.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Iteration Statistics</CardTitle>
          <CardDescription>No passed runs to analyze</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  
  return (
    <Card>
      <CardHeader>
        <CardTitle>Iteration Statistics</CardTitle>
        <CardDescription>
          Distribution of iterations needed to pass (successful runs only)
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="max-w-[200px]">Task</TableHead>
              <TableHead>Worker</TableHead>
              <TableHead className="text-center">N</TableHead>
              <TableHead className="text-center">Mean</TableHead>
              <TableHead className="text-center">Std Dev</TableHead>
              <TableHead className="text-center">Min</TableHead>
              <TableHead className="text-center">Max</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groupsWithStats.map((group) => (
              <TableRow key={getGroupKey(group)}>
                <TableCell className="font-medium max-w-[200px] truncate" title={group.task}>
                  {truncateTask(group.task)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono text-xs">
                    {group.workerType}
                  </Badge>
                </TableCell>
                <TableCell className="text-center font-mono text-muted-foreground">
                  {group.passed}
                </TableCell>
                <TableCell className="text-center font-mono">
                  {formatNumber(group.iterationStats!.mean)}
                </TableCell>
                <TableCell className="text-center font-mono text-muted-foreground">
                  ±{formatNumber(group.iterationStats!.stdDev)}
                </TableCell>
                <TableCell className="text-center font-mono">
                  {group.iterationStats!.min}
                </TableCell>
                <TableCell className="text-center font-mono">
                  {group.iterationStats!.max}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// Loading skeleton
function InsightsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-1" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

// Criteria filter bar for selecting which criteria define success
function CriteriaFilterBar({
  availableCriteria,
  selectedCriteria,
  onToggle,
  onClear,
}: {
  availableCriteria: string[];
  selectedCriteria: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  if (availableCriteria.length === 0) {
    return null;
  }

  const selectedSet = new Set(selectedCriteria);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Success Criteria Filter</CardTitle>
          </div>
          {selectedCriteria.length > 0 && (
            <button
              onClick={onClear}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Clear all
            </button>
          )}
        </div>
        <CardDescription>
          {selectedCriteria.length === 0
            ? "Click criteria to filter runs and redefine success. Default: all criteria in each run must pass."
            : `Success = all ${selectedCriteria.length} selected criteria pass. Runs without these criteria are excluded.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-1.5">
          {availableCriteria.map((id) => {
            const isSelected = selectedSet.has(id);
            return (
              <Badge
                key={id}
                variant={isSelected ? "default" : "outline"}
                className={`cursor-pointer transition-colors ${
                  isSelected
                    ? "bg-primary hover:bg-primary/80"
                    : "hover:bg-muted"
                }`}
                onClick={() => onToggle(id)}
              >
                {id}
                {isSelected && <X className="ml-1 h-3 w-3" />}
              </Badge>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function Insights() {
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Parse selected criteria from URL
  const selectedCriteria = searchParams.get("criteria")?.split(",").filter(Boolean) || [];

  const { data, isLoading, isRefetching } = useQuery({
    queryKey: ["analysis", selectedCriteria],
    queryFn: () => api.getAnalysis([1, 2, 5], selectedCriteria.length > 0 ? selectedCriteria : undefined),
    refetchInterval: 30_000,  // Refresh every 30 seconds
  });

  // Toggle a criterion in the filter
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

  // Clear all criteria filters
  const handleClearCriteria = () => {
    searchParams.delete("criteria");
    setSearchParams(searchParams, { replace: true });
  };

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Insights</h1>
          <p className="text-muted-foreground">
            Analysis of benchmark runs: pass rates, iterations, and success probability
          </p>
        </div>
        {isRefetching && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {isLoading || !data ? (
        <InsightsSkeleton />
      ) : (
        <>
          <CriteriaFilterBar
            availableCriteria={data.availableCriteria}
            selectedCriteria={selectedCriteria}
            onToggle={handleToggleCriterion}
            onClear={handleClearCriteria}
          />
          <SummaryCards data={data} />
          {import.meta.env.VITE_SHOW_PASS_AT_K === "true" && <PassAtKTable data={data} />}
          <SuccessAtTChart data={data} />
          <IterationStatsTable data={data} />
        </>
      )}
    </div>
  );
}
