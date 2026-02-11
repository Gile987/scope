// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, X, Check } from "lucide-react";

interface CriteriaPickerProps {
  selected: string[];
  onChange: (ids: string[]) => void;
}

export function CriteriaPicker({ selected, onChange }: CriteriaPickerProps) {
  const [search, setSearch] = useState("");

  const { data: criteria = [], isLoading } = useQuery({
    queryKey: ["criteria"],
    queryFn: () => api.listCriteria(),
  });

  const filtered = useMemo(() => {
    if (!search) return criteria;
    const q = search.toLowerCase();
    return criteria.filter(
      (c) => c.id.toLowerCase().includes(q) || c.prompt.toLowerCase().includes(q)
    );
  }, [criteria, search]);

  const toggle = (id: string) => {
    onChange(
      selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]
    );
  };

  const removeAll = () => onChange([]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Selected tags */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <Badge
              key={id}
              variant="default"
              className="gap-1 font-mono text-xs cursor-pointer"
              onClick={() => toggle(id)}
            >
              {id}
              <X className="h-3 w-3" />
            </Badge>
          ))}
          <button
            type="button"
            onClick={removeAll}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search criteria…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-9"
        />
      </div>

      {/* Criteria list */}
      <ScrollArea className="h-48 rounded-md border">
        <div className="p-2 space-y-0.5">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {search ? "No matching criteria" : "No criteria available"}
            </p>
          ) : (
            filtered.map((c) => {
              const isSelected = selected.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(c.id)}
                  className={`w-full flex items-start gap-2 p-2 rounded-md text-left transition-colors ${
                    isSelected
                      ? "bg-primary/10 hover:bg-primary/15"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <div
                    className={`mt-0.5 h-4 w-4 rounded flex items-center justify-center border ${
                      isSelected
                        ? "bg-primary border-primary text-primary-foreground"
                        : "border-muted-foreground/30"
                    }`}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-sm font-medium truncate">{c.id}</p>
                    <p className="text-xs text-muted-foreground line-clamp-1">{c.prompt}</p>
                  </div>
                  {(c.dependsOn ?? []).length > 0 && (
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {c.dependsOn!.length} dep{c.dependsOn!.length > 1 ? "s" : ""}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </ScrollArea>

      <p className="text-xs text-muted-foreground">
        {selected.length} of {criteria.length} selected
      </p>
    </div>
  );
}
