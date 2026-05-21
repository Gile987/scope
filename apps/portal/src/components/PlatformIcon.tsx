// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { FaLinux, FaApple, FaWindows } from "react-icons/fa";
import type { IconType } from "react-icons";

const platformIcons: Record<string, { icon: IconType; label: string }> = {
  linux: { icon: FaLinux, label: "Linux" },
  darwin: { icon: FaApple, label: "macOS" },
  win32: { icon: FaWindows, label: "Windows" },
};

export function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  const entry = platformIcons[platform];
  if (!entry) {
    return <span className={className}>{platform}</span>;
  }
  const Icon = entry.icon;
  return <Icon className={className} title={entry.label} />;
}
