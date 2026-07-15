// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectSwitcherLockProvider,
  useProjectSwitcherLock,
} from "@/contexts/ProjectSwitcherLockContext";
import { LockProjectSwitcher } from "./LockProjectSwitcher";

afterEach(() => cleanup());

/** Surfaces the current lock state so the test can assert on it. */
function LockProbe() {
  const { locked } = useProjectSwitcherLock();
  return <span data-testid="locked">{String(locked)}</span>;
}

describe("LockProjectSwitcher", () => {
  it("locks on mount and unlocks on unmount", () => {
    function Harness({ show }: { show: boolean }) {
      return (
        <ProjectSwitcherLockProvider>
          <LockProbe />
          {show ? (
            <LockProjectSwitcher>
              <div />
            </LockProjectSwitcher>
          ) : null}
        </ProjectSwitcherLockProvider>
      );
    }

    const { rerender } = render(<Harness show />);
    // Mount effect engages the lock.
    expect(screen.getByTestId("locked").textContent).toBe("true");

    // Unmounting the wrapper (navigating away from the detail page) releases it.
    rerender(<Harness show={false} />);
    expect(screen.getByTestId("locked").textContent).toBe("false");
  });

  it("renders its children unchanged", () => {
    render(
      <ProjectSwitcherLockProvider>
        <LockProjectSwitcher>
          <span data-testid="child">hello</span>
        </LockProjectSwitcher>
      </ProjectSwitcherLockProvider>,
    );
    expect(screen.getByTestId("child").textContent).toBe("hello");
  });
});
