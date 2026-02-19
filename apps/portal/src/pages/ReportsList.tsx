// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { formatDate, formatId } from "@/lib/utils";
import { FileText } from "lucide-react";

export function ReportsList() {
  const { data: reports, isLoading, error } = useQuery({
    queryKey: ["reports"],
    queryFn: () => api.listReports(),
    refetchInterval: 10_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 text-destructive">
        {error instanceof Error ? error.message : "Failed to load reports"}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            LLM-generated analysis reports for benchmark runs
          </p>
        </div>
      </div>

      {reports && reports.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Report ID</TableHead>
              <TableHead>Run ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reports.map((report) => (
              <TableRow key={report._id}>
                <TableCell>
                  <Link
                    to={`/reports/${report._id}`}
                    className="font-mono text-sm text-primary hover:underline"
                  >
                    {formatId(report._id)}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link
                    to={`/runs/${report.requestId}`}
                    className="font-mono text-sm text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {formatId(report.requestId)}
                  </Link>
                </TableCell>
                <TableCell>
                  <ReportStatusBadge status={report.status} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {report.reporter?.model ?? "–"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(report.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="text-center py-12">
          <FileText className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-medium">No reports yet</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Reports are automatically generated when benchmark runs complete.
          </p>
        </div>
      )}
    </div>
  );
}
