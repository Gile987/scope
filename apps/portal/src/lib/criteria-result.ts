// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Check, X, HelpCircle } from "lucide-react";

export function criterionResultStyle(result: boolean | undefined) {
  if (result === true) {
    return {
      colorClass: "border-green-300 bg-green-50 text-green-700",
      Icon: Check,
      title: "Passed",
    };
  }
  if (result === false) {
    return {
      colorClass: "border-red-300 bg-red-50 text-red-700",
      Icon: X,
      title: "Failed",
    };
  }
  return {
    colorClass: "border-gray-300 bg-gray-50 text-gray-700",
    Icon: HelpCircle,
    title: "Not evaluated",
  };
}
