import { describe, expect, it } from "vitest";
import { stripSystemTags } from "./strip-tags.js";

describe("stripSystemTags", () => {
  // --- Real data: ide_opened_file ---

  it("strips ide_opened_file tag completely", () => {
    // From session fef76b15, entry [4] block [0]
    const input =
      "<ide_opened_file>The user opened the file c:\\src\\backstage\\catalog\\stacks\\scp\\components.yaml in the IDE. This may or may not be related to the current task.</ide_opened_file>";
    expect(stripSystemTags(input)).toBe("");
  });

  it("preserves real text after ide_opened_file tag", () => {
    // Simulates the full originalPrompt for session fef76b15
    const input =
      "<ide_opened_file>The user opened the file c:\\src\\backstage\\catalog\\stacks\\scp\\components.yaml in the IDE. This may or may not be related to the current task.</ide_opened_file>\nthe catalog has chnaged restart backstage";
    expect(stripSystemTags(input)).toBe(
      "the catalog has chnaged restart backstage",
    );
  });

  // --- Real data: task-notification + system-reminder ---

  it("strips task-notification with boilerplate and system-reminder", () => {
    // From session fef76b15, entry [19]
    const input = `<task-notification>
<task-id>b2b5ab8</task-id>
<tool-use-id>toolu_01DN66tikT5ddSjwMFVtdwuq</tool-use-id>
<output-file>C:\\Users\\alex\\AppData\\Local\\Temp\\claude\\c--src-backstage\\tasks\\b2b5ab8.output</output-file>
<status>failed</status>
<summary>Background command "Start Backstage frontend + backend in dev mode" failed with exit code 126</summary>
</task-notification>
Read the output file to retrieve the result: C:\\Users\\alex\\AppData\\Local\\Temp\\claude\\c--src-backstage\\tasks\\b2b5ab8.output

<system-reminder>
The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user

</system-reminder>`;
    expect(stripSystemTags(input)).toBe("");
  });

  // --- Real data: truncated tags (sliced at 300 chars) ---

  it("strips truncated task-notification with no closing tag", () => {
    // From session a0311c7c, displayed content truncated by .slice(0, 300)
    const input =
      '<task-notification> <task-id>bbbe88a</task-id> <tool-use-id>toolu_01SwTLKkTRKV15BZ8oPCeQ9q</tool-use-id> <output-file>C:\\Users\\alex\\AppData\\Local\\Temp\\claude\\c--src-claude-code-ui\\tasks\\bbbe88a.output</output-file> <status>completed</status> <summary>Background command "Run vitest directly via mjs e';
    expect(stripSystemTags(input)).toBe("");
  });

  it("strips truncated ide_opened_file", () => {
    const input = "<ide_opened_file>The user opened the file c:\\sr";
    expect(stripSystemTags(input)).toBe("");
  });

  it("strips truncated system-reminder", () => {
    const input =
      "some text\n<system-reminder>\nWarning: the file exists but is shorter than the provided";
    expect(stripSystemTags(input)).toBe("some text");
  });

  // --- Real data: command tags ---

  it("strips command-name and command-message", () => {
    // From session acb4cc67 (korneo)
    const input =
      "<command-message>proto-review</command-message>\n<command-name>/proto-review</command-name>";
    expect(stripSystemTags(input)).toBe("");
  });

  // --- Real data: ide_selection ---

  it("strips ide_selection tag and preserves user text", () => {
    const input =
      '<ide_selection>The user selected the lines 6 to 6 from \\temp\\readonly\\Bash tool output (t856na):\nUSER text\n\nThis may or may not be related to the current task.</ide_selection>\nrefactor this function';
    expect(stripSystemTags(input)).toBe("refactor this function");
  });

  // --- Multiple tags in one string ---

  it("strips multiple different system tags", () => {
    const input =
      "<ide_opened_file>file.ts opened</ide_opened_file>\n<system-reminder>Some reminder</system-reminder>\nfix the bug";
    expect(stripSystemTags(input)).toBe("fix the bug");
  });

  // --- System-reminder in assistant text (tool_result context) ---

  it("strips system-reminder appended to assistant/file content", () => {
    // From session 1d701378 — system-reminder appended to file reads
    const input =
      "Here's the file content:\n   128→\n   129→    def save(...):\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware\n</system-reminder>";
    expect(stripSystemTags(input)).toBe(
      "Here's the file content:\n   128→\n   129→    def save(...):",
    );
  });

  // --- Clean text passthrough ---

  it("returns clean text unchanged", () => {
    expect(stripSystemTags("Help me fix the login bug")).toBe(
      "Help me fix the login bug",
    );
  });

  it("preserves markdown in assistant text", () => {
    const input =
      "Done. Here's what was removed:\n\n**Deleted:**\n- github.ts — entire PR/CI polling module";
    expect(stripSystemTags(input)).toBe(input);
  });

  // --- Edge cases ---

  it("returns empty string for empty input", () => {
    expect(stripSystemTags("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(stripSystemTags("   \n  ")).toBe("");
  });

  it("returns empty string for null/undefined-like input", () => {
    expect(stripSystemTags("")).toBe("");
  });

  it("normalizes excessive whitespace after stripping", () => {
    const input =
      "<ide_opened_file>file.ts</ide_opened_file>\n\n\n\nfix the bug";
    expect(stripSystemTags(input)).toBe("fix the bug");
  });

  it("handles boilerplate without preceding task-notification", () => {
    const input =
      "Read the output file to retrieve the result: C:\\Users\\alex\\tasks\\abc.output\nsome real text";
    expect(stripSystemTags(input)).toBe("some real text");
  });
});
