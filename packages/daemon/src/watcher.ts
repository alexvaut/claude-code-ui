import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";
import { access, constants } from "node:fs/promises";
import {
  tailJSONL,
  extractMetadata,
  extractSessionId,
  extractEncodedDir,
} from "./parser.js";
import { statusChanged } from "./status.js";
import {
  transition,
  extractEntryMetadata,
  machineStateToPublishedStatus,
  type SessionMachineState,
  type SessionEvent as MachineEvent,
} from "./status-machine.js";
import { getGitInfoCached, type GitInfo } from "./git.js";
import type { LogEntry, SessionMetadata, StatusResult } from "./types.js";
import { log } from "./log.js";
import { appendTransition, appendHookEvent, type TransitionMeta } from "./transition-log.js";
import type { HookPayload } from "./hook-handler.js";

const CLAUDE_PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;

export interface PendingPermission {
  session_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  pending_since: string;
}

export interface ActiveTask {
  toolUseId: string;
  agentType: string;
  description: string;
  startedAt: string;
}

export interface ActiveTool {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
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
  // Set when branch changed since last update
  branchChanged?: boolean;
  // Pending permission data (set when debounce fires, cleared on exit from needs_approval)
  pendingPermission?: PendingPermission;
  // Active subagents spawned via Task tool
  activeTasks: ActiveTask[];
  // Active tools currently executing (from PreToolUse/PostToolUse hooks)
  activeTools: ActiveTool[];
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
  private sessions = new Map<string, SessionState>();
  private taskSignals = new Map<string, Map<string, ActiveTask>>(); // sessionId → toolUseId → ActiveTask
  private toolSignals = new Map<string, Map<string, ActiveTool>>(); // sessionId → toolUseId → ActiveTool
  private compactingSignals = new Map<string, string>(); // sessionId → startedAt
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private permissionTimers = new Map<string, { handle: ReturnType<typeof setTimeout>; toolUseId: string | null }>();
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
      if (timer) { clearTimeout(timer.handle); this.permissionTimers.delete(sessionId); }
    }
    if (prevState === "needs_approval" && nextState !== "needs_approval") {
      session.pendingPermission = undefined;
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
   * Handle an incoming hook event forwarded from Claude Code via HTTP POST.
   * This is the single entry point for all hook-driven state transitions.
   */
  async handleHook(payload: HookPayload): Promise<void> {
    const { hook_event_name, session_id: sessionId } = payload;
    const now = new Date().toISOString();

    switch (hook_event_name) {
      case "UserPromptSubmit": {
        log("Watcher", `Hook UserPromptSubmit for session ${sessionId}`);
        appendHookEvent(sessionId, "UserPromptSubmit", { hook: "UserPromptSubmit" });

        // If the session doesn't exist yet (JSONL watcher hasn't created it),
        // create it directly from the hook payload. Hooks are authoritative.
        if (!this.sessions.has(sessionId)) {
          const transcriptPath = (payload.transcript_path ?? "").replace(/\\/g, "/");
          const cwd = payload.cwd ?? "";
          const gitInfo = await getGitInfoCached(cwd);
          const published = machineStateToPublishedStatus("working");

          const session: SessionState = {
            sessionId,
            filepath: transcriptPath,
            encodedDir: extractEncodedDir(transcriptPath),
            cwd,
            gitBranch: gitInfo.branch,
            originalPrompt: (payload.prompt as string) ?? "",
            startedAt: now,
            status: {
              status: published.status,
              hasPendingToolUse: published.hasPendingToolUse,
              lastRole: "assistant",
              lastActivityAt: now,
              messageCount: 0,
            },
            entries: [],
            bytePosition: 0,
            gitRepoUrl: gitInfo.repoUrl,
            gitRepoId: gitInfo.repoId,
            gitRootPath: gitInfo.rootPath,
            isWorktree: gitInfo.isWorktree,
            worktreePath: gitInfo.worktreePath,
            machineState: "working",
            activeTasks: this.getActiveTasksForSession(sessionId),
            activeTools: this.getActiveToolsForSession(sessionId),
            todoProgress: null,
          };

          this.sessions.set(sessionId, session);
          appendTransition(sessionId, null, "working", { event: "WORKING", source: "hook", signal: "http:UserPromptSubmit" });
          this.emit("session", { type: "created", session } satisfies SessionEvent);
          log("Watcher", `Created session ${sessionId} from UserPromptSubmit hook`);
        } else {
          this.transitionSession(sessionId, { type: "WORKING" }, { event: "WORKING", source: "hook", signal: "http:UserPromptSubmit" });
        }
        break;
      }

      case "PermissionRequest": {
        const toolName = payload.tool_name ?? "unknown";
        log("Watcher", `Hook PermissionRequest for session ${sessionId}: ${toolName}`);
        appendHookEvent(sessionId, "PermissionRequest", { tool: toolName, hook: "PermissionRequest" });

        // Resolve tool_use_id: from payload directly, or look up from toolSignals
        let permToolUseId: string | null = payload.tool_use_id ?? null;
        if (!permToolUseId) {
          const sessionTools = this.toolSignals.get(sessionId);
          if (sessionTools) {
            for (const t of sessionTools.values()) {
              if (t.toolName === toolName) { permToolUseId = t.toolUseId; break; }
            }
          }
        }

        // Cancel any existing debounce timer
        const existingTimer = this.permissionTimers.get(sessionId);
        if (existingTimer) clearTimeout(existingTimer.handle);

        // Debounce: only send PERMISSION_REQUEST after delay.
        // Auto-approved tools fire PostToolUse quickly, which cancels the timer.
        const permission: PendingPermission = {
          session_id: sessionId,
          tool_name: toolName,
          tool_input: payload.tool_input,
          pending_since: now,
        };
        const handle = setTimeout(() => {
          this.permissionTimers.delete(sessionId);
          const s = this.sessions.get(sessionId);
          if (s) s.pendingPermission = permission;
          this.transitionSession(sessionId, { type: "PERMISSION_REQUEST" }, { event: "PERMISSION_REQUEST", source: "hook", signal: "http:PermissionRequest", tool: toolName });
        }, this.permissionDelayMs);
        this.permissionTimers.set(sessionId, { handle, toolUseId: permToolUseId });
        break;
      }

      case "PreToolUse": {
        const toolName = payload.tool_name ?? "unknown";
        const toolUseId = payload.tool_use_id ?? "";
        log("Watcher", `Hook PreToolUse for session ${sessionId}: ${toolName} (${toolUseId})`);
        appendHookEvent(sessionId, "PreToolUse", { tool: toolName, id: toolUseId, hook: "PreToolUse" });

        if (toolUseId) {
          // Track active tool
          let sessionTools = this.toolSignals.get(sessionId);
          if (!sessionTools) {
            sessionTools = new Map();
            this.toolSignals.set(sessionId, sessionTools);
          }
          sessionTools.set(toolUseId, {
            toolUseId,
            toolName,
            toolInput: payload.tool_input ?? {},
            startedAt: now,
          });

          const session = this.sessions.get(sessionId);
          if (session) {
            session.activeTools = this.getActiveToolsForSession(sessionId);
            this.emit("session", { type: "updated", session } satisfies SessionEvent);
          }

          // If this is a Task tool, also track as active task
          if (toolName === "Task") {
            let sessionTasks = this.taskSignals.get(sessionId);
            if (!sessionTasks) {
              sessionTasks = new Map();
              this.taskSignals.set(sessionId, sessionTasks);
            }
            sessionTasks.set(toolUseId, {
              toolUseId,
              agentType: (payload.tool_input?.subagent_type as string) ?? "unknown",
              description: (payload.tool_input?.description as string) ?? "task",
              startedAt: now,
            });

            if (session) {
              session.activeTasks = this.getActiveTasksForSession(sessionId);
              appendHookEvent(sessionId, "task_start", {
                agent: (payload.tool_input?.subagent_type as string) ?? "unknown",
                desc: (payload.tool_input?.description as string) ?? "",
                id: toolUseId,
                hook: "PreToolUse/Task",
              });
              // Fire TASK_STARTED to transition working → tasking
              if (!this.transitionSession(sessionId, { type: "TASK_STARTED" }, { event: "TASK_STARTED", source: "hook", signal: `http:PreToolUse/Task(${toolUseId})` })) {
                this.emit("session", { type: "updated", session } satisfies SessionEvent);
              }
            }
          }
        }
        break;
      }

      case "PostToolUse":
      case "PostToolUseFailure": {
        const toolName = payload.tool_name ?? "unknown";
        const toolUseId = payload.tool_use_id ?? "";
        log("Watcher", `Hook ${hook_event_name} for session ${sessionId}: ${toolName} (${toolUseId})`);
        appendHookEvent(sessionId, hook_event_name, { tool: toolName, id: toolUseId, hook: hook_event_name });

        // Clear permission debounce timer — only if this tool matches the pending permission
        const permTimer = this.permissionTimers.get(sessionId);
        if (permTimer) {
          if (!permTimer.toolUseId || !toolUseId || permTimer.toolUseId === toolUseId) {
            clearTimeout(permTimer.handle);
            this.permissionTimers.delete(sessionId);
          }
        }

        // If in needs_approval, transition back to working
        const session = this.sessions.get(sessionId);
        if (session?.machineState === "needs_approval") {
          this.transitionSession(sessionId, { type: "WORKING" },
            { event: "WORKING", source: "hook", signal: `http:${hook_event_name}` });
        }

        // Remove active tool
        if (toolUseId) {
          const sessionTools = this.toolSignals.get(sessionId);
          if (sessionTools) {
            const removedTool = sessionTools.get(toolUseId);
            appendHookEvent(sessionId, "tool_end", { tool: removedTool?.toolName, id: toolUseId, hook: hook_event_name });
            sessionTools.delete(toolUseId);
            if (sessionTools.size === 0) this.toolSignals.delete(sessionId);
          }
          if (session) {
            session.activeTools = this.getActiveToolsForSession(sessionId);
            this.emit("session", { type: "updated", session } satisfies SessionEvent);
          }

          // If this was a Task tool, also remove active task
          if (toolName === "Task") {
            const sessionTasks = this.taskSignals.get(sessionId);
            if (sessionTasks) {
              const removedTask = sessionTasks.get(toolUseId);
              appendHookEvent(sessionId, "task_end", { agent: removedTask?.agentType, id: toolUseId, hook: hook_event_name });
              sessionTasks.delete(toolUseId);
              if (sessionTasks.size === 0) this.taskSignals.delete(sessionId);
            }
            if (session) {
              session.activeTasks = this.getActiveTasksForSession(sessionId);
              if (session.activeTasks.length === 0) {
                if (!this.transitionSession(sessionId, { type: "TASKS_DONE" }, { event: "TASKS_DONE", source: "hook", signal: `http:${hook_event_name}/Task(${toolUseId})` })) {
                  this.emit("session", { type: "updated", session } satisfies SessionEvent);
                }
              } else {
                this.emit("session", { type: "updated", session } satisfies SessionEvent);
              }
            }
          }
        }
        break;
      }

      case "Stop": {
        log("Watcher", `Hook Stop for session ${sessionId}`);
        appendHookEvent(sessionId, "Stop", { hook: "Stop" });

        // Clear permission debounce timer
        const stopPermTimer = this.permissionTimers.get(sessionId);
        if (stopPermTimer) { clearTimeout(stopPermTimer.handle); this.permissionTimers.delete(sessionId); }

        // Clear compacting signal
        if (this.compactingSignals.has(sessionId)) {
          this.compactingSignals.delete(sessionId);
          appendHookEvent(sessionId, "compacting_end", { hook: "Stop" });
          const session = this.sessions.get(sessionId);
          if (session) {
            session.activeTasks = this.getActiveTasksForSession(sessionId);
          }
        }

        this.transitionSession(sessionId, { type: "STOP" }, { event: "STOP", source: "hook", signal: "http:Stop" });
        break;
      }

      case "SessionEnd": {
        log("Watcher", `Hook SessionEnd for session ${sessionId}`);
        appendHookEvent(sessionId, "SessionEnd", { reason: payload.reason, hook: "SessionEnd" });

        // Clear permission debounce timer
        const endPermTimer = this.permissionTimers.get(sessionId);
        if (endPermTimer) { clearTimeout(endPermTimer.handle); this.permissionTimers.delete(sessionId); }

        this.transitionSession(sessionId, { type: "ENDED" }, { event: "ENDED", source: "hook", signal: "http:SessionEnd" });
        break;
      }

      case "PreCompact": {
        log("Watcher", `Hook PreCompact for session ${sessionId}`);
        appendHookEvent(sessionId, "PreCompact", { hook: "PreCompact" });
        this.compactingSignals.set(sessionId, now);

        const session = this.sessions.get(sessionId);
        if (session) {
          session.activeTasks = this.getActiveTasksForSession(sessionId);
          this.emit("session", { type: "updated", session } satisfies SessionEvent);
        }
        break;
      }

      // --- Logging-only hooks (no state transitions) ---

      case "SessionStart": {
        const source = (payload.source as string) ?? "unknown";
        log("Watcher", `Hook SessionStart for session ${sessionId} (source=${source})`);
        appendHookEvent(sessionId, "SessionStart", { hook: "SessionStart", source });
        break;
      }

      case "SubagentStart": {
        const agentType = (payload.agent_type as string) ?? "unknown";
        const agentId = (payload.agent_id as string) ?? "";
        log("Watcher", `Hook SubagentStart for session ${sessionId}: ${agentType} (${agentId})`);
        appendHookEvent(sessionId, "SubagentStart", { hook: "SubagentStart", agent: agentType, id: agentId });
        break;
      }

      case "SubagentStop": {
        const agentType = (payload.agent_type as string) ?? "unknown";
        const agentId = (payload.agent_id as string) ?? "";
        log("Watcher", `Hook SubagentStop for session ${sessionId}: ${agentType} (${agentId})`);
        appendHookEvent(sessionId, "SubagentStop", { hook: "SubagentStop", agent: agentType, id: agentId });
        break;
      }

      case "TeammateIdle": {
        log("Watcher", `Hook TeammateIdle for session ${sessionId}`);
        appendHookEvent(sessionId, "TeammateIdle", { hook: "TeammateIdle" });
        break;
      }

      case "TaskCompleted": {
        log("Watcher", `Hook TaskCompleted for session ${sessionId}`);
        appendHookEvent(sessionId, "TaskCompleted", { hook: "TaskCompleted" });
        break;
      }

      case "Notification": {
        log("Watcher", `Hook Notification for session ${sessionId}`);
        appendHookEvent(sessionId, "Notification", { hook: "Notification" });
        break;
      }
    }
  }

  async start(): Promise<void> {
    // Watch JSONL files in ~/.claude/projects/ for session content
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

    // Wait for initial scan to complete
    await new Promise<void>((resolve) => {
      this.watcher!.on("ready", resolve);
    });

    // Start periodic stale check to detect sessions that have gone idle
    // This catches cases where the turn ends but no hook fires
    this.staleCheckInterval = setInterval(() => {
      this.checkStaleSessions();
    }, 10_000); // Check every 10 seconds
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
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
      clearTimeout(timer.handle);
    }
    this.permissionTimers.clear();
  }

  getSessions(): Map<string, SessionState> {
    return this.sessions;
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
   * Build the activeTools array for a session from tool signals.
   */
  private getActiveToolsForSession(sessionId: string): ActiveTool[] {
    const tools = this.toolSignals.get(sessionId);
    return tools ? Array.from(tools.values()) : [];
  }

  /**
   * Periodically check for sessions that have gone stale, and check
   * worktree existence for "review" sessions.
   */
  private async checkStaleSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      // Safety-net stale timeout: working sessions get STOP after 60s inactivity.
      // Hooks should handle this via the Stop event, but this catches edge cases
      // where hooks fail to fire. "tasking" is deliberately excluded — subagents
      // run independently, so the primary session being silent is expected.
      if (session.machineState === "working") {
        const elapsed = Date.now() - new Date(session.status.lastActivityAt).getTime();
        if (elapsed > 60_000) {
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
   * Extract todo progress from JSONL entries.
   */
  private extractTodoProgress(entries: LogEntry[]): TodoProgress | null {
    let latestTodos: Array<{ content: string; status: string }> | null = null;

    for (const entry of entries) {
      if (entry.type === "user") {
        if (entry.todos && entry.todos.length > 0) {
          latestTodos = entry.todos;
        }
      }
    }

    return latestTodos
      ? {
          total: latestTodos.length,
          completed: latestTodos.filter((t) => t.status === "completed").length,
        }
      : null;
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

      // Extract metadata from JSONL entries (content only, no state derivation)
      const { lastActivityAt, messageCount } = extractEntryMetadata(allEntries);

      // For existing sessions, preserve current machine state (driven by hooks).
      // For new sessions, default to "waiting" — hook signals will correct this.
      const machineState = existingSession ? existingSession.machineState : "waiting" as SessionMachineState;
      const machinePublished = machineStateToPublishedStatus(machineState);

      const status: StatusResult = {
        status: machinePublished.status,
        hasPendingToolUse: machinePublished.hasPendingToolUse,
        lastRole: "assistant",
        lastActivityAt,
        messageCount,
      };
      const previousStatus = existingSession?.status;

      // Extract todo progress from entries
      const todoProgress = this.extractTodoProgress(allEntries);

      // If compacting signal exists and new entries arrived, compaction is done
      if (newEntries.length > 0 && this.compactingSignals.has(sessionId)) {
        this.compactingSignals.delete(sessionId);
        appendHookEvent(sessionId, "compacting_end", { source: "jsonl-arrival" });
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
        machineState,
        pendingPermission: existingSession?.pendingPermission,
        // Hook signals are authoritative for active tasks and tools
        activeTasks: this.getActiveTasksForSession(sessionId),
        activeTools: this.getActiveToolsForSession(sessionId),
        todoProgress,
      };

      // Store session
      this.sessions.set(sessionId, session);

      // Emit event
      const isNew = !existingSession;
      const hasStatusChange = statusChanged(previousStatus, status);
      const hasNewMessages = existingSession && status.messageCount > existingSession.status.messageCount;
      const infoChanged = existingSession && (
        existingSession.activeTasks.length !== session.activeTasks.length ||
        existingSession.activeTools.length !== session.activeTools.length ||
        existingSession.todoProgress?.completed !== session.todoProgress?.completed ||
        existingSession.todoProgress?.total !== session.todoProgress?.total
      );

      // Reconcile tasking state with active tasks (handles both new and existing sessions)
      if (session.machineState === "working" && session.activeTasks.length > 0) {
        this.transitionSession(sessionId, { type: "TASK_STARTED" }, { event: "TASK_STARTED", source: "hook", signal: "reconcile" });
      } else if (session.machineState === "tasking" && session.activeTasks.length === 0) {
        this.transitionSession(sessionId, { type: "TASKS_DONE" }, { event: "TASKS_DONE", source: "hook", signal: "reconcile" });
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
