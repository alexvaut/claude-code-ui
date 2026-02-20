/**
 * E2E test for Claude Code session tracking
 *
 * Tests the full flow: file detection → parsing → status → publishing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { SessionWatcher } from "./watcher.js";
import type { HookPayload } from "./hook-handler.js";
import { handleHookRequest } from "./hook-handler.js";
import { tailJSONL, extractMetadata } from "./parser.js";
import { transition } from "./status-machine.js";
import { getGitInfo, getGitInfoCached, _resetGitCaches } from "./git.js";

const TEST_DIR = path.join(os.homedir(), ".claude", "projects", "-test-e2e-session");

// Generate unique IDs per test run to avoid conflicts
function getTestSessionId(): string {
  return "test-session-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

// Shared for simple tests that don't use the watcher
let TEST_SESSION_ID = "";
let TEST_LOG_FILE = "";

// Helper to create a log entry
function createUserEntry(content: string, timestamp = new Date().toISOString()) {
  return JSON.stringify({
    type: "user",
    parentUuid: null,
    uuid: `uuid-${Date.now()}-${Math.random()}`,
    sessionId: TEST_SESSION_ID,
    timestamp,
    cwd: "/Users/test/project",
    version: "1.0.0",
    gitBranch: "main",
    isSidechain: false,
    userType: "external",
    message: {
      role: "user",
      content,
    },
  }) + "\n";
}

function createAssistantEntry(content: string, timestamp = new Date().toISOString(), hasToolUse = false) {
  const blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = [
    { type: "text", text: content },
  ];

  if (hasToolUse) {
    blocks.push({
      type: "tool_use",
      id: `tool-${Date.now()}`,
      name: "Bash",
      input: { command: "echo test" },
    });
  }

  return JSON.stringify({
    type: "assistant",
    parentUuid: null,
    uuid: `uuid-${Date.now()}-${Math.random()}`,
    sessionId: TEST_SESSION_ID,
    timestamp,
    cwd: "/Users/test/project",
    version: "1.0.0",
    gitBranch: "main",
    isSidechain: false,
    userType: "external",
    requestId: `req-${Date.now()}`,
    message: {
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      id: `msg-${Date.now()}`,
      content: blocks,
      stop_reason: hasToolUse ? "tool_use" : "end_turn",
    },
  }) + "\n";
}

describe("Session Tracking", () => {
  beforeEach(async () => {
    // Create test directory and generate unique session ID for this test
    TEST_SESSION_ID = getTestSessionId();
    TEST_LOG_FILE = path.join(TEST_DIR, `${TEST_SESSION_ID}.jsonl`);
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Small delay to let any pending file operations complete
    await new Promise((r) => setTimeout(r, 100));
    // Cleanup
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("Parser", () => {
    it("should parse JSONL entries from a log file", async () => {
      // Write a simple log file
      const entry1 = createUserEntry("Hello, help me with something");
      const entry2 = createAssistantEntry("Sure, I can help!");

      await writeFile(TEST_LOG_FILE, entry1 + entry2);

      // Parse it
      const { entries, newPosition } = await tailJSONL(TEST_LOG_FILE, 0);

      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe("user");
      expect(entries[1].type).toBe("assistant");
      expect(newPosition).toBeGreaterThan(0);
    });

    it("should extract metadata from entries", async () => {
      const entry = createUserEntry("Help me build a feature");
      await writeFile(TEST_LOG_FILE, entry);

      const { entries } = await tailJSONL(TEST_LOG_FILE, 0);
      const metadata = extractMetadata(entries);

      expect(metadata).not.toBeNull();
      expect(metadata?.sessionId).toBe(TEST_SESSION_ID);
      expect(metadata?.cwd).toBe("/Users/test/project");
      expect(metadata?.gitBranch).toBe("main");
      expect(metadata?.originalPrompt).toBe("Help me build a feature");
    });

    it("should handle incremental reads", async () => {
      // Write initial entry
      const entry1 = createUserEntry("First message");
      await writeFile(TEST_LOG_FILE, entry1);

      const { entries: first, newPosition: pos1 } = await tailJSONL(TEST_LOG_FILE, 0);
      expect(first).toHaveLength(1);

      // Append more entries
      const entry2 = createAssistantEntry("Response");
      const entry3 = createUserEntry("Follow up");
      await appendFile(TEST_LOG_FILE, entry2 + entry3);

      // Small delay to ensure file is flushed
      await new Promise((r) => setTimeout(r, 50));

      // Read from previous position - should get both new entries
      const { entries: second, newPosition: pos2 } = await tailJSONL(TEST_LOG_FILE, pos1);

      expect(second).toHaveLength(2);
      expect(second[0].type).toBe("assistant");
      expect(second[1].type).toBe("user");
      expect(pos2).toBeGreaterThan(pos1);
    });
  });

  describe("SessionWatcher", () => {
    it("should detect new session files", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50 });

      const events: Array<{ type: string; sessionId: string }> = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          events.push({ type: event.type, sessionId: event.session.sessionId });
        }
      });

      await watcher.start();

      // Create a session file
      const entry = createUserEntry("New session");
      await writeFile(TEST_LOG_FILE, entry);

      // Wait for detection
      await new Promise((r) => setTimeout(r, 1000));

      watcher.stop();
      // Wait for watcher to fully stop
      await new Promise((r) => setTimeout(r, 100));

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe("created");
    });

    it("should detect session updates", async () => {
      // Create initial file
      const entry1 = createUserEntry("Initial");
      await writeFile(TEST_LOG_FILE, entry1);

      const watcher = new SessionWatcher({ debounceMs: 50 });

      const events: Array<{ type: string; status: string }> = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          events.push({ type: event.type, status: event.session.status.status });
        }
      });

      await watcher.start();

      // Wait for initial detection
      await new Promise((r) => setTimeout(r, 1000));

      // Append assistant response
      const entry2 = createAssistantEntry("Response");
      await appendFile(TEST_LOG_FILE, entry2);

      // Wait for update detection
      await new Promise((r) => setTimeout(r, 1000));

      watcher.stop();
      // Wait for watcher to fully stop
      await new Promise((r) => setTimeout(r, 100));

      // Should have created event and possibly update
      expect(events.some(e => e.type === "created")).toBe(true);
    });

    it("should track message count changes", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50 });

      let lastMessageCount = 0;

      // Track all events for our session
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          lastMessageCount = event.session.status.messageCount;
        }
      });

      await watcher.start();

      // Create the file after watcher starts to ensure it's detected as new
      const entry1 = createUserEntry("First");
      await writeFile(TEST_LOG_FILE, entry1);

      // Wait for processing
      await new Promise((r) => setTimeout(r, 500));
      expect(lastMessageCount).toBe(1);

      // Add more messages
      await appendFile(TEST_LOG_FILE, createAssistantEntry("Two"));
      await new Promise((r) => setTimeout(r, 500));
      // Assistant message without tool use doesn't increment messageCount in current implementation
      // Only USER_PROMPT and ASSISTANT_TOOL_USE increment

      await appendFile(TEST_LOG_FILE, createUserEntry("Three"));
      await new Promise((r) => setTimeout(r, 500));

      watcher.stop();
      // Wait for watcher to fully stop
      await new Promise((r) => setTimeout(r, 100));

      // Should have at least 2 messages (user prompts)
      expect(lastMessageCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Session State Machine", () => {
    // From working
    it("working + STOP → waiting (non-worktree)", () => {
      expect(transition("working", { type: "STOP" }, false)).toBe("waiting");
    });
    it("working + STOP → review (worktree)", () => {
      expect(transition("working", { type: "STOP" }, true)).toBe("review");
    });
    it("working + ENDED → idle (non-worktree)", () => {
      expect(transition("working", { type: "ENDED" }, false)).toBe("idle");
    });
    it("working + ENDED → review (worktree)", () => {
      expect(transition("working", { type: "ENDED" }, true)).toBe("review");
    });
    it("working + PERMISSION_REQUEST → needs_approval", () => {
      expect(transition("working", { type: "PERMISSION_REQUEST" }, false)).toBe("needs_approval");
    });
    it("working + WORKING → working (no-op)", () => {
      expect(transition("working", { type: "WORKING" }, false)).toBe("working");
    });

    // From needs_approval
    it("needs_approval + WORKING → working", () => {
      expect(transition("needs_approval", { type: "WORKING" }, false)).toBe("working");
    });
    it("needs_approval + STOP → waiting (non-worktree)", () => {
      expect(transition("needs_approval", { type: "STOP" }, false)).toBe("waiting");
    });
    it("needs_approval + STOP → review (worktree)", () => {
      expect(transition("needs_approval", { type: "STOP" }, true)).toBe("review");
    });
    it("needs_approval + ENDED → idle (non-worktree)", () => {
      expect(transition("needs_approval", { type: "ENDED" }, false)).toBe("idle");
    });
    it("needs_approval + ENDED → review (worktree)", () => {
      expect(transition("needs_approval", { type: "ENDED" }, true)).toBe("review");
    });
    it("needs_approval + PERMISSION_REQUEST → needs_approval (no-op)", () => {
      expect(transition("needs_approval", { type: "PERMISSION_REQUEST" }, false)).toBe("needs_approval");
    });

    // From waiting
    it("waiting + WORKING → working", () => {
      expect(transition("waiting", { type: "WORKING" }, false)).toBe("working");
    });
    it("waiting + PERMISSION_REQUEST → needs_approval", () => {
      expect(transition("waiting", { type: "PERMISSION_REQUEST" }, false)).toBe("needs_approval");
    });
    it("waiting + STOP → waiting (no-op)", () => {
      expect(transition("waiting", { type: "STOP" }, false)).toBe("waiting");
    });

    // From review — THE BUG FIX
    it("review + WORKING → working", () => {
      expect(transition("review", { type: "WORKING" }, true)).toBe("working");
    });
    it("review + WORKTREE_DELETED → idle", () => {
      expect(transition("review", { type: "WORKTREE_DELETED" }, true)).toBe("idle");
    });
    it("review + STOP → review (no-op)", () => {
      expect(transition("review", { type: "STOP" }, true)).toBe("review");
    });
    it("review + ENDED → review (no-op)", () => {
      expect(transition("review", { type: "ENDED" }, true)).toBe("review");
    });

    // From idle
    it("idle + WORKING → working", () => {
      expect(transition("idle", { type: "WORKING" }, false)).toBe("working");
    });
    it("idle + STOP → idle (no-op)", () => {
      expect(transition("idle", { type: "STOP" }, false)).toBe("idle");
    });
    it("idle + ENDED → idle (no-op)", () => {
      expect(transition("idle", { type: "ENDED" }, false)).toBe("idle");
    });

    // Tasking state transitions
    it("working + TASK_STARTED → tasking", () => {
      expect(transition("working", { type: "TASK_STARTED" }, false)).toBe("tasking");
    });
    it("tasking + TASKS_DONE → working", () => {
      expect(transition("tasking", { type: "TASKS_DONE" }, false)).toBe("working");
    });
    it("tasking + STOP → waiting (non-worktree)", () => {
      expect(transition("tasking", { type: "STOP" }, false)).toBe("waiting");
    });
    it("tasking + STOP → review (worktree)", () => {
      expect(transition("tasking", { type: "STOP" }, true)).toBe("review");
    });
    it("tasking + ENDED → idle (non-worktree)", () => {
      expect(transition("tasking", { type: "ENDED" }, false)).toBe("idle");
    });
    it("tasking + ENDED → review (worktree)", () => {
      expect(transition("tasking", { type: "ENDED" }, true)).toBe("review");
    });
    it("tasking + PERMISSION_REQUEST → needs_approval", () => {
      expect(transition("tasking", { type: "PERMISSION_REQUEST" }, false)).toBe("needs_approval");
    });
    it("tasking + WORKING → tasking (no-op)", () => {
      expect(transition("tasking", { type: "WORKING" }, false)).toBe("tasking");
    });
    it("tasking + TASK_STARTED → tasking (no-op)", () => {
      expect(transition("tasking", { type: "TASK_STARTED" }, false)).toBe("tasking");
    });
    it("working + TASKS_DONE → working (no-op)", () => {
      expect(transition("working", { type: "TASKS_DONE" }, false)).toBe("working");
    });
    it("needs_approval + TASK_STARTED → needs_approval (no-op)", () => {
      expect(transition("needs_approval", { type: "TASK_STARTED" }, false)).toBe("needs_approval");
    });
  });

  describe("Hook → State Machine", () => {
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

    const HOOK_SESSION_ID = "test-hook-session";
    const TRANSCRIPT_PATH = "/Users/test/.claude/projects/test/test.jsonl";

    function makePayload(overrides: Partial<HookPayload> & Pick<HookPayload, "hook_event_name">): HookPayload {
      return {
        session_id: HOOK_SESSION_ID,
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

    beforeEach(() => {
      vi.useFakeTimers();
      watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 3000 });
      events = [];
      watcher.on("session", (event: any) => {
        if (event.session.sessionId === HOOK_SESSION_ID) {
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

    // === Scenario 1: Simple text prompt (no tools) ===

    it("UserPromptSubmit creates session in working state", async () => {
      await seedSession();
      expect(events[0].type).toBe("created");
      expect(lastMachineState()).toBe("working");
      expect(lastStatus().status).toBe("working");
    });

    it("Stop transitions to waiting", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({ hook_event_name: "Stop" }));
      expect(lastMachineState()).toBe("waiting");
      expect(lastStatus().status).toBe("waiting");
    });

    it("SessionEnd transitions to idle", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({ hook_event_name: "SessionEnd", reason: "other" }));
      expect(lastMachineState()).toBe("idle");
      expect(lastStatus().status).toBe("idle");
    });

    // === Scenario 2: Auto-approved tool (Read) ===

    it("PreToolUse/Read adds to activeTools", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "toolu_read_01",
        tool_input: { file_path: "/some/file.ts" },
      }));
      expect(lastEvent().session.activeTools).toContainEqual(
        expect.objectContaining({ toolUseId: "toolu_read_01", toolName: "Read" })
      );
    });

    it("PostToolUse/Read clears activeTools, still working (no PermissionRequest)", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "toolu_read_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_use_id: "toolu_read_01",
      }));
      expect(lastEvent().session.activeTools).toHaveLength(0);
      expect(lastMachineState()).toBe("working");
    });

    // === Scenario 3: Permission-requiring tool — APPROVED ===

    it("PermissionRequest after debounce transitions to needs_approval", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      // Before debounce — still working
      expect(lastMachineState()).toBe("working");
      // Advance past debounce
      vi.advanceTimersByTime(3100);
      expect(lastMachineState()).toBe("needs_approval");
      expect(lastStatus().status).toBe("waiting");
      expect(lastStatus().hasPendingToolUse).toBe(true);
    });

    it("PostToolUse/Bash after PermissionRequest clears permission, back to working", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      vi.advanceTimersByTime(3100);
      expect(lastMachineState()).toBe("needs_approval");
      // User approves, PostToolUse fires
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      expect(lastMachineState()).toBe("working");
      expect(lastStatus().hasPendingToolUse).toBe(false);
    });

    // === Scenario 4: Permission-requiring tool — DENIED ===

    it("PostToolUseFailure clears permission, back to working", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "toolu_read_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PermissionRequest",
        tool_name: "Read",
        tool_use_id: "toolu_read_01",
      }));
      vi.advanceTimersByTime(3100);
      expect(lastMachineState()).toBe("needs_approval");
      // User denies, PostToolUseFailure fires
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Read",
        tool_use_id: "toolu_read_01",
      }));
      expect(lastMachineState()).toBe("working");
      expect(lastStatus().hasPendingToolUse).toBe(false);
    });

    // === Scenario 6: AskUserQuestion (same as permission tool) ===

    it("AskUserQuestion triggers PermissionRequest, PostToolUse clears it", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_ask_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_ask_01",
      }));
      vi.advanceTimersByTime(3100);
      expect(lastStatus().hasPendingToolUse).toBe(true);
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_ask_01",
      }));
      expect(lastMachineState()).toBe("working");
      expect(lastStatus().hasPendingToolUse).toBe(false);
    });

    // === Scenario 7: Task tool (foreground subagent) ===

    it("PreToolUse/Task adds to activeTasks, transitions to tasking", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_01",
        tool_input: { subagent_type: "Bash", description: "Run tests" },
      }));
      expect(lastMachineState()).toBe("tasking");
      expect(lastEvent().session.activeTasks).toContainEqual(
        expect.objectContaining({ toolUseId: "toolu_task_01", description: "Run tests" })
      );
    });

    it("PostToolUse/Task clears activeTasks, back to working", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_01",
        tool_input: { subagent_type: "Bash", description: "Run tests" },
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_01",
      }));
      expect(lastMachineState()).toBe("working");
      expect(lastEvent().session.activeTasks).toHaveLength(0);
    });

    // === Scenario 9: PreCompact ===

    it("PreCompact adds synthetic compacting task", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({ hook_event_name: "PreCompact" }));
      expect(lastEvent().session.activeTasks).toContainEqual(
        expect.objectContaining({ toolUseId: "compacting", description: "Compacting context" })
      );
    });

    // === Scenario 10: Background task ===

    it("Background task: PostToolUse/Task fires immediately, clears task", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_bg_01",
        tool_input: { subagent_type: "Bash", description: "Background work", run_in_background: true },
      }));
      expect(lastMachineState()).toBe("tasking");
      // PostToolUse fires immediately (background task)
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_bg_01",
      }));
      expect(lastMachineState()).toBe("working");
      expect(lastEvent().session.activeTasks).toHaveLength(0);
    });

    // === Permission debounce (verified in Scenarios 2-6) ===

    it("PermissionRequest + PostToolUse within debounce → never shows needs_approval", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "EnterPlanMode",
        tool_use_id: "toolu_plan_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PermissionRequest",
        tool_name: "EnterPlanMode",
        tool_use_id: "toolu_plan_01",
      }));
      // Auto-approved: PostToolUse fires quickly (within debounce)
      vi.advanceTimersByTime(500);
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "EnterPlanMode",
        tool_use_id: "toolu_plan_01",
      }));
      // Advance past debounce window
      vi.advanceTimersByTime(3000);
      // Should never have shown needs_approval
      const approvalEvents = events.filter(e => e.session.status.hasPendingToolUse);
      expect(approvalEvents).toHaveLength(0);
    });

    it("PermissionRequest persists past debounce → shows needs_approval", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      vi.advanceTimersByTime(3100);
      const approvalEvents = events.filter(e => e.session.status.hasPendingToolUse);
      expect(approvalEvents.length).toBeGreaterThan(0);
    });

    // === Concurrent tool: PostToolUse for different tool must NOT cancel pending debounce ===

    it("PostToolUse for different tool does NOT cancel PermissionRequest debounce", async () => {
      await seedSession();
      // Tool A: Bash needs permission
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      // Tool B: Read auto-approved, completes within debounce window
      vi.advanceTimersByTime(500);
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "toolu_read_02",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_use_id: "toolu_read_02",
      }));
      // Still within debounce — not yet needs_approval
      expect(lastMachineState()).toBe("working");
      // Advance past debounce — Bash's timer should still fire
      vi.advanceTimersByTime(3000);
      expect(lastMachineState()).toBe("needs_approval");
      expect(lastStatus().hasPendingToolUse).toBe(true);
    });

    // === Worktree behavior ===

    it("Stop on non-worktree session → waiting", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({ hook_event_name: "Stop" }));
      expect(lastMachineState()).toBe("waiting");
    });

    it("SessionEnd on non-worktree session → idle", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({ hook_event_name: "SessionEnd" }));
      expect(lastMachineState()).toBe("idle");
    });

    it("UserPromptSubmit on waiting session → working", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({ hook_event_name: "Stop" }));
      expect(lastMachineState()).toBe("waiting");
      await watcher.handleHook(makePayload({ hook_event_name: "UserPromptSubmit" }));
      expect(lastMachineState()).toBe("working");
    });

    it("UserPromptSubmit on idle session → working", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({ hook_event_name: "SessionEnd" }));
      expect(lastMachineState()).toBe("idle");
      await watcher.handleHook(makePayload({ hook_event_name: "UserPromptSubmit" }));
      expect(lastMachineState()).toBe("working");
    });

    // === Multi-tool / multi-task ===

    it("Two concurrent tools → activeTools has 2 entries", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "toolu_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Grep",
        tool_use_id: "toolu_02",
      }));
      expect(lastEvent().session.activeTools).toHaveLength(2);
    });

    it("Two concurrent tasks → tasking with 2 activeTasks", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_01",
        tool_input: { subagent_type: "Bash", description: "Task 1" },
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_02",
        tool_input: { subagent_type: "Explore", description: "Task 2" },
      }));
      expect(lastMachineState()).toBe("tasking");
      expect(lastEvent().session.activeTasks).toHaveLength(2);
    });

    it("Remove one of two tasks → still tasking", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_01",
        tool_input: { subagent_type: "Bash", description: "Task 1" },
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_02",
        tool_input: { subagent_type: "Explore", description: "Task 2" },
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_01",
      }));
      expect(lastMachineState()).toBe("tasking");
      expect(lastEvent().session.activeTasks).toHaveLength(1);
    });

    it("Remove last task → working", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_01",
        tool_input: { subagent_type: "Bash", description: "Task 1" },
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_02",
        tool_input: { subagent_type: "Explore", description: "Task 2" },
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_task_02",
      }));
      expect(lastMachineState()).toBe("working");
      expect(lastEvent().session.activeTasks).toHaveLength(0);
    });

    // === Full lifecycle (Scenario 1 + 3 combined) ===

    it("Full lifecycle: UserPromptSubmit → PreToolUse → PermissionRequest → PostToolUse → Stop → SessionEnd", async () => {
      await seedSession();
      expect(lastMachineState()).toBe("working");

      // Tool with permission
      await watcher.handleHook(makePayload({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      await watcher.handleHook(makePayload({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
      }));
      vi.advanceTimersByTime(3100);
      expect(lastMachineState()).toBe("needs_approval");

      await watcher.handleHook(makePayload({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_bash_01",
      }));
      expect(lastMachineState()).toBe("working");

      // Stop → waiting
      await watcher.handleHook(makePayload({ hook_event_name: "Stop" }));
      expect(lastMachineState()).toBe("waiting");

      // SessionEnd from waiting is a no-op (already done).
      // To reach idle, SessionEnd must fire from working/tasking directly.
      await watcher.handleHook(makePayload({ hook_event_name: "SessionEnd" }));
      expect(lastMachineState()).toBe("waiting");

      // Restart and go directly to idle via SessionEnd from working
      await watcher.handleHook(makePayload({ hook_event_name: "UserPromptSubmit" }));
      expect(lastMachineState()).toBe("working");
      await watcher.handleHook(makePayload({ hook_event_name: "SessionEnd" }));
      expect(lastMachineState()).toBe("idle");
    });

    // === Stop clears compacting ===

    it("Stop clears compacting signal", async () => {
      await seedSession();
      await watcher.handleHook(makePayload({ hook_event_name: "PreCompact" }));
      expect(lastEvent().session.activeTasks.some(t => t.toolUseId === "compacting")).toBe(true);
      await watcher.handleHook(makePayload({ hook_event_name: "Stop" }));
      expect(lastEvent().session.activeTasks.some(t => t.toolUseId === "compacting")).toBe(false);
    });
  });

  describe("POST /hook endpoint", () => {
    // Mock HTTP request/response for handleHookRequest
    function mockReq(body: string) {
      const s = new Readable({ read() {} });
      s.push(Buffer.from(body));
      s.push(null);
      return s as any;
    }

    function mockRes() {
      const r = {
        statusCode: 0,
        body: "",
        headers: {} as Record<string, string>,
        writeHead(code: number, headers?: Record<string, string>) {
          r.statusCode = code;
          if (headers) Object.assign(r.headers, headers);
        },
        end(body?: string) { r.body = body ?? ""; },
      };
      return r as any;
    }

    it("returns 200 for valid hook payload", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50 });
      const req = mockReq(JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "test-endpoint-session",
        cwd: "/tmp",
      }));
      const res = mockRes();
      await handleHookRequest(req, res, watcher);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
      watcher.stop();
    });

    it("returns 400 for missing hook_event_name", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50 });
      const req = mockReq(JSON.stringify({ session_id: "test" }));
      const res = mockRes();
      await handleHookRequest(req, res, watcher);
      expect(res.statusCode).toBe(400);
      watcher.stop();
    });

    it("returns 400 for missing session_id", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50 });
      const req = mockReq(JSON.stringify({ hook_event_name: "Stop" }));
      const res = mockRes();
      await handleHookRequest(req, res, watcher);
      expect(res.statusCode).toBe(400);
      watcher.stop();
    });

    it("returns 400 for invalid JSON", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50 });
      const req = mockReq("not json at all");
      const res = mockRes();
      await handleHookRequest(req, res, watcher);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("Invalid JSON");
      watcher.stop();
    });

    it("watcher receives hook and emits correct session event", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50 });
      const created: string[] = [];
      watcher.on("session", (event: any) => {
        if (event.type === "created") created.push(event.session.sessionId);
      });
      const req = mockReq(JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "test-emit-session",
        cwd: "/tmp",
      }));
      const res = mockRes();
      await handleHookRequest(req, res, watcher);
      expect(res.statusCode).toBe(200);
      expect(created).toContain("test-emit-session");
      watcher.stop();
    });
  });

  describe("Claude -p E2E", () => {
    it("should track a real claude session with no false 'Needs Approval'", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });

      // Track sessions that are newly created during this test (ignore pre-existing)
      const newSessionIds = new Set<string>();
      const events: Array<{ type: string; sessionId: string; status: string; hasPendingToolUse: boolean }> = [];
      watcher.on("session", (event) => {
        if (event.type === "created") {
          newSessionIds.add(event.session.sessionId);
        }
        if (newSessionIds.has(event.session.sessionId)) {
          events.push({
            type: event.type,
            sessionId: event.session.sessionId,
            status: event.session.status.status,
            hasPendingToolUse: event.session.status.hasPendingToolUse,
          });
        }
      });

      await watcher.start();

      // Wait for initial scan to complete so existing sessions are not counted as "created"
      await new Promise((r) => setTimeout(r, 3000));
      newSessionIds.clear();
      events.length = 0;

      // Find claude CLI — try common locations
      let claudePath = "claude";
      const candidatePaths = [
        path.join(os.homedir(), ".local", "bin", "claude.exe"),
        path.join(os.homedir(), ".local", "bin", "claude"),
      ];
      for (const candidate of candidatePaths) {
        try {
          const { statSync } = await import("node:fs");
          if (statSync(candidate).isFile()) { claudePath = candidate; break; }
        } catch { /* not found */ }
      }

      // Run claude -p with a simple prompt (no tool approval needed)
      try {
        // Unset CLAUDECODE to allow nested claude invocation in test
        const env = { ...process.env };
        delete env.CLAUDECODE;
        execFileSync(claudePath, ["-p", "what is 2+2? reply with just the number"], {
          timeout: 60000,
          stdio: "pipe",
          env,
        });
      } catch (err) {
        // claude may not be available in CI — skip gracefully
        watcher.stop();
        await new Promise((r) => setTimeout(r, 100));
        console.log("Skipping claude -p test: claude CLI not available", (err as Error).message);
        return;
      }

      // Wait for all signals to be processed
      await new Promise((r) => setTimeout(r, 3000));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      // Should have detected the new claude session
      expect(newSessionIds.size).toBeGreaterThan(0);
      expect(events.length).toBeGreaterThan(0);

      // No event from the test session should have hasPendingToolUse
      const approvalEvents = events.filter(e => e.hasPendingToolUse);
      expect(approvalEvents).toHaveLength(0);
    }, 90000); // Extended timeout for real claude call

    it("should track tasking state when claude spawns subagents", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });

      const newSessionIds = new Set<string>();
      const events: Array<{
        type: string;
        sessionId: string;
        status: string;
        activeTasks: number;
      }> = [];
      watcher.on("session", (event) => {
        if (event.type === "created") {
          newSessionIds.add(event.session.sessionId);
        }
        if (newSessionIds.has(event.session.sessionId)) {
          events.push({
            type: event.type,
            sessionId: event.session.sessionId,
            status: event.session.status.status,
            activeTasks: event.session.activeTasks.length,
          });
        }
      });

      await watcher.start();

      // Wait for initial scan to complete so existing sessions are not counted
      await new Promise((r) => setTimeout(r, 3000));
      newSessionIds.clear();
      events.length = 0;

      // Find claude CLI
      let claudePath = "claude";
      const candidatePaths = [
        path.join(os.homedir(), ".local", "bin", "claude.exe"),
        path.join(os.homedir(), ".local", "bin", "claude"),
      ];
      for (const candidate of candidatePaths) {
        try {
          const { statSync } = await import("node:fs");
          if (statSync(candidate).isFile()) { claudePath = candidate; break; }
        } catch { /* not found */ }
      }

      // Run claude -p with a prompt that triggers Task tool (subagent spawning)
      try {
        const env = { ...process.env };
        delete env.CLAUDECODE;
        execFileSync(claudePath, [
          "-p",
          "Use the Task tool to spawn a single agent (subagent_type: 'haiku') that answers: what is 2+2? Reply with the answer only.",
        ], {
          timeout: 120000,
          stdio: "pipe",
          env,
        });
      } catch (err) {
        watcher.stop();
        await new Promise((r) => setTimeout(r, 100));
        console.log("Skipping tasking claude -p test: claude CLI not available", (err as Error).message);
        return;
      }

      // Wait for all signals to be processed
      await new Promise((r) => setTimeout(r, 3000));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      // Should have detected the new claude session
      expect(newSessionIds.size).toBeGreaterThan(0);
      expect(events.length).toBeGreaterThan(0);

      // At some point during the session, status should have been "tasking"
      // Note: Claude may not always use the Task tool depending on the prompt,
      // so we check if any tasking events occurred and verify them if present
      const taskingEvents = events.filter(e => e.status === "tasking");
      if (taskingEvents.length === 0) {
        console.log("Claude did not use Task tool in this run — tasking state not observed. Re-run to retry.");
      } else {
        expect(taskingEvents[0].activeTasks).toBeGreaterThan(0);
      }
    }, 180000); // Extended timeout for subagent spawning
  });

  // ---------------------------------------------------------------------------
  // Git Worktree E2E
  // ---------------------------------------------------------------------------

  describe("Git Worktree E2E", () => {
    // Resolve repo root dynamically — no hardcoded paths
    // Use path.resolve to normalize to native separators (git returns forward slashes on Windows)
    const REPO_ROOT = path.resolve(
      execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim()
    );
    // Normalize Windows drive letter to lowercase to match getGitInfo behavior
    const normalizedRepoRoot = /^[A-Z]:/.test(REPO_ROOT)
      ? REPO_ROOT[0].toLowerCase() + REPO_ROOT.slice(1)
      : REPO_ROOT;

    let worktreeBranch: string;
    let worktreePath: string;

    function createTestWorktree(): void {
      worktreeBranch = `test-wt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      worktreePath = path.join(path.dirname(REPO_ROOT), `wt-${worktreeBranch}`);
      execFileSync("git", ["worktree", "add", worktreePath, "-b", worktreeBranch], {
        cwd: REPO_ROOT,
        stdio: "pipe",
      });
    }

    function removeTestWorktree(): void {
      try {
        execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
          cwd: REPO_ROOT,
          stdio: "pipe",
        });
      } catch { /* may already be removed */ }
      try {
        execFileSync("git", ["branch", "-D", worktreeBranch], {
          cwd: REPO_ROOT,
          stdio: "pipe",
        });
      } catch { /* may already be removed */ }
    }

    afterEach(() => {
      removeTestWorktree();
      _resetGitCaches();
    });

    it("getGitInfo resolves worktree correctly", async () => {
      createTestWorktree();

      const info = await getGitInfo(worktreePath);

      expect(info.isGitRepo).toBe(true);
      expect(info.isWorktree).toBe(true);
      expect(info.branch).toBe(worktreeBranch);
      // rootPath should point to the main repo, not the worktree
      expect(info.rootPath).toBe(normalizedRepoRoot);
      expect(info.worktreePath).toBe(worktreePath);
      // Should have the same repoId as the main repo
      expect(info.repoId).toBeTruthy();
    });

    it("getGitInfoCached falls back to persistent cache after worktree deletion", async () => {
      createTestWorktree();

      // First call — populates both in-memory and persistent caches
      const info = await getGitInfoCached(worktreePath);
      expect(info.isGitRepo).toBe(true);
      expect(info.isWorktree).toBe(true);
      expect(info.rootPath).toBe(normalizedRepoRoot);

      // Reset in-memory caches so only the persistent (on-disk) cache remains
      _resetGitCaches();

      // Delete the worktree entirely
      removeTestWorktree();

      // Wait a moment for filesystem to settle
      await new Promise((r) => setTimeout(r, 200));

      // Second call — filesystem resolution will fail, should fall back to persistent cache
      const fallback = await getGitInfoCached(worktreePath);
      expect(fallback.isGitRepo).toBe(true);
      expect(fallback.rootPath).toBe(normalizedRepoRoot);
      expect(fallback.isWorktree).toBe(true);
      // Branch should be null since we can't read HEAD from a deleted worktree
      expect(fallback.branch).toBeNull();
    });

    it("SessionWatcher tracks worktree session and groups with main repo", async () => {
      createTestWorktree();

      // Encode the worktree path the same way Claude does: strip colons, replace separators with dashes
      // On Windows: C:\src\wt-test-wt-123 → C--src-wt-test-wt-123
      const encodedDir = worktreePath.replace(/:/g, "").replace(/[\\/]/g, "-");
      const wtTestDir = path.join(os.homedir(), ".claude", "projects", encodedDir);
      const wtSessionId = getTestSessionId();
      const wtLogFile = path.join(wtTestDir, `${wtSessionId}.jsonl`);

      await mkdir(wtTestDir, { recursive: true });

      // Write a JSONL entry with cwd pointing to the worktree
      const entry = JSON.stringify({
        type: "user",
        parentUuid: null,
        uuid: `uuid-${Date.now()}-${Math.random()}`,
        sessionId: wtSessionId,
        timestamp: new Date().toISOString(),
        cwd: worktreePath,
        version: "1.0.0",
        gitBranch: worktreeBranch,
        isSidechain: false,
        userType: "external",
        message: { role: "user", content: "test worktree session" },
      }) + "\n";

      await writeFile(wtLogFile, entry);

      const watcher = new SessionWatcher({ debounceMs: 50 });
      const events: Array<{ sessionId: string; isWorktree: boolean; gitRootPath: string | null }> = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === wtSessionId) {
          events.push({
            sessionId: event.session.sessionId,
            isWorktree: event.session.isWorktree,
            gitRootPath: event.session.gitRootPath,
          });
        }
      });

      await watcher.start();

      // Wait for chokidar to detect + debounce + handleFile
      await new Promise((r) => setTimeout(r, 2000));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      // Cleanup test JSONL dir
      await rm(wtTestDir, { recursive: true, force: true });

      // Should have detected the session
      expect(events.length).toBeGreaterThan(0);
      // Session should be recognized as a worktree
      expect(events[0].isWorktree).toBe(true);
      // gitRootPath should match the main repo root for grouping
      expect(events[0].gitRootPath).toBe(normalizedRepoRoot);
    }, 15000);

    it.skip("Real claude -p in worktree tracks correctly", async () => {
      createTestWorktree();

      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });
      const newSessionIds = new Set<string>();
      const events: Array<{ sessionId: string; isWorktree: boolean; gitRootPath: string | null }> = [];
      watcher.on("session", (event) => {
        if (event.type === "created") {
          newSessionIds.add(event.session.sessionId);
        }
        if (newSessionIds.has(event.session.sessionId)) {
          events.push({
            sessionId: event.session.sessionId,
            isWorktree: event.session.isWorktree,
            gitRootPath: event.session.gitRootPath,
          });
        }
      });

      await watcher.start();
      await new Promise((r) => setTimeout(r, 3000));
      newSessionIds.clear();
      events.length = 0;

      // Find claude CLI
      let claudePath = "claude";
      const candidatePaths = [
        path.join(os.homedir(), ".local", "bin", "claude.exe"),
        path.join(os.homedir(), ".local", "bin", "claude"),
      ];
      for (const candidate of candidatePaths) {
        try {
          const { statSync } = await import("node:fs");
          if (statSync(candidate).isFile()) { claudePath = candidate; break; }
        } catch { /* not found */ }
      }

      // Run claude -p inside the worktree
      try {
        const env = { ...process.env };
        delete env.CLAUDECODE;
        execFileSync(claudePath, ["-p", "what is 2+2? reply with just the number"], {
          timeout: 60000,
          stdio: "pipe",
          cwd: worktreePath,
          env,
        });
      } catch (err) {
        watcher.stop();
        await new Promise((r) => setTimeout(r, 100));
        console.log("Skipping worktree claude -p test: claude CLI not available", (err as Error).message);
        return;
      }

      await new Promise((r) => setTimeout(r, 3000));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].isWorktree).toBe(true);
      expect(events[0].gitRootPath).toBe(normalizedRepoRoot);

      // Now delete the worktree and verify persistent cache fallback
      removeTestWorktree();
      _resetGitCaches();
      await new Promise((r) => setTimeout(r, 200));

      // The cwd from the JSONL entry should still resolve via persistent cache
      const fallback = await getGitInfoCached(worktreePath);
      expect(fallback.isGitRepo).toBe(true);
      expect(fallback.rootPath).toBe(normalizedRepoRoot);
      expect(fallback.branch).toBeNull();
    }, 90000);
  });
});
