import { Box, Flex, Heading, IconButton, Link, Text, Separator, Tooltip } from "@radix-ui/themes";
import { KanbanColumn } from "./KanbanColumn";
import { VSCodeIcon } from "./VSCodeIcon";
import { toVSCodeUri } from "../lib/vscodeUri";
import type { Session, SessionStatus } from "../data/schema";

const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour - match daemon setting

/**
 * Get effective status based on elapsed time since last activity.
 * Sessions inactive for 1 hour are considered idle regardless of stored status.
 */
function getEffectiveStatus(session: Session): SessionStatus {
  // Review status is daemon-controlled (worktree existence check), don't override
  if (session.status === "review") {
    return "review";
  }
  const elapsed = Date.now() - new Date(session.lastActivityAt).getTime();
  if (elapsed > IDLE_TIMEOUT_MS) {
    return "idle";
  }
  return session.status;
}

interface RepoSectionProps {
  repoId: string;
  repoUrl: string | null;
  sessions: Session[];
  activityScore: number;
}

export function RepoSection({ repoId, repoUrl, sessions, activityScore }: RepoSectionProps) {
  // Use effective status to categorize sessions (accounts for time-based idle)
  // Sessions with active tasks get pulled into "Tasking" column regardless of status
  const tasking = sessions.filter(
    (s) => s.activeTasks.length > 0 && getEffectiveStatus(s) !== "idle"
  );
  const taskingIds = new Set(tasking.map((s) => s.sessionId));
  const working = sessions.filter(
    (s) => getEffectiveStatus(s) === "working" && !taskingIds.has(s.sessionId)
  );
  const needsApproval = sessions.filter(
    (s) => getEffectiveStatus(s) === "waiting" && s.hasPendingToolUse && !taskingIds.has(s.sessionId)
  );
  const waiting = sessions.filter(
    (s) => getEffectiveStatus(s) === "waiting" && !s.hasPendingToolUse && !taskingIds.has(s.sessionId)
  );
  const review = sessions.filter(
    (s) => getEffectiveStatus(s) === "review" && !taskingIds.has(s.sessionId)
  );
  const idle = sessions.filter((s) => getEffectiveStatus(s) === "idle");

  const isHot = activityScore > 50;

  // Display the directory basename as the group name (handle both / and \ separators)
  const displayName = repoId.split(/[/\\]/).pop() || repoId;

  return (
    <Box mb="7">
      <Flex align="center" gap="3" mb="4">
        <Heading size="6" weight="bold">
          {repoUrl ? (
            <Link href={repoUrl} target="_blank" color="violet" highContrast>
              {displayName}
            </Link>
          ) : (
            displayName
          )}
        </Heading>
        <Tooltip content="Open in VS Code">
          <IconButton asChild size="1" variant="ghost" color="gray">
            <a href={toVSCodeUri(repoId)} aria-label="Open in VS Code">
              <VSCodeIcon size={14} />
            </a>
          </IconButton>
        </Tooltip>
        {isHot && (
          <Text size="2" color="orange">
            🔥
          </Text>
        )}
        <Text size="2" color="gray">
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </Text>
      </Flex>

      <Flex gap="3" style={{ minHeight: 240, overflow: "hidden" }}>
        <KanbanColumn
          title="Working"
          status="working"
          sessions={working}
          color="green"
        />
        <KanbanColumn
          title="Tasking"
          status="working"
          sessions={tasking}
          color="iris"
        />
        <KanbanColumn
          title="Needs Approval"
          status="needs-approval"
          sessions={needsApproval}
          color="orange"
        />
        <KanbanColumn
          title="Waiting"
          status="waiting"
          sessions={waiting}
          color="yellow"
        />
        <KanbanColumn
          title="Review"
          status="review"
          sessions={review}
          color="cyan"
        />
        <KanbanColumn
          title="Idle"
          status="idle"
          sessions={idle}
          color="gray"
        />
      </Flex>

      <Separator size="4" mt="6" />
    </Box>
  );
}
