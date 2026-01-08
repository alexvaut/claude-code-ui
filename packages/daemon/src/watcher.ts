import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";
import {
  tailJSONL,
  extractMetadata,
  extractSessionId,
  extractEncodedDir,
} from "./parser.js";
import { deriveStatus, statusChanged } from "./status.js";
import { getGitInfoCached, type GitInfo } from "./git.js";
import type { LogEntry, SessionMetadata, StatusResult } from "./types.js";

const CLAUDE_PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;

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
  // GitHub repo info
  gitRepoUrl: string | null;   // https://github.com/owner/repo
  gitRepoId: string | null;    // owner/repo (for grouping)
}

export interface SessionEvent {
  type: "created" | "updated" | "deleted";
  session: SessionState;
  previousStatus?: StatusResult;
}

export class SessionWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private sessions = new Map<string, SessionState>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;

  constructor(options: { debounceMs?: number } = {}) {
    super();
    this.debounceMs = options.debounceMs ?? 200;
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
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  getSessions(): Map<string, SessionState> {
    return this.sessions;
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
          isGitRepo: existingSession.gitRepoUrl !== null || existingSession.gitBranch !== null,
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

      // Derive status from all entries
      const status = deriveStatus(allEntries);
      const previousStatus = existingSession?.status ?? null;

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
      };

      // Store session
      this.sessions.set(sessionId, session);

      // Emit event
      const isNew = !existingSession;
      const hasStatusChange = statusChanged(previousStatus, status);
      const hasNewMessages = existingSession && status.messageCount > existingSession.status.messageCount;

      if (isNew) {
        this.emit("session", {
          type: "created",
          session,
        } satisfies SessionEvent);
      } else if (hasStatusChange || hasNewMessages) {
        this.emit("session", {
          type: "updated",
          session,
          previousStatus,
        } satisfies SessionEvent);
      }
    } catch (error) {
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
