import { useLiveQuery } from "@tanstack/react-db";
import { getSessionsDbSync } from "../data/sessionsDb";
import type { Session } from "../data/schema";

/**
 * Hook to get all sessions from the StreamDB.
 * Returns reactive data that updates when sessions change.
 *
 * NOTE: This must only be called after the root loader has run,
 * which initializes the db via getSessionsDb().
 */
export function useSessions() {
  const db = getSessionsDbSync();

  const query = useLiveQuery(
    (q) =>
      q
        .from({ sessions: db.collections.sessions })
        .orderBy(({ sessions }) => sessions.lastActivityAt, "desc"),
    [db]
  );

  // Transform to array of sessions
  // The query.data is a Map where values are the session objects directly
  const sessions: Session[] = query?.data
    ? Array.from(query.data.values())
    : [];

  return {
    sessions,
    isLoading: query?.isLoading ?? false,
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
  /** Grouping key: git root path or cwd */
  repoId: string;
  /** GitHub URL if available, for linking */
  repoUrl: string | null;
  sessions: Session[];
  activityScore: number;
}

/**
 * Group sessions by git root path (or cwd for non-git), sorted by activity score
 */
export function groupSessionsByRepo(sessions: Session[]): RepoGroup[] {
  const groups = new Map<string, Session[]>();

  for (const session of sessions) {
    const key = session.gitRootPath ?? session.cwd;
    const existing = groups.get(key) ?? [];
    existing.push(session);
    groups.set(key, existing);
  }

  const groupsWithScores = Array.from(groups.entries()).map(([key, sessions]) => {
    // Use the first session's gitRepoUrl for the group link (all sessions in the group share the same repo)
    const repoUrl = sessions.find((s) => s.gitRepoUrl)?.gitRepoUrl ?? null;
    return {
      repoId: key,
      repoUrl,
      sessions,
      activityScore: calculateRepoActivityScore(sessions),
    };
  });

  groupsWithScores.sort((a, b) => b.activityScore - a.activityScore);

  return groupsWithScores;
}
