/**
 * Integration tests: watcher + state machine working together.
 *
 * Every test exercises the full pipeline via watcher.handleHook():
 *   hook handler → transitionSession() → transition() → side effects → emitted events
 *
 * Group A: Tests that pass now (safety net for refactor)
 * Group B: Tests that reproduce parallel-tool bugs (marked .fails until fixed)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionWatcher } from "./watcher.js";
import type { HookPayload } from "./hook-handler.js";

describe("Watcher + State Machine Integration", () => {
  let watcher: SessionWatcher;
  let events: Array<{
    type: string;
    session: {
      sessionId: string;
      status: { status: string; hasPendingToolUse: boolean };
      machineState: string;
      activeTools: Array<{ toolUseId: string; toolName: string }>;
      activeTasks: Array<{ toolUseId: string; description: string }>;
    };
  }>;

  const SESSION_ID = "test-watcher-integration";
  const TRANSCRIPT_PATH = "/Users/test/.claude/projects/test/test.jsonl";

  function makePayload(overrides: Partial<HookPayload> & Pick<HookPayload, "hook_event_name">): HookPayload {
    return {
      session_id: SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      cwd: "/Users/test/project",
      ...overrides,
    } as HookPayload;
  }

  async function seedSession(): Promise<void> {
    await watcher.handleHook(makePayload({ hook_event_name: "UserPromptSubmit" }));
  }

  function lastEvent() {
    return events[events.length - 1];
  }

  function lastStatus() {
    return lastEvent()?.session.status;
  }

  function lastMachineState() {
    return lastEvent()?.session.machineState;
  }

  /** Put the session into needs_approval state for Bash tool */
  async function seedNeedsApproval(toolUseId = "toolu_bash_01"): Promise<void> {
    await seedSession();
    await watcher.handleHook(makePayload({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: toolUseId,
    }));
    await watcher.handleHook(makePayload({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_use_id: toolUseId,
    }));
    vi.advanceTimersByTime(3100); // past permission debounce
  }

  beforeEach(() => {
    vi.useFakeTimers();
    watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 3000 });
    events = [];
    watcher.on("session", (event: any) => {
      if (event.session.sessionId === SESSION_ID) {
        events.push({
          type: event.type,
          session: {
            sessionId: event.session.sessionId,
            status: { ...event.session.status },
            machineState: event.session.machineState,
            activeTools: [...event.session.activeTools],
            activeTasks: [...event.session.activeTasks],
          },
        });
      }
    });
  });

  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
  });

  // =========================================================================
  // Group A: Tests that PASS now (safety net — must not regress)
  // =========================================================================

  describe("Group A: existing correct behavior", () => {
    it("A5: needs_approval + Stop → waiting", async () => {
      await seedNeedsApproval();
      expect(lastMachineState()).toBe("needs_approval");

      await watcher.handleHook(makePayload({ hook_event_name: "Stop" }));
      expect(lastMachineState()).toBe("waiting");
      expect(lastStatus().hasPendingToolUse).toBe(false);
    });

    it("A6: needs_approval + UserPromptSubmit → working", async () => {
      await seedNeedsApproval();
      expect(lastMachineState()).toBe("needs_approval");

      await watcher.handleHook(makePayload({ hook_event_name: "UserPromptSubmit" }));
      expect(lastMachineState()).toBe("working");
      expect(lastStatus().hasPendingToolUse).toBe(false);
    });
  });

  // =========================================================================
  // Group B: Tests that FAIL now (parallel-tool bugs — marked .fails)
  // =========================================================================

  describe("Group B: parallel-tool bugs", () => {
    it("B1: PostToolUse for unrelated tool should NOT clear needs_approval", async () => {
      await seedNeedsApproval("toolu_bash_01");
      expect(lastMachineState()).toBe("needs_approval");

      // Subagent's tool starts and completes
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "toolu_read_99",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_use_id: "toolu_read_99",
      }));

      // KEY: needs_approval must be preserved
      expect(lastMachineState()).toBe("needs_approval");
      expect(lastStatus().hasPendingToolUse).toBe(true);

      // Now the actual Bash tool completes — THIS should clear needs_approval
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      expect(lastMachineState()).toBe("working");
      expect(lastStatus().hasPendingToolUse).toBe(false);
    });

    it("B2: PostToolUseFailure for unrelated tool should NOT clear needs_approval", async () => {
      await seedNeedsApproval("toolu_bash_01");
      expect(lastMachineState()).toBe("needs_approval");

      // Subagent's tool fails
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_use_id: "toolu_write_99",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Write",
        tool_use_id: "toolu_write_99",
      }));

      // KEY: needs_approval must be preserved
      expect(lastMachineState()).toBe("needs_approval");
      expect(lastStatus().hasPendingToolUse).toBe(true);
    });
  });
});
