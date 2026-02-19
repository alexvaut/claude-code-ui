import { Card, Flex, Text, Code, Box, HoverCard, Badge, Heading, IconButton, Link, Separator, Blockquote, Tooltip } from "@radix-ui/themes";
import { VSCodeIcon, VSCODE_BLUE } from "./VSCodeIcon";
import { toVSCodeUri } from "../lib/vscodeUri";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

// Customize oneDark to improve comment contrast
const codeTheme = {
  ...oneDark,
  'comment': { ...oneDark['comment'], color: '#8b949e' },
  'prolog': { ...oneDark['prolog'], color: '#8b949e' },
  'doctype': { ...oneDark['doctype'], color: '#8b949e' },
  'cdata': { ...oneDark['cdata'], color: '#8b949e' },
};
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
  Glob: "📁",
  Task: "🤖",
  MultiEdit: "✏️",
};

function DownloadIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function getCardClass(session: Session): string {
  const classes = ["session-card"];
  if (session.status === "working" || session.status === "tasking") {
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
  // Show path from ~ (e.g., ~/programs/project) — handles both Unix and Windows paths
  const dirPath = session.cwd.replace(/^(?:[A-Za-z]:[\\/])?Users[\\/][^\\/]+/, "~");

  return (
    <HoverCard.Root openDelay={750} open={disableHover ? false : undefined}>
      <HoverCard.Trigger>
        <Card size="2" className={getCardClass(session)}>
          <Flex direction="column" gap="4" style={{ minWidth: 0 }}>
            {/* Header: directory and time */}
            <Flex justify="between" align="center" style={{ minWidth: 0 }}>
              <Box style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
                <Text size="1" color="gray" style={{ fontFamily: "var(--code-font-family)" }}>
                  {dirPath}
                </Text>
              </Box>
              <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                {formatTimeAgo(session.lastActivityAt)}
              </Text>
            </Flex>

            {/* Main content: goal as primary text */}
            <Heading size="3" weight="medium" highContrast style={{ overflowWrap: "anywhere", minWidth: 0 }}>
              {session.goal || session.originalPrompt.slice(0, 50)}
            </Heading>

            {/* Active agents */}
            {session.activeTasks.length > 0 && (
              <Flex direction="column" gap="1">
                {session.activeTasks.map((task) => (
                  <Flex key={task.toolUseId} align="center" gap="2">
                    <Badge color="iris" variant="soft" size="1">
                      {task.agentType}
                    </Badge>
                    <Text size="1" color="gray">{task.description}</Text>
                  </Flex>
                ))}
              </Flex>
            )}

            {/* Active tools (when working, not pending approval) */}
            {session.activeTools.length > 0 && !showPendingTool && (
              <Flex direction="column" gap="1">
                {session.activeTools.slice(0, 3).map((tool) => (
                  <Flex key={tool.toolUseId} align="center" gap="2">
                    <Text size="1" color="gray">
                      {toolIcons[tool.toolName] || "🔧"}
                    </Text>
                    <Code size="1" variant="soft" color="grass">
                      {tool.toolName}: {formatTarget(tool.target)}
                    </Code>
                  </Flex>
                ))}
                {session.activeTools.length > 3 && (
                  <Text size="1" color="gray">+{session.activeTools.length - 3} more</Text>
                )}
              </Flex>
            )}

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
              <Text size="1" color="gray" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
                {session.summary}
              </Text>
            )}

            {/* Footer: branch/PR info, message count, and VS Code link */}
            <Flex align="center" gap="2" style={{ minWidth: 0 }}>
              <Flex align="center" gap="2" style={{ minWidth: 0, overflow: "hidden", flex: 1 }}>
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
                  <Code size="1" variant="soft" color="gray" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                    {session.gitBranch}
                  </Code>
                ) : null}
              </Flex>
              <Flex align="center" gap="2" style={{ flexShrink: 0, marginLeft: "auto" }}>
                <Text size="1" color="gray">
                  {session.messageCount} msgs
                </Text>
                {session.todoProgress && (
                  <Text size="1" color="gray">
                    {session.todoProgress.completed}/{session.todoProgress.total} tasks
                  </Text>
                )}
                <Tooltip content="Download transition log">
                  <IconButton
                    asChild
                    size="1"
                    variant="ghost"
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  >
                    <a
                      href={`/logs/${session.sessionId}`}
                      download={`${session.sessionId}.log`}
                      aria-label="Download transition log"
                    >
                      <DownloadIcon size={16} />
                    </a>
                  </IconButton>
                </Tooltip>
                {session.isWorktree && session.gitRootPath ? (
                  <Flex align="center" gap="1">
                    <Tooltip content={`Open repo: ${session.gitRootPath}`}>
                      <IconButton
                        asChild
                        size="1"
                        variant="ghost"
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      >
                        <a href={toVSCodeUri(session.gitRootPath)} aria-label="Open repo in VS Code">
                          <VSCodeIcon size={18} color={VSCODE_BLUE} />
                        </a>
                      </IconButton>
                    </Tooltip>
                    <Tooltip content={`Open worktree: ${session.cwd}`}>
                      <IconButton
                        asChild
                        size="1"
                        variant="ghost"
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      >
                        <a href={toVSCodeUri(session.cwd)} aria-label="Open worktree in VS Code">
                          <VSCodeIcon size={18} color="var(--cyan-11)" />
                        </a>
                      </IconButton>
                    </Tooltip>
                  </Flex>
                ) : (
                  <Tooltip content="Open in VS Code">
                    <IconButton
                      asChild
                      size="1"
                      variant="ghost"
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    >
                      <a href={toVSCodeUri(session.cwd)} aria-label="Open in VS Code">
                        <VSCodeIcon size={18} color={VSCODE_BLUE} />
                      </a>
                    </IconButton>
                  </Tooltip>
                )}
              </Flex>
            </Flex>
          </Flex>
        </Card>
      </HoverCard.Trigger>

      <HoverCard.Content
        size="3"
        side="right"
        sideOffset={8}
        collisionPadding={20}
        style={{ width: 500, maxWidth: "calc(100vw - 40px)", maxHeight: "calc(100vh - 40px)" }}
      >
        <Flex direction="column" gap="3" style={{ height: "100%" }}>
          {/* Header: goal */}
          <Heading size="3" weight="bold" highContrast>
            {session.goal || session.originalPrompt.slice(0, 60)}
          </Heading>

          {/* Recent output */}
          <Flex
            direction="column"
            gap="1"
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
                  style={{ color: getRoleColor(output.role) }}
                  className="markdown-content"
                >
                  {output.role === "user" && (
                    <>
                      <Separator size="4" color="blue" mb="4" />
                      <Text as="p" size="1" weight="medium" mb="3">You:</Text>
                    </>
                  )}
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      p: ({ children }) => <Text as="p" size="1" mb="4">{children}</Text>,
                      code: ({ className, children }) => {
                        const match = /language-(\w+)/.exec(className || "");
                        const isBlock = Boolean(match);
                        return isBlock ? (
                          <SyntaxHighlighter
                            style={codeTheme}
                            language={match![1]}
                            PreTag="div"
                            customStyle={{ margin: 0, borderRadius: "var(--radius-2)", fontSize: "var(--font-size-1)" }}
                          >
                            {String(children).replace(/\n$/, "")}
                          </SyntaxHighlighter>
                        ) : (
                          <Code size="1">{children}</Code>
                        );
                      },
                      pre: ({ children }) => <Box mb="4">{children}</Box>,
                      ul: ({ children }) => (
                        <ul style={{ paddingLeft: "var(--space-5)", marginBottom: "var(--space-4)", listStyleType: "disc" }}>
                          {children}
                        </ul>
                      ),
                      ol: ({ children }) => (
                        <ol style={{ paddingLeft: "var(--space-5)", marginBottom: "var(--space-4)", listStyleType: "decimal" }}>
                          {children}
                        </ol>
                      ),
                      li: ({ children }) => <li style={{ marginBottom: "var(--space-1)", fontSize: "var(--font-size-1)" }}>{children}</li>,
                      h1: ({ children }) => <Heading size="3" mb="4">{children}</Heading>,
                      h2: ({ children }) => <Heading size="2" mb="4">{children}</Heading>,
                      h3: ({ children }) => <Heading size="1" mb="4">{children}</Heading>,
                      blockquote: ({ children }) => <Blockquote size="1" mb="4">{children}</Blockquote>,
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {output.content}
                  </Markdown>
                  {output.role === "user" && (
                    <Separator size="4" color="blue" my="4" />
                  )}
                </Box>
              ))
            ) : (
              <Text size="1" color="gray">
                No recent output
              </Text>
            )}
            {(session.status === "working" || session.status === "tasking") && (
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
          <Flex justify="between" align="center">
            <Flex align="center" gap="1">
              <Link
                href={toVSCodeUri(session.cwd)}
                size="1"
                color="gray"
                highContrast
                style={{ fontFamily: "var(--code-font-family)" }}
              >
                {session.cwd.replace(/^(?:[A-Za-z]:[\\/])?Users[\\/][^\\/]+[\\/]/, "~/")}
              </Link>
              {session.isWorktree && session.gitRootPath ? (
                <>
                  <Tooltip content={`Open repo: ${session.gitRootPath}`}>
                    <IconButton asChild size="1" variant="ghost" color="gray">
                      <a href={toVSCodeUri(session.gitRootPath)} aria-label="Open repo in VS Code">
                        <VSCodeIcon size={12} />
                      </a>
                    </IconButton>
                  </Tooltip>
                  <Tooltip content={`Open worktree: ${session.cwd}`}>
                    <IconButton asChild size="1" variant="ghost" color="gray">
                      <a href={toVSCodeUri(session.cwd)} aria-label="Open worktree in VS Code">
                        <VSCodeIcon size={12} color="var(--cyan-11)" />
                      </a>
                    </IconButton>
                  </Tooltip>
                </>
              ) : (
                <Tooltip content="Open in VS Code">
                  <IconButton asChild size="1" variant="ghost" color="gray">
                    <a href={toVSCodeUri(session.cwd)} aria-label="Open in VS Code">
                      <VSCodeIcon size={12} />
                    </a>
                  </IconButton>
                </Tooltip>
              )}
            </Flex>
            <Text size="1" color="gray">
              {session.sessionId.slice(0, 8)}
            </Text>
          </Flex>
        </Flex>
      </HoverCard.Content>
    </HoverCard.Root >
  );
}
