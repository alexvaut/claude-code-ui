/**
 * HTTP server for transition logs and hook signal ingestion.
 *
 * GET  /logs/:sessionId → pipes ~/.claude/session-logs/<sessionId>.log
 * POST /hook            → receives forwarded Claude Code hook payloads
 */

import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { SESSION_LOGS_DIR } from "./transition-log.js";
import { handleHookRequest } from "./hook-handler.js";
import { log } from "./log.js";
import type { SessionWatcher } from "./watcher.js";

const DEFAULT_PORT = 4451;

// Only allow alphanumeric, hyphens, and underscores — prevent path traversal
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

let server: Server | null = null;

export async function startLogServer(port = DEFAULT_PORT, watcher?: SessionWatcher): Promise<void> {
  return new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      // POST /hook — forward hook payloads to watcher
      if (req.method === "POST" && req.url === "/hook") {
        if (!watcher) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Watcher not ready" }));
          return;
        }
        await handleHookRequest(req, res, watcher);
        return;
      }

      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method Not Allowed");
        return;
      }

      // GET /logs/:sessionId
      const match = req.url?.match(/^\/logs\/([^/]+)$/);
      if (!match) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      const sessionId = match[1];
      if (!SESSION_ID_RE.test(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid session ID");
        return;
      }

      const filepath = join(SESSION_LOGS_DIR, `${sessionId}.log`);

      try {
        await access(filepath, constants.R_OK);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Log not found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${sessionId}.log"`,
      });
      createReadStream(filepath).pipe(res);
    });

    server.listen(port, "127.0.0.1", () => {
      log("LogServer", `Serving on http://127.0.0.1:${port} (logs + hooks)`);
      resolve();
    });

    server.on("error", reject);
  });
}

export async function stopLogServer(): Promise<void> {
  if (!server) return;
  return new Promise((resolve) => {
    server!.close(() => resolve());
    server = null;
  });
}
