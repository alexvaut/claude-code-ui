/**
 * Per-session transition log.
 *
 * Appends one human-readable line per state transition to
 * ~/.claude/session-logs/<sessionId>.log
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionMachineState } from "./status-machine.js";

const LOGS_DIR = `${process.env.HOME}/.claude/session-logs`;

let dirEnsured = false;

/** Sessions that already got their [init] line this process lifetime. */
const initialized = new Set<string>();

export interface TransitionMeta {
  event: string;
  source: "hook" | "stale-check" | "replay";
  signal?: string;
  tool?: string;
  entryType?: string;
  elapsed?: number;
  entryCount?: number;
}

export interface HookEventMeta {
  signal?: string;
  tool?: string;
  agent?: string;
  desc?: string;
  reason?: string;
  id?: string;
}

function formatLine(
  from: SessionMachineState | null,
  to: SessionMachineState,
  meta: TransitionMeta,
): string {
  const ts = new Date().toISOString();

  // State column
  const stateCol = from === null
    ? `[init] ${to}`
    : `${from} -> ${to}`;

  // Key-value pairs
  const parts: string[] = [];
  if (from !== null) parts.push(`event:${meta.event}`);
  parts.push(`source:${meta.source}`);
  if (meta.signal) parts.push(`signal:${meta.signal}`);
  if (meta.tool) parts.push(`tool:${meta.tool}`);
  if (meta.entryType) parts.push(`entry:${meta.entryType}`);
  if (meta.elapsed != null) parts.push(`elapsed:${Math.round(meta.elapsed / 1000)}s`);
  if (meta.entryCount != null) parts.push(`entries:${meta.entryCount}`);

  return `${ts}  ${stateCol.padEnd(30)}  ${parts.join("  ")}\n`;
}

/**
 * Append a transition line to the session's log file.
 * Fire-and-forget — errors are silently ignored.
 */
export function appendTransition(
  sessionId: string,
  from: SessionMachineState | null,
  to: SessionMachineState,
  meta: TransitionMeta,
): void {
  // Skip duplicate [init] lines — only write one per session per daemon lifetime
  if (from === null) {
    if (initialized.has(sessionId)) return;
    initialized.add(sessionId);
  }

  const line = formatLine(from, to, meta);

  const write = async () => {
    if (!dirEnsured) {
      await mkdir(LOGS_DIR, { recursive: true });
      dirEnsured = true;
    }
    await appendFile(join(LOGS_DIR, `${sessionId}.log`), line);
  };

  write().catch(() => {});
}

function formatHookLine(hookName: string, meta?: HookEventMeta): string {
  const ts = new Date().toISOString();
  const stateCol = `[hook] ${hookName}`;

  const parts: string[] = [];
  if (meta?.tool) parts.push(`tool:${meta.tool}`);
  if (meta?.agent) parts.push(`agent:${meta.agent}`);
  if (meta?.desc) parts.push(`desc:${meta.desc}`);
  if (meta?.reason) parts.push(`reason:${meta.reason}`);
  if (meta?.id) parts.push(`id:${meta.id}`);
  if (meta?.signal) parts.push(`signal:${meta.signal}`);

  return `${ts}  ${stateCol.padEnd(30)}  ${parts.join("  ")}\n`;
}

/**
 * Append a hook event line to the session's log file.
 * Fire-and-forget — errors are silently ignored.
 */
export function appendHookEvent(
  sessionId: string,
  hookName: string,
  meta?: HookEventMeta,
): void {
  const line = formatHookLine(hookName, meta);

  const write = async () => {
    if (!dirEnsured) {
      await mkdir(LOGS_DIR, { recursive: true });
      dirEnsured = true;
    }
    await appendFile(join(LOGS_DIR, `${sessionId}.log`), line);
  };

  write().catch(() => {});
}

/** Exposed for the log-server to resolve file paths. */
export const SESSION_LOGS_DIR = LOGS_DIR;
