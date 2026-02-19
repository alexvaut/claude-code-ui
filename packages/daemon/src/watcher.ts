import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";
import { readFile, unlink, readdir, access, constants } from "node:fs/promises";
import { join } from "node:path";
import {
  tailJSONL,
  extractMetadata,
  extractSessionId,
  extractEncodedDir,
} from "./parser.js";
import { statusChanged } from "./status.js";
import {
  transition,
  logEntryToSessionEvent,
  machineStateToPublishedStatus,
  replayEntries,
  type SessionMachineState,
  type SessionEvent as MachineEvent,
} from "./status-machine.js";
import { getGitInfoCached, type GitInfo } from "./git.js";
import type { LogEntry, SessionMetadata, StatusResult } from "./types.js";
import { log } from "./log.js";
import { appendTransition, type TransitionMeta } from "./transition-log.js";

const CLAUDE_PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;
const SIGNALS_DIR = `${process.env.HOME}/.claude/session-signals`;

export interface PendingPermission {
  session_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  pending_since: string;
}

export interface TaskSignal {
  session_id: string;
  tool_use_id: string;
  agent_type: string;
  description: string;
  started_at: string;
}

export interface CompactingSignal {
  session_id: string;
  started_at: string;
}

export interface ActiveTask {
  toolUseId: string;
  agentType: string;
  description: string;
  startedAt: string;
}

export interface TodoProgress {
  total: number;
  completed: number;
}

export interface SessionState {
  sessionId: string;
  filepath: string;
  encodedDir: string;
  cwd: string;
  gitBranch: string | null;
  originalPrompt: string;
  startedAt: string;
  status: StatusResult;
  entries: LogEntry[];
  bytePosition: number;
  // Git repo info
  gitRepoUrl: string | null;   // https://github.com/owner/repo
  gitRepoId: string | null;    // owner/repo
  gitRootPath: string | null;  // Absolute path to git repo root (for grouping)
  isWorktree: boolean;         // Whether this session is in a git worktree
  worktreePath: string | null; // The worktree checkout root directory
  // State machine
  machineState: SessionMachineState;
  isHookDriven: boolean;       // True once first hook signal arrives (skip stale timeout)
  // Set when branch changed since last update
  branchChanged?: boolean;
  // Pending permission data (set when debounce fires, cleared on exit from needs_approval)
  pendingPermission?: PendingPermission;
  // Active subagents spawned via Task tool
  activeTasks: ActiveTask[];
  // Todo progress from TodoWrite
  todoProgress: TodoProgress | null;
}

export interface SessionEvent {
  type: "created" | "updated" | "deleted";
  session: SessionState;
  previousStatus?: StatusResult;
}

