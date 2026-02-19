import type {
  LogEntry,
  StatusResult,
  SessionStatus,
} from "./types.js";
import {
  replayEntries,
  machineStateToPublishedStatus,
} from "./status-machine.js";

/**
 * Derive session status from log entries using the unified state machine.
 *
 * Replays all entries through the pure transition function and maps
 * the final machine state to a StatusResult.
 */
export function deriveStatus(entries: LogEntry[], isWorktree = false): StatusResult {
  const { state, lastActivityAt, messageCount } = replayEntries(entries, isWorktree);
  const { status, hasPendingToolUse } = machineStateToPublishedStatus(state);

  return {
    status,
    lastRole: "assistant",
    hasPendingToolUse,
    lastActivityAt,
    messageCount,
  };
}

/**
 * Compare two status results to detect meaningful changes.
 */
export function statusChanged(
  prev: StatusResult | null | undefined,
  next: StatusResult
): boolean {
  if (!prev) return true;

  return (
    prev.status !== next.status ||
    prev.lastRole !== next.lastRole ||
    prev.hasPendingToolUse !== next.hasPendingToolUse
  );
}

/**
 * Format status for display.
 */
export function formatStatus(result: StatusResult): string {
  const icons: Record<SessionStatus, string> = {
    working: "🟢",
    tasking: "🔵",
    waiting: result.hasPendingToolUse ? "🟠" : "🟡",
    review: "🔵",
    idle: "⚪",
  };

  const labels: Record<SessionStatus, string> = {
    working: "Working",
    tasking: "Tasking",
    waiting: result.hasPendingToolUse ? "Tool pending" : "Waiting for input",
    review: "Review",
    idle: "Idle",
  };

  return `${icons[result.status]} ${labels[result.status]}`;
}

/**
 * Get a short status string for logging.
 */
export function getStatusKey(result: StatusResult): string {
  if (result.status === "waiting" && result.hasPendingToolUse) {
    return "waiting:tool";
  }
  return result.status;
}
