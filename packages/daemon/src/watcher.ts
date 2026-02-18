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
import { deriveStatus, statusChanged } from "./status.js";
import { getGitInfoCached, type GitInfo } from "./git.js";
import type { LogEntry, SessionMetadata, StatusResult } from "./types.js";
import { log } from "./log.js";

const CLAUDE_PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;
const SIGNALS_DIR = `${process.env.HOME}/.claude/session-signals`;

export interface PendingPermission {
  session_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  pending_since: string;
}

export interface StopSignal {
  session_id: string;
  stopped_at: string;
}

export interface SessionEndSignal {
  session_id: string;
  ended_at: string;
}

export interface WorkingSignal {
  session_id: string;
  working_since: string;
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
  // Set when branch changed since last update
  branchChanged?: boolean;
  // Pending permission from PermissionRequest hook
  pendingPermission?: PendingPermission;
  // True when UserPromptSubmit hook has fired (user started turn)
  hasWorkingSignal?: boolean;
  // True when Stop hook has fired (Claude's turn definitively ended)
  hasStopSignal?: boolean;
  // True when SessionEnd hook has fired (session closed)
  hasEndedSignal?: boolean;
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
  private pendingPermissions = new Map<string, PendingPermission>();
  private workingSignals = new Map<string, WorkingSignal>();
  private stopSignals = new Map<string, StopSignal>();
  private endedSignals = new Map<string, SessionEndSignal>();
  private taskSignals = new Map<string, Map<string, ActiveTask>>(); // sessionId → toolUseId → ActiveTask
  private compactingSignals = new Map<string, string>(); // sessionId → startedAt
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private staleCheckInterval: NodeJS.Timeout | null = null;

  constructor(options: { debounceMs?: number } = {}) {
    super();
    this.debounceMs = options.debounceMs ?? 200;
  }

  /**
   * Check if a session has a pending permission request.
   */
  hasPendingPermission(sessionId: string): boolean {
    return this.pendingPermissions.has(sessionId);
  }

  /**
   * Get pending permission for a session.
   */
  getPendingPermission(sessionId: string): PendingPermission | undefined {
    return this.pendingPermissions.get(sessionId);
  }

  /**
   * Check if a session has a working signal (turn in progress).
   */
  hasWorkingSignal(sessionId: string): boolean {
    return this.workingSignals.has(sessionId);
  }

  /**
   * Check if a session has received a stop signal (turn ended).
   */
  hasStopSignal(sessionId: string): boolean {
    return this.stopSignals.has(sessionId);
  }

