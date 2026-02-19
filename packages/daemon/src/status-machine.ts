/**
 * Unified session state machine.
 *
 * A single pure transition function handles ALL events — from JSONL entries,
 * hook signals, timers, and periodic checks. The machine state IS the session
 * status. No separate signal maps or priority chains needed.
 *
 * States:
 *   working         — Claude is actively processing
 *   tasking         — Claude is delegating to subagents (immune to stale timeout)
 *   needs_approval  — Tool use awaiting user approval
 *   waiting         — Claude finished, waiting for user input
 *   review          — Worktree session paused (turn ended or session closed)
 *   idle            — Session ended (non-worktree)
 *
 * Transition table:
 *
 *              WORKING  STOP(wt)  STOP(!wt)  ENDED(wt)  ENDED(!wt)  PERM_REQ        TASK_STARTED  TASKS_DONE  WORKTREE_DEL
 *   working      ·      review    waiting    review     idle        needs_approval   tasking          ·           ·
 *   tasking      ·      review    waiting    review     idle        needs_approval      ·          working        ·
 *   needs_appr working  review    waiting    review     idle        needs_approval      ·             ·           ·
 *   waiting    working    ·          ·          ·          ·         needs_approval      ·             ·           ·
 *   review     working    ·          ·          ·          ·            ·                ·             ·          idle
 *   idle       working    ·          ·          ·          ·            ·                ·             ·           ·
 *
 *   · = no transition (stay in current state)
 */

