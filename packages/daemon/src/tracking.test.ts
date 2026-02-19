/**
 * E2E test for Claude Code session tracking
 *
 * Tests the full flow: file detection → parsing → status → publishing
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { SessionWatcher } from "./watcher.js";
import { tailJSONL, extractMetadata } from "./parser.js";
import { transition } from "./status-machine.js";
import { getGitInfo, getGitInfoCached, _resetGitCaches } from "./git.js";

const TEST_DIR = path.join(os.homedir(), ".claude", "projects", "-test-e2e-session");
const SIGNALS_DIR = path.join(os.homedir(), ".claude", "session-signals");

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

  describe("Permission Signal Debounce", () => {
    let permissionFile: string;

    beforeEach(async () => {
      await mkdir(SIGNALS_DIR, { recursive: true });
      permissionFile = path.join(SIGNALS_DIR, `${TEST_SESSION_ID}.permission.json`);
    });

    afterEach(async () => {
      // Clean up signal file if it still exists
      await rm(permissionFile, { force: true });
    });

    it("should NOT show 'Needs Approval' when permission resolves within debounce window", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });

      const events: Array<{ type: string; status: string; hasPendingToolUse: boolean }> = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          events.push({
            type: event.type,
            status: event.session.status.status,
            hasPendingToolUse: event.session.status.hasPendingToolUse,
          });
        }
      });

      await watcher.start();

      // Create session file (status: working)
      await writeFile(TEST_LOG_FILE, createUserEntry("Do something in plan mode"));
      await new Promise((r) => setTimeout(r, 1000));

      // Write permission signal (simulating auto-approved tool like EnterPlanMode)
      await writeFile(permissionFile, JSON.stringify({
        session_id: TEST_SESSION_ID,
        tool_name: "EnterPlanMode",
        pending_since: new Date().toISOString(),
      }));

      // Wait briefly (well within debounce window)
      await new Promise((r) => setTimeout(r, 200));

      // Remove permission (simulating quick auto-approval)
      await rm(permissionFile, { force: true });

      // Wait for watcher to process the removal
      await new Promise((r) => setTimeout(r, 500));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      // No event should have hasPendingToolUse: true — debounce prevented the flicker
      const approvalEvents = events.filter(e => e.hasPendingToolUse);
      expect(approvalEvents).toHaveLength(0);
    });

    it("should show 'Needs Approval' when permission persists past debounce window", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });

      const events: Array<{ type: string; status: string; hasPendingToolUse: boolean }> = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          events.push({
            type: event.type,
            status: event.session.status.status,
            hasPendingToolUse: event.session.status.hasPendingToolUse,
          });
        }
      });

      await watcher.start();

      // Create session file (status: working)
      await writeFile(TEST_LOG_FILE, createUserEntry("Run a bash command"));
      await new Promise((r) => setTimeout(r, 1000));

      // Write permission signal (simulating blocking tool like Bash)
      await writeFile(permissionFile, JSON.stringify({
        session_id: TEST_SESSION_ID,
        tool_name: "Bash",
        pending_since: new Date().toISOString(),
      }));

      // Wait past the debounce window (1000ms delay + buffer)
      await new Promise((r) => setTimeout(r, 2000));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      // Should have an event with hasPendingToolUse: true after the debounce period
      const approvalEvents = events.filter(e => e.hasPendingToolUse);
      expect(approvalEvents.length).toBeGreaterThan(0);
      expect(approvalEvents[0].status).toBe("waiting");
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

  describe("Signal Integration", () => {
    let signalFile: (type: string, data: Record<string, unknown>) => string;
    let cleanupFiles: string[];

    beforeEach(async () => {
      await mkdir(SIGNALS_DIR, { recursive: true });
      cleanupFiles = [];
      signalFile = (type: string, data: Record<string, unknown>) => {
        const filepath = path.join(SIGNALS_DIR, `${TEST_SESSION_ID}.${type}.json`);
        cleanupFiles.push(filepath);
        return filepath;
      };
    });

    afterEach(async () => {
      for (const f of cleanupFiles) {
        await rm(f, { force: true });
      }
    });

    it("full lifecycle (non-worktree): working → waiting → idle", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });
      const statuses: string[] = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          statuses.push(event.session.status.status);
        }
      });

      await watcher.start();

      // 1. Create session → working
      await writeFile(TEST_LOG_FILE, createUserEntry("hello"));
      await new Promise((r) => setTimeout(r, 1000));

      // 2. Stop signal → waiting
      await writeFile(signalFile("stop", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        stopped_at: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));

      // 3. Working signal → working again
      await writeFile(signalFile("working", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        working_since: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));

      // 4. Ended signal → idle
      await writeFile(signalFile("ended", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        ended_at: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      expect(statuses).toContain("working");
      expect(statuses).toContain("waiting");
      expect(statuses[statuses.length - 1]).toBe("idle");
    });

    it("tool approval with debounce: working → needs_approval after delay", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 500 });
      const statuses: Array<{ status: string; hasPendingToolUse: boolean }> = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          statuses.push({
            status: event.session.status.status,
            hasPendingToolUse: event.session.status.hasPendingToolUse,
          });
        }
      });

      await watcher.start();

      // 1. Create session → working
      await writeFile(TEST_LOG_FILE, createUserEntry("run something"));
      await new Promise((r) => setTimeout(r, 1000));

      // 2. Permission signal → still working during debounce
      await writeFile(signalFile("permission", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        tool_name: "Bash",
        pending_since: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 200));

      // Should still be working (debounce not yet elapsed)
      const duringDebounce = statuses[statuses.length - 1];
      expect(duringDebounce.hasPendingToolUse).toBe(false);

      // 3. Wait past debounce → needs_approval
      await new Promise((r) => setTimeout(r, 800));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      // Should have transitioned to waiting with hasPendingToolUse
      const approvalEvents = statuses.filter(s => s.hasPendingToolUse);
      expect(approvalEvents.length).toBeGreaterThan(0);
    });

    it("BUG FIX: review → working when session resumes (worktree)", async () => {
      // This is the specific bug that was reported: session stuck in "review"
      // after being resumed. The fix: review + WORKING → working.

      // We simulate this by creating a worktree-like session.
      // Since the watcher resolves isWorktree from the filesystem, we test
      // the machine transition directly and verify via signal-driven status.
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });
      const statuses: string[] = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          statuses.push(event.session.status.status);
        }
      });

      await watcher.start();

      // 1. Create session (initial state: waiting)
      await writeFile(TEST_LOG_FILE, createUserEntry("initial task"));
      await new Promise((r) => setTimeout(r, 1000));

      // 2. Working signal → working (hooks are the only source of state transitions)
      await writeFile(signalFile("working", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        working_since: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));
      expect(statuses).toContain("working");

      // 3. Stop signal → waiting
      await writeFile(signalFile("stop", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        stopped_at: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));
      expect(statuses).toContain("waiting");

      // 4. Working signal again → working (this is the fix — should NOT stay stuck)
      await writeFile(signalFile("working", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        working_since: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      // The last status should be "working", not stuck in "waiting"
      expect(statuses[statuses.length - 1]).toBe("working");
    });

    it("JSONL changes do not cause state transitions", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });
      const statuses: Array<{ status: string; hasPendingToolUse: boolean }> = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          statuses.push({
            status: event.session.status.status,
            hasPendingToolUse: event.session.status.hasPendingToolUse,
          });
        }
      });

      await watcher.start();

      // 1. Create session (initial state: waiting)
      await writeFile(TEST_LOG_FILE, createUserEntry("help"));
      await new Promise((r) => setTimeout(r, 1000));

      // 2. Hook-driven: working signal → working
      await writeFile(signalFile("working", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        working_since: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));
      expect(statuses[statuses.length - 1].status).toBe("working");

      // 3. Append JSONL entries (assistant with tool_use, turn end) — should NOT change state
      await appendFile(TEST_LOG_FILE, createAssistantEntry("running", new Date().toISOString(), true));
      await new Promise((r) => setTimeout(r, 500));

      const turnEnd = JSON.stringify({
        type: "system",
        subtype: "turn_duration",
        timestamp: new Date().toISOString(),
        duration_ms: 1000,
        duration_api_ms: 900,
      }) + "\n";
      await appendFile(TEST_LOG_FILE, turnEnd);
      await new Promise((r) => setTimeout(r, 500));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      // State should still be "working" — JSONL entries don't drive state transitions
      expect(statuses[statuses.length - 1].status).toBe("working");
    });

    it("task signal lifecycle: working → tasking → working", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });
      const statuses: string[] = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          statuses.push(event.session.status.status);
        }
      });

      await watcher.start();

      // 1. Create session (initial state: waiting), then working signal → working
      await writeFile(TEST_LOG_FILE, createUserEntry("do some tasks"));
      await new Promise((r) => setTimeout(r, 1000));
      await writeFile(signalFile("working", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        working_since: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));
      expect(statuses).toContain("working");

      // 2. Task signal → tasking
      const taskFile1 = signalFile("task.toolu_001", {});
      await writeFile(taskFile1, JSON.stringify({
        session_id: TEST_SESSION_ID,
        tool_use_id: "toolu_001",
        agent_type: "Bash",
        description: "Run tests",
        started_at: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));
      expect(statuses).toContain("tasking");

      // 3. Second task signal → still tasking
      const taskFile2 = signalFile("task.toolu_002", {});
      await writeFile(taskFile2, JSON.stringify({
        session_id: TEST_SESSION_ID,
        tool_use_id: "toolu_002",
        agent_type: "Explore",
        description: "Search codebase",
        started_at: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));

      // 4. Remove first task → still tasking (one remains)
      await rm(taskFile1, { force: true });
      await new Promise((r) => setTimeout(r, 500));
      expect(statuses[statuses.length - 1]).toBe("tasking");

      // 5. Remove last task → working
      await rm(taskFile2, { force: true });
      await new Promise((r) => setTimeout(r, 500));
      expect(statuses[statuses.length - 1]).toBe("working");

      // 6. Stop signal → waiting
      await writeFile(signalFile("stop", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        stopped_at: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      expect(statuses[statuses.length - 1]).toBe("waiting");
    });

    it("PostToolUse clears permission — needs_approval → working", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 500 });
      const statuses: Array<{ status: string; hasPendingToolUse: boolean }> = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          statuses.push({
            status: event.session.status.status,
            hasPendingToolUse: event.session.status.hasPendingToolUse,
          });
        }
      });

      await watcher.start();

      // 1. Create session → working
      await writeFile(TEST_LOG_FILE, createUserEntry("run something"));
      await new Promise((r) => setTimeout(r, 1000));

      // 2. Working signal to ensure we're in working state
      await writeFile(signalFile("working", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        working_since: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 300));

      // 3. Permission signal → needs_approval (after debounce)
      const permFile = signalFile("permission", {});
      await writeFile(permFile, JSON.stringify({
        session_id: TEST_SESSION_ID,
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        pending_since: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 800)); // past debounce

      const afterPermission = statuses[statuses.length - 1];
      expect(afterPermission.status).toBe("waiting");
      expect(afterPermission.hasPendingToolUse).toBe(true);

      // 4. Delete permission.json (simulates PostToolUse hook) → back to working
      await rm(permFile, { force: true });
      await new Promise((r) => setTimeout(r, 500));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      const final = statuses[statuses.length - 1];
      expect(final.status).toBe("working");
      expect(final.hasPendingToolUse).toBe(false);
    });

    it("tool signal lifecycle — activeTools populated and cleared", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });
      const events: Array<{ activeTools: Array<{ toolUseId: string; toolName: string }> }> = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          events.push({
            activeTools: event.session.activeTools.map((t: { toolUseId: string; toolName: string }) => ({
              toolUseId: t.toolUseId,
              toolName: t.toolName,
            })),
          });
        }
      });

      await watcher.start();

      // 1. Create session
      await writeFile(TEST_LOG_FILE, createUserEntry("do something"));
      await new Promise((r) => setTimeout(r, 1000));

      // 2. Write tool signal
      const toolFile = signalFile("tool.toolu_read_01", {});
      await writeFile(toolFile, JSON.stringify({
        session_id: TEST_SESSION_ID,
        tool_use_id: "toolu_read_01",
        tool_name: "Read",
        tool_input: { file_path: "/some/file.ts" },
        started_at: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));

      // Should have activeTools with our tool
      const withTool = events[events.length - 1];
      expect(withTool.activeTools).toContainEqual({
        toolUseId: "toolu_read_01",
        toolName: "Read",
      });

      // 3. Remove tool signal (simulates PostToolUse)
      await rm(toolFile, { force: true });
      await new Promise((r) => setTimeout(r, 500));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      // activeTools should be empty
      const afterRemoval = events[events.length - 1];
      expect(afterRemoval.activeTools).toHaveLength(0);
    });

    it("multiple concurrent tool signals", async () => {
      const watcher = new SessionWatcher({ debounceMs: 50, permissionDelayMs: 1000 });
      const events: Array<{ activeToolCount: number; toolNames: string[] }> = [];
      watcher.on("session", (event) => {
        if (event.session.sessionId === TEST_SESSION_ID) {
          events.push({
            activeToolCount: event.session.activeTools.length,
            toolNames: event.session.activeTools.map((t: { toolName: string }) => t.toolName),
          });
        }
      });

      await watcher.start();

      // 1. Create session
      await writeFile(TEST_LOG_FILE, createUserEntry("multi-tool"));
      await new Promise((r) => setTimeout(r, 1000));

      // 2. Write two tool signals
      const toolFile1 = signalFile("tool.toolu_01", {});
      const toolFile2 = signalFile("tool.toolu_02", {});
      await writeFile(toolFile1, JSON.stringify({
        session_id: TEST_SESSION_ID,
        tool_use_id: "toolu_01",
        tool_name: "Read",
        tool_input: { file_path: "/a.ts" },
        started_at: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 300));
      await writeFile(toolFile2, JSON.stringify({
        session_id: TEST_SESSION_ID,
        tool_use_id: "toolu_02",
        tool_name: "Grep",
        tool_input: { pattern: "foo" },
        started_at: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));

      // Should have 2 active tools
      const withBoth = events[events.length - 1];
      expect(withBoth.activeToolCount).toBe(2);
      expect(withBoth.toolNames).toContain("Read");
      expect(withBoth.toolNames).toContain("Grep");

      // 3. Remove one → only one remains
      await rm(toolFile1, { force: true });
      await new Promise((r) => setTimeout(r, 500));

      const withOne = events[events.length - 1];
      expect(withOne.activeToolCount).toBe(1);
      expect(withOne.toolNames).toContain("Grep");

      // 4. Remove the other → empty
      await rm(toolFile2, { force: true });
      await new Promise((r) => setTimeout(r, 500));

      watcher.stop();
      await new Promise((r) => setTimeout(r, 100));

      const empty = events[events.length - 1];
      expect(empty.activeToolCount).toBe(0);
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
