/**
 * Tiny HTTP server that serves per-session transition log files.
 * GET /logs/:sessionId → pipes ~/.claude/session-logs/<sessionId>.log
 */

import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { SESSION_LOGS_DIR } from "./transition-log.js";
import { log } from "./log.js";

const DEFAULT_PORT = 4451;

// Only allow alphanumeric, hyphens, and underscores — prevent path traversal
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

let server: Server | null = null;

export async function startLogServer(port = DEFAULT_PORT): Promise<void> {
  return new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method Not Allowed");
        return;
      }

      // Parse /logs/:sessionId
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
      log("LogServer", `Serving transition logs on http://127.0.0.1:${port}`);
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
