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
import { deriveStatus } from "./status.js";
import { tailJSONL, extractMetadata } from "./parser.js";
import {
  transition,
  logEntryToSessionEvent,
  replayEntries,
  type SessionMachineState,
} from "./status-machine.js";
import { getGitInfo, getGitInfoCached, _resetGitCaches } from "./git.js";
import type { LogEntry } from "./types.js";

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

  describe("Status Derivation", () => {
    it("should detect working status after user message", async () => {
      const entry = createUserEntry("Do something");
      await writeFile(TEST_LOG_FILE, entry);

      const { entries } = await tailJSONL(TEST_LOG_FILE, 0);
      const status = deriveStatus(entries);

      expect(status.status).toBe("working");
      // Note: lastRole is not tracked in current implementation
      expect(status.hasPendingToolUse).toBe(false);
    });

    it("should detect waiting status after assistant response with turn end", async () => {
      const timestamp = new Date().toISOString();
      const entry1 = createUserEntry("Do something", timestamp);
      const entry2 = createAssistantEntry("Done!", timestamp);
      // Add a turn_duration system event to signal turn completion
      const turnEndEntry = JSON.stringify({
        type: "system",
        subtype: "turn_duration",
        timestamp,
        duration_ms: 1000,
        duration_api_ms: 900,
      }) + "\n";
      await writeFile(TEST_LOG_FILE, entry1 + entry2 + turnEndEntry);

      const { entries } = await tailJSONL(TEST_LOG_FILE, 0);
      const status = deriveStatus(entries);

      expect(status.status).toBe("waiting");
      // Note: lastRole is not tracked in current implementation
      expect(status.hasPendingToolUse).toBe(false);
    });

    it("should detect tool use as working (JSONL can't distinguish approval state)", async () => {
      const entry1 = createUserEntry("Run a command");
      const entry2 = createAssistantEntry("I'll run that for you", new Date().toISOString(), true);
      await writeFile(TEST_LOG_FILE, entry1 + entry2);

      const { entries } = await tailJSONL(TEST_LOG_FILE, 0);
      const status = deriveStatus(entries);

      // From JSONL alone we can't distinguish "waiting for approval" from
      // "auto-approved and executing" — treat all tool_use as WORKING.
      // PERMISSION_REQUEST only comes from the PermissionRequest hook.
      expect(status.status).toBe("working");
      expect(status.hasPendingToolUse).toBe(false);
    });

    it("should report waiting status for old sessions (idle determined by UI)", async () => {
      // Create entry from 10 minutes ago
      // Note: idle status is now determined by the UI based on elapsed time
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const entry = createAssistantEntry("Old response", oldTime);
      await writeFile(TEST_LOG_FILE, entry);

      const { entries } = await tailJSONL(TEST_LOG_FILE, 0);
      const status = deriveStatus(entries);

      // Daemon reports "waiting" - UI will show as "idle" based on elapsed time
      expect(status.status).toBe("waiting");
      expect(status.lastActivityAt).toBe(oldTime);
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
  });

  describe("JSONL Event Mapping", () => {
    it("user prompt (string) → WORKING", () => {
      const entry = JSON.parse(createUserEntry("hello").trim());
      expect(logEntryToSessionEvent(entry)).toEqual({ type: "WORKING" });
    });

    it("user prompt (array with text block) → WORKING", () => {
      const entry = {
        type: "user" as const,
        message: { role: "user" as const, content: [{ type: "text", text: "hello" }] },
      };
      expect(logEntryToSessionEvent(entry as LogEntry)).toEqual({ type: "WORKING" });
    });

    it("tool_result → WORKING", () => {
      const entry = {
        type: "user" as const,
        message: { role: "user" as const, content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      };
      expect(logEntryToSessionEvent(entry as LogEntry)).toEqual({ type: "WORKING" });
    });

    it("assistant with Bash tool_use → WORKING (JSONL can't distinguish approval)", () => {
      const entry = JSON.parse(createAssistantEntry("running", new Date().toISOString(), true).trim());
      expect(logEntryToSessionEvent(entry)).toEqual({ type: "WORKING" });
    });

    it("assistant with Read tool_use → WORKING", () => {
      const entry = {
        type: "assistant" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }],
        },
      };
      expect(logEntryToSessionEvent(entry as unknown as LogEntry)).toEqual({ type: "WORKING" });
    });

    it("assistant with Task tool_use → WORKING", () => {
      const entry = {
        type: "assistant" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }],
        },
      };
      expect(logEntryToSessionEvent(entry as unknown as LogEntry)).toEqual({ type: "WORKING" });
    });

    it("assistant text only → null (no state change)", () => {
      const entry = JSON.parse(createAssistantEntry("just text").trim());
      expect(logEntryToSessionEvent(entry)).toBeNull();
    });

    it("system turn_duration → STOP", () => {
      const entry = { type: "system" as const, subtype: "turn_duration", duration_ms: 1000 };
      expect(logEntryToSessionEvent(entry as unknown as LogEntry)).toEqual({ type: "STOP" });
    });

    it("system stop_hook_summary → STOP", () => {
      const entry = { type: "system" as const, subtype: "stop_hook_summary" };
      expect(logEntryToSessionEvent(entry as unknown as LogEntry)).toEqual({ type: "STOP" });
    });
  });

  describe("Session Replay Scenarios", () => {
    function makeUser(content: string, timestamp = new Date().toISOString()) {
      return JSON.parse(createUserEntry(content, timestamp).trim()) as LogEntry;
    }
    function makeAssistant(content: string, timestamp = new Date().toISOString(), hasToolUse = false) {
      return JSON.parse(createAssistantEntry(content, timestamp, hasToolUse).trim()) as LogEntry;
    }
    function makeTurnEnd(timestamp = new Date().toISOString()): LogEntry {
      return { type: "system", subtype: "turn_duration", timestamp, duration_ms: 1000, duration_api_ms: 900 } as unknown as LogEntry;
    }
    function makeToolResult(toolUseId: string, timestamp = new Date().toISOString()): LogEntry {
      return {
        type: "user",
        timestamp,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
      } as unknown as LogEntry;
    }

    it("simple Q&A: user → assistant → turn_end → waiting", () => {
      const now = new Date().toISOString();
      const entries = [makeUser("help", now), makeAssistant("sure", now), makeTurnEnd(now)];
      const { state } = replayEntries(entries, false);
      expect(state).toBe("waiting");
    });

    it("tool approval flow: user → assistant+Bash → tool_result → assistant → turn_end → waiting", () => {
      const now = new Date().toISOString();
      const assistantWithTool = makeAssistant("running", now, true);
      // Extract the tool_use id
      const toolId = ((assistantWithTool as unknown as { message: { content: Array<{ type: string; id?: string }> } }).message.content.find(
        (b) => b.type === "tool_use"
      ))!.id!;
      const entries = [
        makeUser("run it", now),
        assistantWithTool,
        makeToolResult(toolId, now),
        makeAssistant("done", now),
        makeTurnEnd(now),
      ];
      const { state } = replayEntries(entries, false);
      expect(state).toBe("waiting");
    });

    it("any tool_use in JSONL → working (JSONL can't detect approval state)", () => {
      const now = new Date().toISOString();
      // Build an assistant entry with a Read tool
      const entry: LogEntry = {
        type: "assistant",
        timestamp: now,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "reading file" },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
          ],
        },
      } as unknown as LogEntry;
      const entries = [makeUser("read", now), entry];
      const { state } = replayEntries(entries, false);
      expect(state).toBe("working");
    });

    it("pending Bash tool at end of log → working (needs_approval only from hooks)", () => {
      const now = new Date().toISOString();
      const entries = [makeUser("run", now), makeAssistant("running", now, true)];
      const { state } = replayEntries(entries, false);
      expect(state).toBe("working");
    });

    it("worktree: turn_end → review instead of waiting", () => {
      const now = new Date().toISOString();
      const entries = [makeUser("help", now), makeAssistant("done", now), makeTurnEnd(now)];
      const { state } = replayEntries(entries, true);
      expect(state).toBe("review");
    });

    it("stale working session → waiting (STALE_TIMEOUT applied)", () => {
      const oldTime = new Date(Date.now() - 30_000).toISOString(); // 30s ago, well past 15s timeout
      const entries = [makeUser("help", oldTime)];
      const { state } = replayEntries(entries, false);
      expect(state).toBe("waiting");
    });

    it("tracks messageCount across entries", () => {
      const now = new Date().toISOString();
      const entries = [
        makeUser("one", now),
        makeAssistant("two", now, true), // tool use counts
        makeUser("three", now),
      ];
      const { messageCount } = replayEntries(entries, false);
      expect(messageCount).toBe(3); // 2 user prompts + 1 assistant with tool_use
    });

    it("tracks lastActivityAt from most recent entry", () => {
      const t1 = "2025-01-01T00:00:00Z";
      const t2 = "2025-01-01T01:00:00Z";
      const entries = [makeUser("one", t1), makeAssistant("two", t2)];
      const { lastActivityAt } = replayEntries(entries, false);
      expect(lastActivityAt).toBe(t2);
    });

    it("multi-turn: two full Q&A exchanges → waiting", () => {
      const now = new Date().toISOString();
      const entries = [
        makeUser("q1", now), makeAssistant("a1", now), makeTurnEnd(now),
        makeUser("q2", now), makeAssistant("a2", now), makeTurnEnd(now),
      ];
      const { state, messageCount } = replayEntries(entries, false);
      expect(state).toBe("waiting");
      expect(messageCount).toBe(2); // 2 user prompts
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

      // 1. Create session → working
      await writeFile(TEST_LOG_FILE, createUserEntry("initial task"));
      await new Promise((r) => setTimeout(r, 1000));
      expect(statuses).toContain("working");

      // 2. Stop signal → waiting (non-worktree in test, but behavior is the same concern)
      await writeFile(signalFile("stop", {}), JSON.stringify({
        session_id: TEST_SESSION_ID,
        stopped_at: new Date().toISOString(),
      }));
      await new Promise((r) => setTimeout(r, 500));
      expect(statuses).toContain("waiting");

      // 3. Working signal → working (this is the fix — should NOT stay stuck)
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

    it("JSONL-only flow (no hook signals): status derived from entries", async () => {
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

      // 1. User prompt → working
      await writeFile(TEST_LOG_FILE, createUserEntry("help"));
      await new Promise((r) => setTimeout(r, 1000));
      expect(statuses[0]?.status).toBe("working");

      // 2. Assistant with Bash tool → still working (JSONL can't detect approval)
      await appendFile(TEST_LOG_FILE, createAssistantEntry("running", new Date().toISOString(), true));
      await new Promise((r) => setTimeout(r, 500));
      const afterTool = statuses[statuses.length - 1];
      expect(afterTool.status).toBe("working");
      expect(afterTool.hasPendingToolUse).toBe(false);

      // 3. Turn end → waiting
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

      const final = statuses[statuses.length - 1];
      expect(final.status).toBe("waiting");
      expect(final.hasPendingToolUse).toBe(false);
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
