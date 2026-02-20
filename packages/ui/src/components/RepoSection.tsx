import { Box, Flex, Heading, IconButton, Link, Text, Separator, Tooltip } from "@radix-ui/themes";
import { KanbanColumn } from "./KanbanColumn";
import { VSCodeIcon } from "./VSCodeIcon";
import { toVSCodeUri } from "../lib/vscodeUri";
import type { Session } from "../data/schema";

interface RepoSectionProps {
  repoId: string;
  repoUrl: string | null;
  sessions: Session[];
  activityScore: number;
}

export function RepoSection({ repoId, repoUrl, sessions, activityScore }: RepoSectionProps) {
  const working = sessions.filter((s) => s.status === "working");
  const tasking = sessions.filter((s) => s.status === "tasking");
  const needsApproval = sessions.filter(
    (s) => s.status === "waiting" && s.hasPendingToolUse
  );
  const waiting = sessions.filter(
    (s) => s.status === "waiting" && !s.hasPendingToolUse
  );
  const review = sessions.filter((s) => s.status === "review");
  const idle = sessions.filter((s) => s.status === "idle");

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
          status="tasking"
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
