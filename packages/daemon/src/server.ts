#!/usr/bin/env node
/**
 * Durable Streams server for session state.
 */

import { DurableStreamTestServer } from "@durable-streams/server";
import { DurableStream } from "@durable-streams/client";
import { sessionsStateSchema, type Session, type RecentOutput } from "./schema.js";
import type { SessionState } from "./watcher.js";
import type { LogEntry } from "./types.js";
import { generateAISummary, generateGoal } from "./summarizer.js";
import { stripSystemTags } from "./strip-tags.js";
import { log } from "./log.js";

const DEFAULT_PORT = 4450;
const SESSIONS_STREAM_PATH = "/sessions";

export interface StreamServerOptions {
  port?: number;
}

export class StreamServer {
  private server: DurableStreamTestServer;
  private stream: DurableStream | null = null;
  private port: number;
  private streamUrl: string;

  constructor(options: StreamServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;

    // Use in-memory storage during development (no dataDir = in-memory)
    this.server = new DurableStreamTestServer({
      port: this.port,
      host: "127.0.0.1",
    });

    this.streamUrl = `http://127.0.0.1:${this.port}${SESSIONS_STREAM_PATH}`;
  }

  async start(): Promise<void> {
    await this.server.start();
    log("Server", `Durable Streams server running on http://127.0.0.1:${this.port}`);

    // Create or connect to the sessions stream
    try {
      this.stream = await DurableStream.create({
        url: this.streamUrl,
        contentType: "application/json",
      });
    } catch (error: unknown) {
      // Stream might already exist, try to connect
      if ((error as { code?: string }).code === "CONFLICT_EXISTS") {
        this.stream = await DurableStream.connect({ url: this.streamUrl });
      } else {
        throw error;
      }
    }

  }

  async stop(): Promise<void> {
    await this.server.stop();
    this.stream = null;
  }

  getStreamUrl(): string {
    return this.streamUrl;
  }

  /**
   * Convert SessionState to Session schema and publish to stream
   */
  async publishSession(sessionState: SessionState, operation: "insert" | "update" | "delete"): Promise<void> {
    if (!this.stream) {
      throw new Error("Server not started");
    }

    // Clean originalPrompt at the publishing boundary (raw data stays in watcher)
    const cleanedState = {
      ...sessionState,
      originalPrompt: stripSystemTags(sessionState.originalPrompt),
    };

    // Generate AI goal and summary using cleaned state
    const [goal, summary] = await Promise.all([
      generateGoal(cleanedState),
      generateAISummary(cleanedState),
    ]);

    const session: Session = {
      sessionId: sessionState.sessionId,
      cwd: sessionState.cwd,
      gitBranch: sessionState.gitBranch,
      gitRepoUrl: sessionState.gitRepoUrl,
      gitRepoId: sessionState.gitRepoId,
      gitRootPath: sessionState.gitRootPath,
      isWorktree: sessionState.isWorktree,
      worktreePath: sessionState.worktreePath,
      originalPrompt: cleanedState.originalPrompt,
      status: sessionState.status.status,
      lastActivityAt: sessionState.status.lastActivityAt,
      messageCount: sessionState.status.messageCount,
      hasPendingToolUse: sessionState.status.hasPendingToolUse,
      pendingTool: extractPendingTool(sessionState),
      goal,
      summary,
      recentOutput: extractRecentOutput(sessionState.entries),
      activeTasks: sessionState.activeTasks,
      activeTools: formatActiveTools(sessionState),
      todoProgress: sessionState.todoProgress,
    };

    // Create the event using the schema helpers
    let event;
    if (operation === "insert") {
      event = sessionsStateSchema.sessions.insert({ value: session });
    } else if (operation === "update") {
      event = sessionsStateSchema.sessions.update({ value: session });
    } else {
      event = sessionsStateSchema.sessions.delete({
        key: session.sessionId,
        oldValue: session,
      });
    }

    await this.stream.append(event);
  }

}

/**
 * Extract recent output from entries for live view
 * Returns the last few meaningful messages in chronological order
 */
