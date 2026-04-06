// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { memo } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";

const MAX_CHARS = 2000;
const SCALE = 0.12;
const WIDTH = 160;
const HEIGHT = 200;

// Inner dimensions before scaling
const INNER_WIDTH = WIDTH / SCALE;
const INNER_HEIGHT = HEIGHT / SCALE;

interface ReportThumbnailProps {
  content: string;
}

export const ReportThumbnail = memo(function ReportThumbnail({
  content,
}: ReportThumbnailProps) {
  const truncated = content.length > MAX_CHARS ? content.slice(0, MAX_CHARS) : content;

  return (
    <div
      className="relative overflow-hidden rounded border bg-white dark:bg-zinc-900 shadow-sm"
      style={{ width: WIDTH, height: HEIGHT }}
    >
      <div
        className="absolute top-0 left-0 origin-top-left pointer-events-none select-none prose prose-sm dark:prose-invert max-w-none p-4"
        style={{
          transform: `scale(${SCALE})`,
          width: INNER_WIDTH,
          height: INNER_HEIGHT,
        }}
      >
        <MarkdownRenderer>{truncated}</MarkdownRenderer>
      </div>
    </div>
  );
});
