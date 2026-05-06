// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Check, X, HelpCircle } from "lucide-react";

export function criterionResultStyle(result: boolean | undefined) {
  if (result === true) {
    return {
      colorClass: "border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300",
      Icon: Check,
      title: "Passed",
    };
  }
  if (result === false) {
    return {
      colorClass: "border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300",
      Icon: X,
      title: "Failed",
    };
  }
  return {
    colorClass: "border-gray-300 bg-gray-50 text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400",
    Icon: HelpCircle,
    title: "Not evaluated",
  };
}