  /**
   * Check if a session has received an ended signal (session closed).
   */
  hasEndedSignal(sessionId: string): boolean {
    return this.endedSignals.has(sessionId);
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
        const workingSignal = data as WorkingSignal;
        log("Watcher", `Working signal for session ${sessionId}`);
        this.workingSignals.set(sessionId, workingSignal);
        // Clear stop signal since new turn is starting
        this.stopSignals.delete(sessionId);

        // Update session to working
        const session = this.sessions.get(sessionId);
        if (session) {
          const previousStatus = session.status;
          session.hasWorkingSignal = true;
          session.hasStopSignal = false;
          session.status = {
            ...session.status,
            status: "working",
            hasPendingToolUse: false,
          };
          this.emit("session", { type: "updated", session, previousStatus } satisfies SessionEvent);
        }
      } else if (type === "permission") {
        const permission = data as PendingPermission;
        log("Watcher", `Pending permission for session ${sessionId}: ${permission.tool_name}`);
        this.pendingPermissions.set(sessionId, permission);

        // Update session if it exists
        const session = this.sessions.get(sessionId);
        if (session) {
          const previousStatus = session.status;
          session.pendingPermission = permission;
          session.status = {
            ...session.status,
            status: "waiting",
            hasPendingToolUse: true,
          };
          this.emit("session", { type: "updated", session, previousStatus } satisfies SessionEvent);
        }
      } else if (type === "stop") {
        const stopSignal = data as StopSignal;
        log("Watcher", `Stop signal for session ${sessionId}`);
        this.stopSignals.set(sessionId, stopSignal);
        // Clear working and permission signals since turn ended
        this.workingSignals.delete(sessionId);
        this.pendingPermissions.delete(sessionId);

        // Update session — worktree sessions go to "review" (no interactive user), others wait
        const session = this.sessions.get(sessionId);
        if (session) {
          const previousStatus = session.status;
          session.hasWorkingSignal = false;
          session.hasStopSignal = true;
          session.pendingPermission = undefined;
          const stopStatus = session.isWorktree ? "review" : "waiting";
          session.status = {
            ...session.status,
            status: stopStatus,
            hasPendingToolUse: false,
          };
          this.emit("session", { type: "updated", session, previousStatus } satisfies SessionEvent);
        }
      } else if (type === "ended") {
        const endSignal = data as SessionEndSignal;
        log("Watcher", `Session ended signal for ${sessionId}`);
        this.endedSignals.set(sessionId, endSignal);
        // Clear all signals for this session
        this.workingSignals.delete(sessionId);
        this.pendingPermissions.delete(sessionId);
        this.stopSignals.delete(sessionId);

        // Update session — worktree sessions go to "review", others to "idle"
        const session = this.sessions.get(sessionId);
        if (session) {
          const previousStatus = session.status;
          session.hasWorkingSignal = false;
          session.hasStopSignal = false;
          session.hasEndedSignal = true;
          session.pendingPermission = undefined;
          const endedStatus = session.isWorktree ? "review" : "idle";
          session.status = {
            ...session.status,
            status: endedStatus,
            hasPendingToolUse: false,
          };
          this.emit("session", { type: "updated", session, previousStatus } satisfies SessionEvent);
        }
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

        // Update session
        const session = this.sessions.get(sessionId);
        if (session) {
          session.activeTasks = this.getActiveTasksForSession(sessionId);
          this.emit("session", { type: "updated", session } satisfies SessionEvent);
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

    if (type === "working") {
      this.workingSignals.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.hasWorkingSignal = false;
      }
    } else if (type === "permission") {
      this.pendingPermissions.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session && session.pendingPermission) {
        const previousStatus = session.status;
        session.pendingPermission = undefined;
        session.status = deriveStatus(session.entries);
        this.emit("session", { type: "updated", session, previousStatus } satisfies SessionEvent);
      }
    } else if (type === "stop") {
      this.stopSignals.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.hasStopSignal = false;
      }
    } else if (type === "ended") {
      this.endedSignals.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.hasEndedSignal = false;
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
        this.emit("session", { type: "updated", session } satisfies SessionEvent);
      }
    } else if (type === "compacting") {
      this.compactingSignals.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.activeTasks = this.getActiveTasksForSession(sessionId);
        this.emit("session", { type: "updated", session } satisfies SessionEvent);
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
  }

  /**
   * Clear a pending permission when tool completes (called when tool_result is seen).
   */
  async clearPendingPermission(sessionId: string): Promise<void> {
    if (!this.pendingPermissions.has(sessionId)) return;

    this.pendingPermissions.delete(sessionId);

    // Try to delete the file
    try {
      await unlink(join(SIGNALS_DIR, `${sessionId}.permission.json`));
    } catch {
      // File may already be deleted
    }
  }

  /**
   * Clear stop signal for a session (called when new user prompt is seen).
   */
  async clearStopSignal(sessionId: string): Promise<void> {
    if (!this.stopSignals.has(sessionId)) return;

    this.stopSignals.delete(sessionId);

    try {
      await unlink(join(SIGNALS_DIR, `${sessionId}.stop.json`));
    } catch {
      // File may already be deleted
    }
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
      // Check working sessions for stale timeout
      if (session.status.status === "working") {
        // Re-derive status which will apply STALE_TIMEOUT
        const newStatus = deriveStatus(session.entries);

        // If status changed, emit update
        if (statusChanged(session.status, newStatus)) {
          const previousStatus = session.status;
          session.status = newStatus;

          this.emit("session", {
            type: "updated",
            session,
            previousStatus,
          } satisfies SessionEvent);
        }
        continue;
      }

      // Check review sessions — transition to idle if worktree was deleted
      if (session.status.status === "review" && session.worktreePath) {
        try {
          await access(session.worktreePath, constants.F_OK);
          // Worktree still exists, keep in review
        } catch {
          // Worktree deleted — transition to idle
          const previousStatus = session.status;
          session.status = { ...session.status, status: "idle" };
          log("Watcher", `Worktree deleted for ${session.sessionId.slice(0, 8)}, review → idle`);
          this.emit("session", {
            type: "updated",
            session,
            previousStatus,
          } satisfies SessionEvent);
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

      // Check if any new entry is a tool_result - if so, clear pending permission
      const hasToolResult = newEntries.some((entry) => {
        if (entry.type === "user") {
          const content = (entry as { message: { content: unknown } }).message.content;
          if (Array.isArray(content)) {
            return content.some((block) => block.type === "tool_result");
          }
        }
        return false;
      });

      if (hasToolResult && this.pendingPermissions.has(sessionId)) {
        await this.clearPendingPermission(sessionId);
      }

      // Check if any new entry is a user prompt (new turn starting) - if so, clear stop signal
      const hasUserPrompt = newEntries.some((entry) => {
        if (entry.type === "user") {
          const content = (entry as { message: { content: unknown } }).message.content;
          // User prompt has string content, not tool_result array
          return typeof content === "string";
        }
        return false;
      });

      if (hasUserPrompt && this.stopSignals.has(sessionId)) {
        await this.clearStopSignal(sessionId);
      }

      // Derive base status from JSONL entries (for metadata like messageCount)
      let status = deriveStatus(allEntries);
      const previousStatus = existingSession?.status;

      // Extract active tasks and todo progress from entries (JSONL fallback)
      const sessionInfo = this.extractSessionInfo(allEntries);

      // If compacting signal exists and new entries arrived, compaction is done
      if (newEntries.length > 0 && this.compactingSignals.has(sessionId)) {
        this.compactingSignals.delete(sessionId);
        try {
          await unlink(join(SIGNALS_DIR, `${sessionId}.compacting.json`));
        } catch {
          // File may already be deleted
        }
      }

      // Hook signals are authoritative for status - override JSONL-derived status
      const pendingPermission = this.pendingPermissions.get(sessionId);
      const hasWorkingSig = this.workingSignals.has(sessionId);
      const hasStopSig = this.stopSignals.has(sessionId);
      const hasEndedSig = this.endedSignals.has(sessionId);

      if (hasEndedSig) {
        // Session ended — worktree sessions go to "review", others to "idle"
        const endedStatus = gitInfo.isWorktree ? "review" : "idle";
        status = { ...status, status: endedStatus, hasPendingToolUse: false };
      } else if (pendingPermission) {
        // Waiting for permission approval
        status = { ...status, status: "waiting", hasPendingToolUse: true };
      } else if (hasStopSig) {
        // Claude's turn ended — worktree sessions go to "review" (no interactive user), others wait
        const stopStatus = gitInfo.isWorktree ? "review" : "waiting";
        status = { ...status, status: stopStatus, hasPendingToolUse: false };
      } else if (hasWorkingSig) {
        // User started turn - working
        status = { ...status, status: "working", hasPendingToolUse: false };
      }
      // If no hook signals, use JSONL-derived status (fallback for sessions without hooks)

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
        pendingPermission,
        hasWorkingSignal: hasWorkingSig,
        hasStopSignal: hasStopSig,
        hasEndedSignal: hasEndedSig,
        // Hook signals are authoritative for active tasks.
        // JSONL fallback only reports tasks when session is working — if the turn
        // ended (waiting/idle), all tasks completed even if tool_result matching
        // failed (e.g., due to context compaction rewriting entries).
        activeTasks: this.taskSignals.has(sessionId) || this.compactingSignals.has(sessionId)
          ? this.getActiveTasksForSession(sessionId)
          : status.status === "working" ? sessionInfo.activeTasks : [],
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

      if (isNew) {
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