import type { LogEntry, AssistantEntry, UserEntry, SystemEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Machine types
// ---------------------------------------------------------------------------

export type SessionMachineState =
  | "working"
  | "tasking"
  | "needs_approval"
  | "waiting"
  | "review"
  | "idle";

export type SessionEvent =
  | { type: "WORKING" }
  | { type: "STOP" }
  | { type: "ENDED" }
  | { type: "PERMISSION_REQUEST" }
  | { type: "WORKTREE_DELETED" }
  | { type: "TASK_STARTED" }
  | { type: "TASKS_DONE" };

// ---------------------------------------------------------------------------
// Pure transition function
// ---------------------------------------------------------------------------

export function transition(
  state: SessionMachineState,
  event: SessionEvent,
  isWorktree: boolean,
): SessionMachineState {
  switch (state) {
    case "working":
      switch (event.type) {
        case "STOP": return isWorktree ? "review" : "waiting";
        case "ENDED": return isWorktree ? "review" : "idle";
        case "PERMISSION_REQUEST": return "needs_approval";
        case "TASK_STARTED": return "tasking";
        default: return state;
      }

    case "tasking":
      switch (event.type) {
        case "STOP": return isWorktree ? "review" : "waiting";
        case "ENDED": return isWorktree ? "review" : "idle";
        case "PERMISSION_REQUEST": return "needs_approval";
        case "TASKS_DONE": return "working";
        default: return state;
      }

    case "needs_approval":
      switch (event.type) {
        case "WORKING": return "working";
        case "STOP": return isWorktree ? "review" : "waiting";
        case "ENDED": return isWorktree ? "review" : "idle";
        case "PERMISSION_REQUEST": return "needs_approval";
        default: return state;
      }

    case "waiting":
      switch (event.type) {
        case "WORKING": return "working";
        case "PERMISSION_REQUEST": return "needs_approval";
        default: return state;
      }

    case "review":
      switch (event.type) {
        case "WORKING": return "working";
        case "WORKTREE_DELETED": return "idle";
        default: return state;
      }

    case "idle":
      switch (event.type) {
        case "WORKING": return "working";
        default: return state;
      }
  }
}

// ---------------------------------------------------------------------------
// Published status mapping
// ---------------------------------------------------------------------------

export function machineStateToPublishedStatus(state: SessionMachineState): {
  status: "working" | "tasking" | "waiting" | "review" | "idle";
  hasPendingToolUse: boolean;
} {
  switch (state) {
    case "working": return { status: "working", hasPendingToolUse: false };
    case "tasking": return { status: "tasking", hasPendingToolUse: false };
    case "needs_approval": return { status: "waiting", hasPendingToolUse: true };
    case "waiting": return { status: "waiting", hasPendingToolUse: false };
    case "review": return { status: "review", hasPendingToolUse: false };
    case "idle": return { status: "idle", hasPendingToolUse: false };
  }
}

// ---------------------------------------------------------------------------
// JSONL → machine event mapping
// ---------------------------------------------------------------------------

/**
 * Convert a JSONL log entry to a machine event.
 * Returns null if the entry doesn't cause a state change.
 */
export function logEntryToSessionEvent(entry: LogEntry): SessionEvent | null {
  if (entry.type === "user") {
    const userEntry = entry as UserEntry;
    const content = userEntry.message.content;

    if (typeof content === "string") {
      return { type: "WORKING" };
    } else if (Array.isArray(content)) {
      // tool_result → WORKING (tool completed, back to work)
      const hasToolResult = content.some((b) => b.type === "tool_result");
      if (hasToolResult) {
        return { type: "WORKING" };
      }
      // Text blocks in array form (user prompt with images, etc.)
      const hasTextBlock = content.some((b) => b.type === "text");
      if (hasTextBlock) {
        return { type: "WORKING" };
      }
    }
  }

  if (entry.type === "assistant") {
    const assistantEntry = entry as AssistantEntry;
    const hasToolUse = assistantEntry.message.content.some(
      (b) => b.type === "tool_use"
    );

    if (hasToolUse) {
      // From JSONL alone we can't distinguish "waiting for approval" from
      // "auto-approved and executing". Treat all tool_use as WORKING — the
      // PERMISSION_REQUEST event should only come from the PermissionRequest hook
      // which fires precisely when user approval is actually needed.
      return { type: "WORKING" };
    }

    // Text-only assistant message — no state change
    return null;
  }

  if (entry.type === "system") {
    const systemEntry = entry as SystemEntry;
    if (systemEntry.subtype === "turn_duration" || systemEntry.subtype === "stop_hook_summary") {
      return { type: "STOP" };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Replay: derive state + metadata from a full entry list
// ---------------------------------------------------------------------------

const STALE_TIMEOUT_MS = 15 * 1000;

export interface ReplayResult {
  state: SessionMachineState;
  lastActivityAt: string;
  messageCount: number;
}

/**
 * Replay all log entries through the machine to derive current state + metadata.
 * Used for initial session load and JSONL-only (no hooks) status derivation.
 */
export function replayEntries(
  entries: LogEntry[],
  isWorktree: boolean,
): ReplayResult {
  let state: SessionMachineState = "waiting";
  let lastActivityAt = "";
  let messageCount = 0;

  for (const entry of entries) {
    // Update metadata from entry timestamp
    const timestamp = "timestamp" in entry ? (entry as { timestamp: string }).timestamp : "";
    if (timestamp) {
      lastActivityAt = timestamp;
    }

    // Count user prompts and tool-use assistant messages
    if (entry.type === "user") {
      const content = (entry as UserEntry).message.content;
      if (typeof content === "string") {
        messageCount += 1;
      } else if (Array.isArray(content)) {
        const hasToolResult = content.some((b) => b.type === "tool_result");
        if (hasToolResult) messageCount += 1;
        else if (content.some((b) => b.type === "text")) messageCount += 1;
      }
    } else if (entry.type === "assistant") {
      const assistantEntry = entry as AssistantEntry;
      const hasToolUse = assistantEntry.message.content.some((b) => b.type === "tool_use");
      if (hasToolUse) messageCount += 1;
    }

    // Transition state
    const event = logEntryToSessionEvent(entry);
    if (event) {
      state = transition(state, event, isWorktree);
    }
  }

  // Apply stale timeout for sessions with old activity.
  // Note: "tasking" is deliberately excluded — subagents run independently,
  // so the primary session being silent is expected.
  if (lastActivityAt) {
    const elapsed = Date.now() - new Date(lastActivityAt).getTime();
    if (elapsed > STALE_TIMEOUT_MS) {
      if (state === "working" || state === "needs_approval") {
        state = transition(state, { type: "STOP" }, isWorktree);
      }
    }
  }

  return { state, lastActivityAt, messageCount };
}
