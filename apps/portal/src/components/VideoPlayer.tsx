// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Card, CardContent } from "@/components/ui/card";

interface VideoPlayerProps {
  src: string;
  label?: string;
}

export function VideoPlayer({ src, label }: VideoPlayerProps) {
  return (
    <Card>
      <CardContent className="p-4">
        {label && (
          <h4 className="text-sm font-medium mb-2">{label}</h4>
        )}
        <video
          controls
          className="w-full rounded-md bg-black"
          src={src}
        >
          Your browser does not support the video tag.
        </video>
      </CardContent>
    </Card>
  );
}
