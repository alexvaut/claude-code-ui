import { useState, useRef, useEffect } from "react";
import { Box, Flex, Heading, Text, ScrollArea } from "@radix-ui/themes";
import { SessionCard } from "./SessionCard";
import type { Session, SessionStatus } from "../data/schema";

interface KanbanColumnProps {
  title: string;
  status: SessionStatus | "needs-approval";
  sessions: Session[];
  color: "green" | "iris" | "orange" | "yellow" | "cyan" | "gray";
}

const headerClassMap = {
  green: "column-header-working",
  iris: "column-header-tasking",
  orange: "column-header-approval",
  yellow: "column-header-waiting",
  cyan: "column-header-review",
  gray: "column-header-idle",
};

export function KanbanColumn({ title, sessions, color }: KanbanColumnProps) {
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;

    // Find the actual scrollable viewport inside ScrollArea
    const viewport = scrollArea.querySelector("[data-radix-scroll-area-viewport]");
    if (!viewport) return;

    const handleScroll = () => {
      setIsScrolling(true);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 150);
    };

    viewport.addEventListener("scroll", handleScroll);
    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  const colorMap = {
    green: "var(--grass-3)",
    iris: "var(--iris-3)",
    orange: "var(--orange-3)",
    yellow: "var(--amber-3)",
    cyan: "var(--cyan-3)",
    gray: "var(--slate-3)",
  };

  const countColorMap = {
    green: "grass" as const,
    iris: "iris" as const,
    orange: "orange" as const,
    yellow: "amber" as const,
    cyan: "cyan" as const,
    gray: "gray" as const,
  };

  return (
    <Box
      style={{
        flex: 1,
        minWidth: 0,
        maxWidth: 500,
        overflow: "hidden",
        backgroundColor: colorMap[color],
        borderRadius: "var(--radius-4)",
        border: `1px solid var(--${{ green: "grass", iris: "iris", orange: "orange", yellow: "amber", cyan: "cyan", gray: "slate" }[color]}-6)`,
      }}
      p="3"
    >
      <Flex direction="column" gap="3" style={{ height: "100%" }}>
        <Flex justify="between" align="center">
          <Heading
            size="3"
            weight="bold"
            className={`column-header ${headerClassMap[color]}`}
          >
            {title}
          </Heading>
          <Text size="2" weight="bold" color={countColorMap[color]}>
            {sessions.length}
          </Text>
        </Flex>

        <ScrollArea className="kanban-scroll" style={{ maxHeight: 420 }} scrollbars="vertical" ref={scrollAreaRef}>
          <Flex direction="column" gap="2" pr="2" style={{ minWidth: 0, maxWidth: "100%" }}>
            {sessions.map((session) => (
              <SessionCard key={session.sessionId} session={session} disableHover={isScrolling} />
            ))}
            {sessions.length === 0 && (
              <Text
                size="2"
                color="gray"
                align="center"
                style={{ padding: "32px 20px", opacity: 0.6 }}
              >
                No sessions
              </Text>
            )}
          </Flex>
        </ScrollArea>
      </Flex>
    </Box>
  );
}
