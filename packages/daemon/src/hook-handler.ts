/**
 * HTTP handler for POST /hook — receives forwarded Claude Code hook payloads.
 * Validates the payload with Zod and dispatches to SessionWatcher.handleHook().
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { SessionWatcher } from "./watcher.js";
import { log } from "./log.js";

const HookEventNames = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionEnd",
  "PreCompact",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "TaskCompleted",
] as const;

export type HookEventName = (typeof HookEventNames)[number];

export const HookPayloadSchema = z.object({
  hook_event_name: z.enum(HookEventNames),
  session_id: z.string().min(1),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  permission_mode: z.string().optional(),
  reason: z.string().optional(),
  prompt: z.string().optional(),
  source: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
}).passthrough();

export type HookPayload = z.infer<typeof HookPayloadSchema>;

export async function handleHookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  watcher: SessionWatcher,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const result = HookPayloadSchema.safeParse(parsed);
  if (!result.success) {
    log("HookHandler", `Validation error: ${result.error.message}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: result.error.message }));
    return;
  }

  try {
    await watcher.handleHook(result.data);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    log("HookHandler", `Error processing hook: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  }
}
