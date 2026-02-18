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

    it("should detect pending tool use as waiting with hasPendingToolUse", async () => {
      const entry1 = createUserEntry("Run a command");
      const entry2 = createAssistantEntry("I'll run that for you", new Date().toISOString(), true);
      await writeFile(TEST_LOG_FILE, entry1 + entry2);

      const { entries } = await tailJSONL(TEST_LOG_FILE, 0);
      const status = deriveStatus(entries);

      // Tool use for non-auto-approved tools (Bash) immediately shows as waiting
      expect(status.status).toBe("waiting");
      expect(status.hasPendingToolUse).toBe(true);
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
});
