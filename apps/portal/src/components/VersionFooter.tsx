// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface VersionInfo {
  commit: string;
  buildTime: string;
}

export function VersionFooter() {
  const [apiVersion, setApiVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    api.getVersion()
      .then(setApiVersion)
      .catch(() => setApiVersion(null));
  }, []);

  const portalCommit = __GIT_COMMIT__;
  const portalBuildTime = __BUILD_TIME__;
  const gitBranch = __GIT_BRANCH__;

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const shortCommit = (commit: string) => {
    if (commit === "development" || commit === "unknown") return commit;
    return commit.slice(0, 7);
  };

  return (
    <footer className="border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap justify-center gap-x-6 gap-y-1">
        {gitBranch && (
          <span>
            Branch: <code className="font-mono">{gitBranch}</code>
          </span>
        )}
        <span>
          Portal: <code className="font-mono">{shortCommit(portalCommit)}</code>{" "}
          <span className="text-muted-foreground/70">({formatDate(portalBuildTime)})</span>
        </span>
        {apiVersion && (
          <span>
            API: <code className="font-mono">{shortCommit(apiVersion.commit)}</code>{" "}
            <span className="text-muted-foreground/70">({formatDate(apiVersion.buildTime)})</span>
          </span>
        )}
      </div>
    </footer>
  );
}
