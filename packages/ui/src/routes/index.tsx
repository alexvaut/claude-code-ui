import { createFileRoute } from "@tanstack/react-router";
import { Flex, Text, Spinner } from "@radix-ui/themes";
import { RepoSection } from "../components/RepoSection";
import { useSessions, groupSessionsByRepo } from "../hooks/useSessions";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const { sessions, isLoading, error } = useSessions();

  if (error) {
    return (
      <Flex direction="column" align="center" gap="3" py="9">
        <Text color="red" size="3">
          Failed to connect to session daemon
        </Text>
        <Text color="gray" size="2">
          Make sure the daemon is running: pnpm serve
        </Text>
        <Text color="gray" size="1">
          {error.message}
        </Text>
      </Flex>
    );
  }

  if (isLoading) {
    return (
      <Flex direction="column" align="center" gap="3" py="9">
        <Spinner size="3" />
        <Text color="gray" size="2">
          Connecting to session daemon...
        </Text>
      </Flex>
    );
  }

  if (sessions.length === 0) {
    return (
      <Flex direction="column" align="center" gap="3" py="9">
        <Text color="gray" size="3">
          No sessions found
        </Text>
        <Text color="gray" size="2">
          Start a Claude Code session to see it here
        </Text>
      </Flex>
    );
  }

  const repoGroups = groupSessionsByRepo(sessions);

  return (
    <Flex direction="column">
      {repoGroups.map((group) => (
        <RepoSection
          key={group.repoId}
          repoId={group.repoId}
          repoUrl={group.repoUrl}
          sessions={group.sessions}
          activityScore={group.activityScore}
        />
      ))}
    </Flex>
  );
}