export class SessionWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private signalWatcher: FSWatcher | null = null;
  private sessions = new Map<string, SessionState>();
  private taskSignals = new Map<string, Map<string, ActiveTask>>(); // sessionId → toolUseId → ActiveTask
  private compactingSignals = new Map<string, string>(); // sessionId → startedAt
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private permissionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;
  private permissionDelayMs: number;
  private staleCheckInterval: NodeJS.Timeout | null = null;

  constructor(options: { debounceMs?: number; permissionDelayMs?: number } = {}) {
    super();
    this.debounceMs = options.debounceMs ?? 200;
    this.permissionDelayMs = options.permissionDelayMs ?? 3000;
  }

  /**
   * Get pending permission for a session.
   */
  getPendingPermission(sessionId: string): PendingPermission | undefined {
    return this.sessions.get(sessionId)?.pendingPermission;
  }

  /**
   * Transition a session's machine state via an event.
   * Handles on-exit/on-enter side effects and emits update if state changed.
   * Returns true if state actually changed.
   */
  private transitionSession(sessionId: string, event: MachineEvent, meta: TransitionMeta): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const prevState = session.machineState;
    const nextState = transition(prevState, event, session.isWorktree);
    if (nextState === prevState) return false;

    // On-exit side effects
    if (prevState === "working" || prevState === "tasking" || prevState === "needs_approval") {
      // Cancel permission debounce timer (any pending debounce is stale)
      const timer = this.permissionTimers.get(sessionId);
      if (timer) { clearTimeout(timer); this.permissionTimers.delete(sessionId); }
    }
    if (prevState === "needs_approval" && nextState !== "needs_approval") {
      session.pendingPermission = undefined;
      this.cleanupSignalFile(sessionId, "permission");
    }

    // On-enter side effects
    if ((nextState === "working" || nextState === "tasking") && (prevState === "review" || prevState === "waiting" || prevState === "idle")) {
      this.cleanupSignalFile(sessionId, "stop");
      this.cleanupSignalFile(sessionId, "ended");
    }

    // Update state
    session.machineState = nextState;
    appendTransition(sessionId, prevState, nextState, meta);
    const previousStatus = session.status;
    const published = machineStateToPublishedStatus(nextState);
    session.status = { ...session.status, status: published.status, hasPendingToolUse: published.hasPendingToolUse };
    this.emit("session", { type: "updated", session, previousStatus } satisfies SessionEvent);

    // Auto-escalate: if we landed on "working" but have active tasks, transition to "tasking"
    if (nextState === "working" && session.activeTasks.length > 0) {
      this.transitionSession(sessionId, { type: "TASK_STARTED" }, { event: "TASK_STARTED", source: "hook", signal: "auto-escalate" });
    }

    return true;
  }

  /**
   * Best-effort cleanup of a signal file.
   */
  private cleanupSignalFile(sessionId: string, type: string): void {
    unlink(join(SIGNALS_DIR, `${sessionId}.${type}.json`)).catch(() => {});
  }

  async start(): Promise<void> {
    // Use directory watching instead of glob - chokidar has issues with
    // directories that start with dashes when using glob patterns
    this.watcher = watch(CLAUDE_PROJECTS_DIR, {
      ignored: /agent-.*\.jsonl$/,  // Ignore agent sub-session files
      persistent: true,
      ignoreInitial: false,
      depth: 2,
    });

    this.watcher
      .on("add", (path) => {
        if (!path.endsWith(".jsonl")) return;
        log("Watcher", `New file detected: ${path.replace(/\\/g, "/").split("/").slice(-2).join("/")}`);
        this.handleFile(path, "add");
      })
      .on("change", (path) => {
        if (!path.endsWith(".jsonl")) return;
        this.debouncedHandleFile(path);
      })
      .on("unlink", (path) => this.handleDelete(path))
      .on("error", (error) => this.emit("error", error));

    // Watch signals directory for hook output (permission, stop, session-end)
    this.signalWatcher = watch(SIGNALS_DIR, {
      persistent: true,
      ignoreInitial: false,
      depth: 0,
    });

    this.signalWatcher
      .on("add", (path) => {
        if (!path.endsWith(".json")) return;
        this.handleSignalFile(path);
      })
      .on("change", (path) => {
        if (!path.endsWith(".json")) return;
        this.handleSignalFile(path);
      })
      .on("unlink", (path) => {
        if (!path.endsWith(".json")) return;
        this.handleSignalRemoved(path);
      })
      .on("error", () => {
        // Ignore errors - directory may not exist if hooks aren't set up
      });

    // Wait for initial scan to complete
    await new Promise<void>((resolve) => {
      this.watcher!.on("ready", resolve);
    });

    // Load any existing signal files
    await this.loadExistingSignals();

    // Start periodic stale check to detect sessions that have gone idle
    // This catches cases where the turn ends but no turn_duration event is written
    this.staleCheckInterval = setInterval(() => {
      this.checkStaleSessions();
    }, 10_000); // Check every 10 seconds
  }

  /**
   * Load any existing signal files on startup.
   */
  private async loadExistingSignals(): Promise<void> {
    try {
      const files = await readdir(SIGNALS_DIR);
      for (const file of files) {
        if (file.endsWith(".json")) {
          await this.handleSignalFile(join(SIGNALS_DIR, file));
        }
      }
    } catch {
      // Directory doesn't exist or can't be read - that's fine
    }
  }

  /**
   * Parse signal filename to extract session ID and signal type.
   * Formats:
   *   <session_id>.<type>.json (e.g., abc123.permission.json)
   *   <session_id>.task.<tool_use_id>.json (e.g., abc123.task.toolu_xyz.json)
   *   <session_id>.compacting.json
   */
  private parseSignalFilename(filepath: string): { sessionId: string; type: "working" | "permission" | "stop" | "ended" | "task" | "compacting"; toolUseId?: string } | null {
    const filename = filepath.replace(/\\/g, "/").split("/").pop() || "";

    // Match task signals: <session_id>.task.<tool_use_id>.json
    const taskMatch = filename.match(/^(.+)\.task\.(.+)\.json$/);
    if (taskMatch) return { sessionId: taskMatch[1], type: "task", toolUseId: taskMatch[2] };

    // Match compacting signals: <session_id>.compacting.json
    const compactMatch = filename.match(/^(.+)\.compacting\.json$/);
    if (compactMatch) return { sessionId: compactMatch[1], type: "compacting" };

    // Match standard signals
    const match = filename.match(/^(.+)\.(working|permission|stop|ended)\.json$/);
    if (!match) return null;
    return { sessionId: match[1], type: match[2] as "working" | "permission" | "stop" | "ended" };
  }

  /**
   * Handle a signal file being created/updated.
   */
  private async handleSignalFile(filepath: string): Promise<void> {
    const parsed = this.parseSignalFilename(filepath);
    if (!parsed) return;

    const { sessionId, type } = parsed;

    try {
      const content = await readFile(filepath, "utf-8");
      const data = JSON.parse(content);

      if (type === "working") {
        log("Watcher", `Working signal for session ${sessionId}`);
        const session = this.sessions.get(sessionId);
        if (session) session.isHookDriven = true;
        this.transitionSession(sessionId, { type: "WORKING" }, { event: "WORKING", source: "hook", signal: "working.json" });
      } else if (type === "permission") {
        const permission = data as PendingPermission;
        log("Watcher", `Pending permission for session ${sessionId}: ${permission.tool_name}`);

        const session = this.sessions.get(sessionId);
        if (session) session.isHookDriven = true;

        // Cancel any existing debounce timer
        const existingTimer = this.permissionTimers.get(sessionId);
        if (existingTimer) clearTimeout(existingTimer);

        // Debounce: only send PERMISSION_REQUEST after delay.
        // Auto-approved tools resolve quickly — their permission file gets deleted
        // before the timer fires, so the timer callback becomes a no-op.
        this.permissionTimers.set(sessionId, setTimeout(() => {
          this.permissionTimers.delete(sessionId);
          const s = this.sessions.get(sessionId);
          if (s) s.pendingPermission = permission;
          this.transitionSession(sessionId, { type: "PERMISSION_REQUEST" }, { event: "PERMISSION_REQUEST", source: "hook", signal: "permission.json", tool: permission.tool_name });
        }, this.permissionDelayMs));
      } else if (type === "stop") {
        log("Watcher", `Stop signal for session ${sessionId}`);
        const session = this.sessions.get(sessionId);
        if (session) session.isHookDriven = true;
        this.transitionSession(sessionId, { type: "STOP" }, { event: "STOP", source: "hook", signal: "stop.json" });
      } else if (type === "ended") {
        log("Watcher", `Session ended signal for ${sessionId}`);
        const session = this.sessions.get(sessionId);
        if (session) session.isHookDriven = true;
        this.transitionSession(sessionId, { type: "ENDED" }, { event: "ENDED", source: "hook", signal: "ended.json" });
      } else if (type === "task" && parsed.toolUseId) {
        const taskSignal = data as TaskSignal;
        log("Watcher", `Task signal for session ${sessionId}: ${taskSignal.agent_type || "unknown"} - ${taskSignal.description || ""}`);

        // Store in task signals map
        let sessionTasks = this.taskSignals.get(sessionId);
        if (!sessionTasks) {
          sessionTasks = new Map();
          this.taskSignals.set(sessionId, sessionTasks);
        }
        const activeTask: ActiveTask = {
          toolUseId: parsed.toolUseId,
          agentType: taskSignal.agent_type || "unknown",
          description: taskSignal.description || "task",
          startedAt: taskSignal.started_at || new Date().toISOString(),
        };
        sessionTasks.set(parsed.toolUseId, activeTask);

        // Update session and transition to tasking
        const session = this.sessions.get(sessionId);
        if (session) {
          session.activeTasks = this.getActiveTasksForSession(sessionId);
          // Fire TASK_STARTED to transition working → tasking
          // If already tasking (second task added), transition is a no-op but we still emit for data update
          if (!this.transitionSession(sessionId, { type: "TASK_STARTED" }, { event: "TASK_STARTED", source: "hook", signal: `task.${parsed.toolUseId}.json` })) {
            this.emit("session", { type: "updated", session } satisfies SessionEvent);
          }
        }
      } else if (type === "compacting") {
        const compactSignal = data as CompactingSignal;
        log("Watcher", `Compacting signal for session ${sessionId}`);
        this.compactingSignals.set(sessionId, compactSignal.started_at || new Date().toISOString());

        // Update session
        const session = this.sessions.get(sessionId);
        if (session) {
          session.activeTasks = this.getActiveTasksForSession(sessionId);
          this.emit("session", { type: "updated", session } satisfies SessionEvent);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Build the activeTasks array for a session from hook signals.
   */
  private getActiveTasksForSession(sessionId: string): ActiveTask[] {
    const tasks: ActiveTask[] = [];

    // Add task signals
    const sessionTasks = this.taskSignals.get(sessionId);
    if (sessionTasks) {
      tasks.push(...sessionTasks.values());
    }

    // Add compacting as a synthetic task
    const compactingStartedAt = this.compactingSignals.get(sessionId);
    if (compactingStartedAt) {
      tasks.push({
        toolUseId: "compacting",
        agentType: "System",
        description: "Compacting context",
        startedAt: compactingStartedAt,
      });
    }

    return tasks;
  }

  /**
   * Handle a signal file being removed.
   */
  private handleSignalRemoved(filepath: string): void {
    const parsed = this.parseSignalFilename(filepath);
    if (!parsed) return;

    const { sessionId, type } = parsed;
    log("Watcher", `Signal removed for session ${sessionId}: ${type}`);

    if (type === "permission") {
      // Cancel debounce timer
      const timer = this.permissionTimers.get(sessionId);
      if (timer) { clearTimeout(timer); this.permissionTimers.delete(sessionId); }

      // If debounce already fired (machine is in needs_approval), fall back to JSONL-derived state
      const session = this.sessions.get(sessionId);
      if (session?.machineState === "needs_approval") {
        session.pendingPermission = undefined;
        const { state } = replayEntries(session.entries, session.isWorktree);
        const nextState = state;
        if (nextState !== session.machineState) {
          appendTransition(sessionId, session.machineState, nextState, { event: "REPLAY", source: "permission-removed" });
          session.machineState = nextState;
          const previousStatus = session.status;
          const published = machineStateToPublishedStatus(nextState);
          session.status = { ...session.status, status: published.status, hasPendingToolUse: published.hasPendingToolUse };
          this.emit("session", { type: "updated", session, previousStatus } satisfies SessionEvent);

          // Auto-escalate to tasking if active tasks exist after permission resolved
          if (nextState === "working" && session.activeTasks.length > 0) {
            this.transitionSession(sessionId, { type: "TASK_STARTED" }, { event: "TASK_STARTED", source: "permission-removed", signal: "auto-escalate" });
          }
        }
      }
    } else if (type === "task" && parsed.toolUseId) {
      const sessionTasks = this.taskSignals.get(sessionId);
      if (sessionTasks) {
        sessionTasks.delete(parsed.toolUseId);
        if (sessionTasks.size === 0) {
          this.taskSignals.delete(sessionId);
        }
      }
      const session = this.sessions.get(sessionId);
      if (session) {
        session.activeTasks = this.getActiveTasksForSession(sessionId);
        // Fire TASKS_DONE when all tasks are complete → transitions tasking → working
        if (session.activeTasks.length === 0) {
          if (!this.transitionSession(sessionId, { type: "TASKS_DONE" }, { event: "TASKS_DONE", source: "hook", signal: `task.${parsed.toolUseId}.json removed` })) {
            this.emit("session", { type: "updated", session } satisfies SessionEvent);
          }
        } else {
          this.emit("session", { type: "updated", session } satisfies SessionEvent);
        }
      }
    } else if (type === "compacting") {
      this.compactingSignals.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.activeTasks = this.getActiveTasksForSession(sessionId);
        // Fire TASKS_DONE if no tasks remain after compacting ends
        if (session.activeTasks.length === 0) {
          if (!this.transitionSession(sessionId, { type: "TASKS_DONE" }, { event: "TASKS_DONE", source: "hook" })) {
            this.emit("session", { type: "updated", session } satisfies SessionEvent);
          }
        } else {
          this.emit("session", { type: "updated", session } satisfies SessionEvent);
        }
      }
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.signalWatcher) {
      this.signalWatcher.close();
      this.signalWatcher = null;
    }

    // Clear stale check interval
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clear all permission debounce timers
    for (const timer of this.permissionTimers.values()) {
      clearTimeout(timer);
    }
    this.permissionTimers.clear();
  }

  getSessions(): Map<string, SessionState> {
    return this.sessions;
  }

  /**
   * Periodically check for sessions that have gone stale, and check
   * worktree existence for "review" sessions.
   */
  private async checkStaleSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      // Stale timeout: working sessions without hook signals get STOP after 15s inactivity.
      // Note: "tasking" is deliberately excluded — subagents run independently,
      // so the primary session being silent is expected.
      if (session.machineState === "working" && !session.isHookDriven) {
        const elapsed = Date.now() - new Date(session.status.lastActivityAt).getTime();
        if (elapsed > 15_000) {
          this.transitionSession(session.sessionId, { type: "STOP" }, { event: "STOP", source: "stale-check", elapsed });
        }
      }

      // Worktree existence check: review sessions transition to idle if worktree was deleted
      if (session.machineState === "review" && session.worktreePath) {
        try {
          await access(session.worktreePath, constants.F_OK);
        } catch {
          log("Watcher", `Worktree deleted for ${session.sessionId.slice(0, 8)}, review → idle`);
          this.transitionSession(session.sessionId, { type: "WORKTREE_DELETED" }, { event: "WORKTREE_DELETED", source: "stale-check" });
        }
      }
    }
  }

  private debouncedHandleFile(filepath: string): void {
    // Clear existing timer for this file
    const existing = this.debounceTimers.get(filepath);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filepath);
      this.handleFile(filepath, "change");
    }, this.debounceMs);

    this.debounceTimers.set(filepath, timer);
  }

  /**
   * Extract active tasks and todo progress from JSONL entries.
   * Used as fallback when hook signals are not available.
   */
  private extractSessionInfo(entries: LogEntry[]): {
    activeTasks: ActiveTask[];
    todoProgress: TodoProgress | null;
  } {
    const pendingTaskIds = new Map<string, ActiveTask>();
    let latestTodos: Array<{ content: string; status: string }> | null = null;

    for (const entry of entries) {
      if (entry.type === "assistant") {
        for (const block of entry.message.content) {
          if (block.type === "tool_use" && block.name === "Task") {
            const input = block.input as Record<string, unknown>;
            pendingTaskIds.set(block.id, {
              toolUseId: block.id,
              agentType: (input.subagent_type as string) || "unknown",
              description: (input.description as string) || "task",
              startedAt: entry.timestamp,
            });
          }
        }
      } else if (entry.type === "user") {
        // Check for tool_results that resolve Task calls
        if (Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === "tool_result") {
              pendingTaskIds.delete(block.tool_use_id);
            }
          }
        }
        // Check for todos
        if (entry.todos && entry.todos.length > 0) {
          latestTodos = entry.todos;
        }
      }
    }

    return {
      activeTasks: Array.from(pendingTaskIds.values()),
      todoProgress: latestTodos
        ? {
            total: latestTodos.length,
            completed: latestTodos.filter((t) => t.status === "completed").length,
          }
        : null,
    };
  }

  private async handleFile(
    filepath: string,
    eventType: "add" | "change"
  ): Promise<void> {
    try {
      const sessionId = extractSessionId(filepath);
      const existingSession = this.sessions.get(sessionId);

      // Determine starting byte position
      const fromByte = existingSession?.bytePosition ?? 0;

      // Read new entries
      const { entries: newEntries, newPosition } = await tailJSONL(
        filepath,
        fromByte
      );

      if (newEntries.length === 0 && existingSession) {
        // No new data
        return;
      }

      // Combine with existing entries or start fresh
      const allEntries = existingSession
        ? [...existingSession.entries, ...newEntries]
        : newEntries;

      // Extract metadata (only needed for new sessions)
      let metadata: SessionMetadata | null;
      let gitInfo: GitInfo;

      if (existingSession) {
        metadata = {
          sessionId: existingSession.sessionId,
          cwd: existingSession.cwd,
          gitBranch: existingSession.gitBranch,
          originalPrompt: existingSession.originalPrompt,
          startedAt: existingSession.startedAt,
        };
        // Reuse cached git info
        gitInfo = {
          repoUrl: existingSession.gitRepoUrl,
          repoId: existingSession.gitRepoId,
          branch: existingSession.gitBranch,
          rootPath: existingSession.gitRootPath,
          isGitRepo: existingSession.gitRepoUrl !== null || existingSession.gitBranch !== null,
          isWorktree: existingSession.isWorktree,
          worktreePath: existingSession.worktreePath,
        };
      } else {
        metadata = extractMetadata(allEntries);
        if (!metadata) {
          // Not enough data yet
          return;
        }
        // Look up git info for new sessions
        gitInfo = await getGitInfoCached(metadata.cwd);
      }

      // Always refresh branch for existing sessions (branch may have changed)
      let branchChanged = false;
      if (existingSession) {
        const currentBranch = await getGitInfoCached(metadata.cwd);
        if (currentBranch.branch !== existingSession.gitBranch) {
          gitInfo = currentBranch;
          branchChanged = true;
          log("Watcher", `Branch changed for ${sessionId}: ${existingSession.gitBranch} → ${currentBranch.branch}`);
        }
      }

      // Derive status from all JSONL entries via the state machine replay
      const { state: replayedState, lastActivityAt, messageCount } = replayEntries(allEntries, gitInfo.isWorktree);
      const published = machineStateToPublishedStatus(replayedState);

      // For existing sessions, use current machine state (hook-driven transitions
      // are already applied). For new sessions, use the JSONL-replayed state.
      const machineState = existingSession ? existingSession.machineState : replayedState;
      const machinePublished = existingSession
        ? machineStateToPublishedStatus(machineState)
        : published;

      const status: StatusResult = {
        status: machinePublished.status,
        hasPendingToolUse: machinePublished.hasPendingToolUse,
        lastRole: "assistant",
        lastActivityAt,
        messageCount,
      };
      const previousStatus = existingSession?.status;

      // Extract active tasks and todo progress from entries (JSONL fallback)
      const sessionInfo = this.extractSessionInfo(allEntries);

      // If compacting signal exists and new entries arrived, compaction is done
      if (newEntries.length > 0 && this.compactingSignals.has(sessionId)) {
        this.compactingSignals.delete(sessionId);
        this.cleanupSignalFile(sessionId, "compacting");
      }

      // Process new entries through machine for existing sessions
      // (drives transitions from JSONL when hooks are not present)
      if (existingSession && !existingSession.isHookDriven) {
        let currentState = existingSession.machineState;
        for (const entry of newEntries) {
          const event = logEntryToSessionEvent(entry);
          if (event) {
            const prevState = currentState;
            currentState = transition(currentState, event, gitInfo.isWorktree);
            if (currentState !== prevState) {
              const entryType = entry.type === "system"
                ? `system/${(entry as { subtype?: string }).subtype ?? "unknown"}`
                : entry.type;
              appendTransition(sessionId, prevState, currentState, { event: event.type, source: "jsonl", entryType });
            }
          }
        }
        if (currentState !== existingSession.machineState) {
          existingSession.machineState = currentState;
          const newPublished = machineStateToPublishedStatus(currentState);
          status.status = newPublished.status;
          status.hasPendingToolUse = newPublished.hasPendingToolUse;
        }
      }

      // Build session state - prefer branch from git info over log entry
      const session: SessionState = {
        sessionId,
        filepath,
        encodedDir: extractEncodedDir(filepath),
        cwd: metadata.cwd,
        gitBranch: gitInfo.branch || metadata.gitBranch,
        originalPrompt: metadata.originalPrompt,
        startedAt: metadata.startedAt,
        status,
        entries: allEntries,
        bytePosition: newPosition,
        gitRepoUrl: gitInfo.repoUrl,
        gitRepoId: gitInfo.repoId,
        gitRootPath: gitInfo.rootPath,
        isWorktree: gitInfo.isWorktree,
        worktreePath: gitInfo.worktreePath,
        branchChanged,
        machineState: existingSession ? existingSession.machineState : replayedState,
        isHookDriven: existingSession?.isHookDriven ?? false,
        pendingPermission: existingSession?.pendingPermission,
        // Hook signals are authoritative for active tasks.
        // JSONL fallback only reports tasks when session is working/tasking — if the turn
        // ended (waiting/idle), all tasks completed even if tool_result matching
        // failed (e.g., due to context compaction rewriting entries).
        activeTasks: this.taskSignals.has(sessionId) || this.compactingSignals.has(sessionId)
          ? this.getActiveTasksForSession(sessionId)
          : (status.status === "working" || status.status === "tasking") ? sessionInfo.activeTasks : [],
        todoProgress: sessionInfo.todoProgress,
      };

      // Store session
      this.sessions.set(sessionId, session);

      // Emit event
      const isNew = !existingSession;
      const hasStatusChange = statusChanged(previousStatus, status);
      const hasNewMessages = existingSession && status.messageCount > existingSession.status.messageCount;
      const infoChanged = existingSession && (
        existingSession.activeTasks.length !== session.activeTasks.length ||
        existingSession.todoProgress?.completed !== session.todoProgress?.completed ||
        existingSession.todoProgress?.total !== session.todoProgress?.total
      );

      // Reconcile tasking state with active tasks (handles both new and existing sessions)
      if (session.machineState === "working" && session.activeTasks.length > 0) {
        this.transitionSession(sessionId, { type: "TASK_STARTED" }, { event: "TASK_STARTED", source: session.isHookDriven ? "hook" : "jsonl", signal: "reconcile" });
      } else if (session.machineState === "tasking" && session.activeTasks.length === 0) {
        this.transitionSession(sessionId, { type: "TASKS_DONE" }, { event: "TASKS_DONE", source: session.isHookDriven ? "hook" : "jsonl", signal: "reconcile" });
      }

      if (isNew) {
        appendTransition(sessionId, null, session.machineState, { event: "INIT", source: "replay", entryCount: allEntries.length });
        this.emit("session", {
          type: "created",
          session,
        } satisfies SessionEvent);
      } else if (hasStatusChange || hasNewMessages || branchChanged || infoChanged) {
        this.emit("session", {
          type: "updated",
          session,
          previousStatus,
        } satisfies SessionEvent);
      }
    } catch (error) {
      // Ignore ENOENT errors - file may have been deleted
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.emit("error", error);
    }
  }

  private handleDelete(filepath: string): void {
    const sessionId = extractSessionId(filepath);
    const session = this.sessions.get(sessionId);

    if (session) {
      this.sessions.delete(sessionId);
      this.emit("session", {
        type: "deleted",
        session,
      } satisfies SessionEvent);
    }
  }
}
