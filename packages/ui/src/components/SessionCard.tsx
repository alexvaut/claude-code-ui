import { Card, Flex, Text, Code, Box, HoverCard, Badge, Heading } from "@radix-ui/themes";
import Markdown from "react-markdown";
import type { Session, CIStatus } from "../data/schema";

interface SessionCardProps {
  session: Session;
  disableHover?: boolean;
}

const toolIcons: Record<string, string> = {
  Edit: "✏️",
  Write: "📝",
  Bash: "▶️",
  Read: "📖",
  Grep: "🔍",
  MultiEdit: "✏️",
};

function getCardClass(session: Session): string {
  const classes = ["session-card"];
  if (session.status === "working") {
    classes.push("status-working");
  }
  if (session.status === "waiting" && session.hasPendingToolUse) {
    classes.push("status-needs-approval");
  }
  return classes.join(" ");
}

function formatTimeAgo(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatTarget(target: string): string {
  // Shorten file paths
  if (target.includes("/")) {
    const parts = target.split("/");
    return parts[parts.length - 1];
  }
  // Truncate long commands
  if (target.length > 30) {
    return target.slice(0, 27) + "…";
  }
  return target;
}

function getRoleColor(role: "user" | "assistant" | "tool"): string {
  switch (role) {
    case "user":
      return "var(--blue-11)";
    case "assistant":
      return "var(--gray-12)";
    case "tool":
      return "var(--violet-11)";
  }
}

function getRolePrefix(role: "user" | "assistant" | "tool"): string {
  switch (role) {
    case "user":
      return "You: ";
    case "assistant":
      return "";
    case "tool":
      return "";
  }
}

function getCIStatusIcon(status: CIStatus): string {
  switch (status) {
    case "success":
      return "✓";
    case "failure":
      return "✗";
    case "running":
    case "pending":
      return "◎";
    case "cancelled":
      return "⊘";
    default:
      return "?";
  }
}

function getCIStatusColor(status: CIStatus): "green" | "red" | "yellow" | "gray" {
  switch (status) {
    case "success":
      return "green";
    case "failure":
      return "red";
    case "running":
    case "pending":
      return "yellow";
    default:
      return "gray";
  }
}

export function SessionCard({ session, disableHover }: SessionCardProps) {
  const showPendingTool = session.hasPendingToolUse && session.pendingTool;
  // Show path from ~ (e.g., ~/programs/project)
  const dirPath = session.cwd.replace(/^\/Users\/[^/]+/, "~");

  return (
    <HoverCard.Root openDelay={750} open={disableHover ? false : undefined}>
      <HoverCard.Trigger>
        <Card size="2" className={getCardClass(session)}>
          <Flex direction="column" gap="4">
            {/* Header: directory and time */}
            <Flex justify="between" align="center">
              <Text size="1" color="gray" style={{ fontFamily: "var(--code-font-family)" }}>
                {dirPath}
              </Text>
              <Text size="1" color="gray">
                {formatTimeAgo(session.lastActivityAt)}
              </Text>
            </Flex>

            {/* Main content: goal as primary text */}
            <Heading size="3" weight="medium" highContrast>
              {session.goal || session.originalPrompt.slice(0, 50)}
            </Heading>

            {/* Secondary: current activity (pending tool or summary) */}
            {showPendingTool ? (
              <Flex align="center" gap="2">
                <Text size="1" color="gray">
                  {toolIcons[session.pendingTool!.tool]}
                </Text>
                <Code size="1" color="orange" variant="soft">
                  {session.pendingTool!.tool}: {formatTarget(session.pendingTool!.target)}
                </Code>
              </Flex>
            ) : (
              <Text size="1" color="gray">
                {session.summary}
              </Text>
            )}

            {/* Footer: branch/PR info and message count */}
            <Flex align="center" justify="between" gap="2">
              <Flex align="center" gap="2">
                {session.pr ? (
                  <a
                    href={session.pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    style={{ textDecoration: "none" }}
                  >
                    <Badge color={getCIStatusColor(session.pr.ciStatus)} variant="soft" size="1">
                      {getCIStatusIcon(session.pr.ciStatus)} #{session.pr.number}
                    </Badge>
                  </a>
                ) : session.gitBranch ? (
                  <Code size="1" variant="soft" color="gray">
                    {session.gitBranch.length > 20
                      ? session.gitBranch.slice(0, 17) + "..."
                      : session.gitBranch}
                  </Code>
                ) : null}
              </Flex>
              <Text size="1" color="gray">
                {session.messageCount} msgs
              </Text>
            </Flex>
          </Flex>
        </Card>
      </HoverCard.Trigger>

      <HoverCard.Content size="3" style={{ minWidth: "600px", minHeight: "400px" }}>
        <Flex direction="column" gap="3" style={{ height: "100%" }}>
          {/* Header: goal */}
          <Heading size="3" weight="bold" highContrast>
            {session.goal || session.originalPrompt.slice(0, 60)}
          </Heading>

          {/* Recent output */}
          <Flex
            direction="column"
            gap="3"
            p="3"
            flexGrow="1"
            style={{
              backgroundColor: "var(--gray-2)",
              borderRadius: "var(--radius-3)",
              overflow: "auto",
            }}
          >
            {session.recentOutput?.length > 0 ? (
              session.recentOutput.map((output, i) => (
                <Box
                  key={i}
                  mb={i < session.recentOutput.length - 1 ? "2" : "0"}
                  style={{ color: getRoleColor(output.role) }}
                  className="markdown-content"
                >
                  {getRolePrefix(output.role) && (
                    <Text size="1" weight="medium">{getRolePrefix(output.role)}</Text>
                  )}
                  <Markdown
                    components={{
                      // Override default elements to use Radix styling
                      p: ({ children }) => <Text as="p" size="1" mb="2">{children}</Text>,
                      code: ({ children, className }) => {
                        const isBlock = className?.includes("language-");
                        return isBlock ? (
                          <Box
                            as="pre"
                            p="2"
                            my="2"
                            style={{
                              backgroundColor: "var(--gray-3)",
                              borderRadius: "var(--radius-2)",
                              overflow: "auto",
                              fontSize: "var(--font-size-1)",
                            }}
                          >
                            <code>{children}</code>
                          </Box>
                        ) : (
                          <Code size="1">{children}</Code>
                        );
                      },
                      ul: ({ children }) => <Box as="ul" pl="4" mb="2">{children}</Box>,
                      ol: ({ children }) => <Box as="ol" pl="4" mb="2">{children}</Box>,
                      li: ({ children }) => <Text as="li" size="1">{children}</Text>,
                      h1: ({ children }) => <Heading size="3" mb="2">{children}</Heading>,
                      h2: ({ children }) => <Heading size="2" mb="2">{children}</Heading>,
                      h3: ({ children }) => <Heading size="1" mb="1">{children}</Heading>,
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-11)" }}>
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {output.content}
                  </Markdown>
                </Box>
              ))
            ) : (
              <Text size="1" color="gray">
                No recent output
              </Text>
            )}
            {session.status === "working" && (
              <Text color="grass" size="1">█</Text>
            )}
          </Flex>

          {/* PR Info if available */}
          {session.pr && (
            <Box>
              <Flex align="center" gap="2" mb="2">
                <a
                  href={session.pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "var(--font-size-1)", fontWeight: 500 }}
                >
                  PR #{session.pr.number}: {session.pr.title}
                </a>
              </Flex>
              {session.pr.ciChecks.length > 0 && (
                <Flex gap="2" wrap="wrap">
                  {session.pr.ciChecks.map((check) => (
                    <Badge
                      key={check.name}
                      color={getCIStatusColor(check.status)}
                      variant="soft"
                      size="1"
                    >
                      {getCIStatusIcon(check.status)} {check.name.slice(0, 20)}
                    </Badge>
                  ))}
                </Flex>
              )}
            </Box>
          )}

          {/* Footer */}
          <Flex justify="between">
            <Text size="1" color="gray">
              {session.cwd.replace(/^\/Users\/\w+\//, "~/")}
            </Text>
            <Text size="1" color="gray">
              {session.sessionId.slice(0, 8)}
            </Text>
          </Flex>
        </Flex>
      </HoverCard.Content>
    </HoverCard.Root >
  );
}
