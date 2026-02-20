/**
 * Unified session state machine.
 *
 * A single pure transition function handles ALL events — from hook signals,
 * timers, and periodic checks. The machine state IS the session status.
 * State transitions come exclusively from hooks; JSONL is for content only.
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
 *              WORKING  STOP(wt)  STOP(!wt)  ENDED(wt)  ENDED(!wt)  PERM_REQ        TASK_STARTED  TASKS_DONE  WORKTREE_DEL  TOOL_ACT
 *   working      ·      review    waiting    review     idle        needs_approval   tasking          ·           ·              ·
 *   tasking      ·      review    waiting    review     idle        needs_approval      ·          working        ·              ·
 *   needs_appr working  review    waiting    review     idle        needs_approval      ·             ·           ·              ·
 *   waiting    working    ·          ·       review     idle        needs_approval      ·             ·           ·           working
 *   review     working    ·          ·          ·          ·            ·                ·             ·          idle         working
 *   idle       working    ·          ·          ·          ·            ·                ·             ·           ·           working
 *
 *   · = no transition (stay in current state)
 */

import type { LogEntry, AssistantEntry, UserEntry } from "./types.js";

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
  | { type: "TASKS_DONE" }
  | { type: "TOOL_ACTIVITY" };

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
        case "TOOL_ACTIVITY": return "working";
        case "ENDED": return isWorktree ? "review" : "idle";
        case "PERMISSION_REQUEST": return "needs_approval";
        default: return state;
      }

    case "review":
      switch (event.type) {
        case "WORKING": return "working";
        case "TOOL_ACTIVITY": return "working";
        case "WORKTREE_DELETED": return "idle";
        default: return state;
      }

    case "idle":
      switch (event.type) {
        case "WORKING": return "working";
        case "TOOL_ACTIVITY": return "working";
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
// JSONL metadata extraction (content only, no state transitions)
// ---------------------------------------------------------------------------

export interface EntryMetadata {
  lastActivityAt: string;
  messageCount: number;
}

/**
 * Extract metadata (timestamps, message counts) from log entries.
 * Does NOT derive state — state comes exclusively from hook signals.
 */
export function extractEntryMetadata(entries: LogEntry[]): EntryMetadata {
  let lastActivityAt = "";
  let messageCount = 0;

  for (const entry of entries) {
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
  }

  return { lastActivityAt, messageCount };
}
