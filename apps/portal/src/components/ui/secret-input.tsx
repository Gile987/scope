// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from "react";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface SecretInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** When true, shows the value as plain text by default (useful for new/empty fields). */
  defaultVisible?: boolean;
  /** When false, hides the show/hide toggle button. Defaults to true. */
  showToggle?: boolean;
  /** Class names applied to the outer wrapper div (e.g. flex-1 to grow in a flex row). */
  containerClassName?: string;
}

const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ className, containerClassName, defaultVisible = false, showToggle = true, ...props }, ref) => {
    const [visible, setVisible] = useState(defaultVisible);

    return (
      <div className={cn("relative flex items-center", containerClassName)}>
        <input
          type={visible ? "text" : "password"}
          className={cn(
            "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            showToggle && "pr-10",
            className
          )}
          ref={ref}
          {...props}
        />
        {showToggle && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 h-10 w-10 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => setVisible((v) => !v)}
            tabIndex={-1}
            aria-label={visible ? "Hide value" : "Show value"}
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        )}
      </div>
    );
  }
);
SecretInput.displayName = "SecretInput";

export { SecretInput };