export function extractRecentOutput(entries: LogEntry[], maxItems = 8): RecentOutput[] {
  const output: RecentOutput[] = [];

  // Get the last N entries that are messages (user or assistant)
  const messageEntries = entries
    .filter((e) => e.type === "user" || e.type === "assistant")
    .slice(-20); // Look at last 20 messages to find good content

  for (const entry of messageEntries) {
    if (entry.type === "assistant") {
      // Get first text block if any — strip system tags
      const textBlock = entry.message.content.find((b) => b.type === "text" && b.text.trim());
      if (textBlock && textBlock.type === "text") {
        const cleaned = stripSystemTags(textBlock.text);
        if (cleaned) {
          output.push({
            role: "assistant",
            content: cleaned.slice(0, 500),
          });
        }
      }

      // Get tool uses
      const toolUses = entry.message.content.filter((b) => b.type === "tool_use");
      for (const tool of toolUses.slice(0, 2)) { // Max 2 tools per message
        if (tool.type === "tool_use") {
          output.push({
            role: "tool",
            content: formatToolUse(tool.name, tool.input as Record<string, unknown>),
          });
        }
      }
    } else if (entry.type === "user") {
      const { content } = entry.message;
      if (typeof content === "string" && content.trim()) {
        // String content — strip system tags before slicing
        const cleaned = stripSystemTags(content);
        if (cleaned) {
          output.push({ role: "user", content: cleaned.slice(0, 300) });
        }
      } else if (Array.isArray(content)) {
        // Array content (multimodal) — find first meaningful text block
        for (const block of content) {
          if (block.type === "text") {
            const cleaned = stripSystemTags(block.text);
            if (cleaned) {
              output.push({ role: "user", content: cleaned.slice(0, 300) });
              break;
            }
          }
        }
      }
    }
  }

  // Return only the last maxItems
  return output.slice(-maxItems);
}

/**
 * Format tool use for display
 */
function formatToolUse(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Read":
      return `📖 Reading ${shortenPath(input.file_path as string)}`;
    case "Edit":
      return `✏️ Editing ${shortenPath(input.file_path as string)}`;
    case "Write":
      return `📝 Writing ${shortenPath(input.file_path as string)}`;
    case "Bash":
      return `▶️ Running: ${(input.command as string)?.slice(0, 60)}`;
    case "Grep":
      return `🔍 Searching for "${input.pattern}"`;
    case "Glob":
      return `📁 Finding files: ${input.pattern}`;
    case "Task":
      return `🤖 Spawning agent: ${(input.description as string) || "task"}`;
    case "EnterPlanMode":
      return "📋 Entering plan mode";
    case "ExitPlanMode":
      return "📋 Exiting plan mode";
    case "TodoWrite":
      return "📝 Updating task list";
    default:
      return `🔧 ${tool}`;
  }
}

/**
 * Shorten file path for display
 */
function shortenPath(filepath: string | undefined): string {
  if (!filepath) return "file";
  const parts = filepath.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : filepath;
}

/**
 * Format a tool target string for display.
 * Reused by extractPendingTool and formatActiveTools.
 */
function formatToolTarget(tool: string, input: Record<string, unknown>): string {
  if (tool === "Edit" || tool === "Read" || tool === "Write") {
    return shortenPath(input.file_path as string);
  } else if (tool === "Bash") {
    return ((input.command as string) ?? "").slice(0, 60);
  } else if (tool === "Grep" || tool === "Glob") {
    return (input.pattern as string) ?? "";
  } else if (tool === "Task") {
    return (input.description as string) ?? "task";
  }
  return JSON.stringify(input).slice(0, 50);
}

/**
 * Extract pending tool info from hook-provided permission data.
 */
function extractPendingTool(session: SessionState): Session["pendingTool"] {
  if (!session.status.hasPendingToolUse || !session.pendingPermission) {
    return null;
  }
  const tool = session.pendingPermission.tool_name;
  const input = (session.pendingPermission.tool_input ?? {}) as Record<string, unknown>;
  const target = formatToolTarget(tool, input);
  return { tool, target };
}

/**
 * Format activeTools for the published session.
 * Filters out Task tools (shown separately as activeTasks).
 */
function formatActiveTools(sessionState: SessionState): Session["activeTools"] {
  return (sessionState.activeTools ?? [])
    .filter(t => t.toolName !== "Task")
    .map(t => ({
      toolUseId: t.toolUseId,
      toolName: t.toolName,
      target: formatToolTarget(t.toolName, t.toolInput),
      startedAt: t.startedAt,
    }));
}

