import { useState, useEffect } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { getSessionsDb } from "../data/sessionsDb";
import type { Session } from "../data/schema";
import type { StreamDB } from "@durable-streams/state";
import { sessionsStateSchema } from "../data/schema";

type SessionsDB = StreamDB<typeof sessionsStateSchema>;

/**
 * Hook to get all sessions from the StreamDB.
 * Returns reactive data that updates when sessions change.
 */
export function useSessions() {
  const [db, setDb] = useState<SessionsDB | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);

  // Initialize the DB connection
  useEffect(() => {
    let mounted = true;

    getSessionsDb()
      .then((instance) => {
        if (mounted) {
          setDb(instance);
          setIsConnecting(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err);
          setIsConnecting(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Use the live query once DB is ready
  const query = useLiveQuery(
    (q) => {
      if (!db) return null;
      return q.from({ sessions: db.collections.sessions });
    },
    [db]
  );

  // Transform to array of sessions
  // The query.data is a Map where values are the session objects directly
  const sessions: Session[] = query?.data
    ? Array.from(query.data.values())
    : [];

  return {
    sessions,
    isLoading: isConnecting || (query ? query.isLoading : false),
    error,
  };
}

// Activity score weights
const STATUS_WEIGHTS: Record<Session["status"], number> = {
  working: 100,
  waiting: 50,
  idle: 1,
};

const PENDING_TOOL_BONUS = 30;

/**
 * Calculate activity score for a repo group
 */
function calculateRepoActivityScore(sessions: Session[]): number {
  const now = Date.now();

  return sessions.reduce((score, session) => {
    const ageMs = now - new Date(session.lastActivityAt).getTime();
    const ageMinutes = ageMs / (1000 * 60);

    let sessionScore = STATUS_WEIGHTS[session.status];
    if (session.hasPendingToolUse) {
      sessionScore += PENDING_TOOL_BONUS;
    }

    const decayFactor = Math.pow(0.5, ageMinutes / 30);
    return score + sessionScore * decayFactor;
  }, 0);
}

export interface RepoGroup {
  repoId: string;
  repoUrl: string | null;
  sessions: Session[];
  activityScore: number;
}

/**
 * Group sessions by repo, sorted by activity score
 */
export function groupSessionsByRepo(sessions: Session[]): RepoGroup[] {
  const groups = new Map<string, Session[]>();

  for (const session of sessions) {
    const key = session.gitRepoId ?? "Other";
    const existing = groups.get(key) ?? [];
    existing.push(session);
    groups.set(key, existing);
  }

  const groupsWithScores = Array.from(groups.entries()).map(([key, sessions]) => ({
    repoId: key,
    repoUrl: key === "Other" ? null : `https://github.com/${key}`,
    sessions,
    activityScore: calculateRepoActivityScore(sessions),
  }));

  groupsWithScores.sort((a, b) => b.activityScore - a.activityScore);

  return groupsWithScores;
}
