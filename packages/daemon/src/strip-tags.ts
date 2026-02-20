/**
 * Strip system XML tags injected by Claude Code from session text.
 * Used at the publishing boundary to clean text before it reaches the UI.
 *
 * Tags stripped: <ide_opened_file>, <ide_selection>, <task-notification>,
 * <system-reminder>, <command-name>, <command-message>
 */

const SYSTEM_TAGS = [
  "ide_opened_file",
  "ide_selection",
  "task-notification",
  "system-reminder",
  "command-name",
  "command-message",
];

// Pre-compiled regexes for performance
const closedTagPatterns = SYSTEM_TAGS.map(
  (tag) => new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"),
);
const unclosedTagPatterns = SYSTEM_TAGS.map(
  (tag) => new RegExp(`<${tag}>[\\s\\S]*$`),
);
const boilerplatePattern = /Read the output file to retrieve the result:.*$/gm;

export function stripSystemTags(text: string): string {
  if (!text) return "";

  let result = text;

  // 1. Strip closed tags first (non-greedy)
  for (const pattern of closedTagPatterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "");
  }

  // 2. Strip unclosed/truncated tags (greedy to end of string)
  for (const pattern of unclosedTagPatterns) {
    result = result.replace(pattern, "");
  }

  // 3. Strip boilerplate text that follows task-notification
  result = result.replace(boilerplatePattern, "");

  // 4. Normalize whitespace and trim
  return result.replace(/\n{3,}/g, "\n\n").trim();
}
