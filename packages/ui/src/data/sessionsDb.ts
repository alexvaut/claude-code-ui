import { createStreamDB, type StreamDB } from "@durable-streams/state";
import { sessionsStateSchema } from "./schema";

const STREAM_URL = "http://127.0.0.1:4450/sessions";

let dbInstance: StreamDB<typeof sessionsStateSchema> | null = null;
let dbPromise: Promise<StreamDB<typeof sessionsStateSchema>> | null = null;

/**
 * Get or create the sessions StreamDB instance.
 * Handles lazy initialization and preloading.
 */
export async function getSessionsDb(): Promise<StreamDB<typeof sessionsStateSchema>> {
  if (dbInstance) {
    return dbInstance;
  }

  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await createStreamDB({
        streamOptions: {
          url: STREAM_URL,
          contentType: "application/json",
        },
        state: sessionsStateSchema,
      });

      // Preload existing data
      await db.preload();

      dbInstance = db;
      return db;
    })();
  }

  return dbPromise;
}

/**
 * Close the sessions DB connection.
 */
export async function closeSessionsDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
    dbPromise = null;
  }
}
