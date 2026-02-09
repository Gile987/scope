// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useCallback } from "react";

export interface RequestInfo {
  id: string;
  worker: string;
  status: "pending" | "submitting" | "submitted" | "processing" | "completed" | "failed";
  error?: string;
}

export interface UseRequestSubmitReturn {
  requests: RequestInfo[];
  submitAll: (message: string, workers: string[], count: number, apiUrl: string) => Promise<void>;
  isSubmitting: boolean;
}

export function useRequestSubmit(): UseRequestSubmitReturn {
  const [requests, setRequests] = useState<RequestInfo[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitAll = useCallback(
    async (message: string, workers: string[], count: number, apiUrl: string) => {
      setIsSubmitting(true);

      // Create placeholder requests
      const pendingRequests: RequestInfo[] = [];
      for (const worker of workers) {
        for (let i = 0; i < count; i++) {
          pendingRequests.push({
            id: `pending-${worker}-${i}`,
            worker,
            status: "pending",
          });
        }
      }
      setRequests(pendingRequests);

      // Submit all requests concurrently
      const submissions = pendingRequests.map(async (req, index) => {
        try {
          const response = await fetch(`${apiUrl}/api/v1/requests?worker=${req.worker}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scenario: { task: message, criteria: [] } }),
          });

          if (!response.ok) {
            const error = await response.json();
            setRequests((prev) =>
              prev.map((r, i) =>
                i === index
                  ? { ...r, status: "failed" as const, error: error.message || "Submit failed" }
                  : r
              )
            );
            return null;
          }

          const result = await response.json();
          setRequests((prev) =>
            prev.map((r, i) =>
              i === index
                ? { ...r, id: result.id, status: "submitted" as const }
                : r
            )
          );
          return result.id;
        } catch (err) {
          setRequests((prev) =>
            prev.map((r, i) =>
              i === index
                ? { ...r, status: "failed" as const, error: err instanceof Error ? err.message : "Unknown error" }
                : r
            )
          );
          return null;
        }
      });

      await Promise.all(submissions);
      setIsSubmitting(false);
    },
    []
  );

  return { requests, submitAll, isSubmitting };
}
