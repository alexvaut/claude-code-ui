# Claude Code Session Tracker

A real-time dashboard for monitoring Claude Code sessions across multiple projects. See what Claude is working on, which sessions need approval, and track PR/CI status.

## Features

- **Real-time updates** via Durable Streams
- **Kanban board** — 6 columns: Working, Tasking, Needs Approval, Waiting, Review, Idle
- **Hook-driven status** — 8 Claude Code hooks provide instant, accurate state transitions
- **Subagent tracking** — live badges showing active Task tool invocations
- **Git worktree support** — worktree sessions grouped with parent repo, dedicated Review column
- **Active tool display** — see which tools Claude is currently executing
- **AI-powered summaries** of session activity
- **PR & CI tracking** with inline status badges
- **Todo progress** — task completion counters on session cards


## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Claude Code    │     │     Daemon      │     │       UI        │
│   Hooks         │────▶│   (Watcher)     │────▶│   (React)       │
│  session-signals│     │                 │     │                 │
│  + JSONL logs   │     │  Durable Stream │     │  TanStack DB    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Daemon (`packages/daemon`)

Watches hook signal files in `~/.claude/session-signals/` for instant state transitions:
- Reads JSONL logs for content only (timestamps, message counts, todo progress)
- Pure state machine with 6 states, worktree-aware transitions
- Generates AI summaries via Claude Sonnet API
- Detects git info with worktree support; persistent cache
- Publishes state over Durable Streams (port 4450); transition logs on port 4451

### UI (`packages/ui`)

React app using TanStack Router and Radix UI:
- Subscribes to Durable Streams for real-time updates
- Groups sessions by GitHub repository
- Shows session cards with goal, summary, branch/PR info
- Active subagent and tool badges on session cards
- Todo progress counters
- Markdown-rendered hover cards with syntax highlighting

## Session Status State Machine

The daemon uses a pure transition function driven entirely by hook signals (not JSONL parsing). See `packages/daemon/HOOK-LIFECYCLE.md` for full hook event documentation.

### States

| State | Description | UI Column |
|-------|-------------|-----------|
| `working` | Claude is actively processing | Working |
| `tasking` | Claude is delegating to subagents | Tasking |
| `needs_approval` | Tool awaiting user approval (internal; published as `waiting` + `hasPendingToolUse`) | Needs Approval |
| `waiting` | Turn ended, waiting for user | Waiting |
| `review` | Worktree session paused — code ready for review | Review |
| `idle` | Session ended | Idle |

### Events (from hooks)

| Event | Hook source |
|-------|-------------|
| `WORKING` | UserPromptSubmit |
| `STOP` | Stop |
| `ENDED` | SessionEnd |
| `PERMISSION_REQUEST` | PermissionRequest (3s debounce) |
| `TASK_STARTED` | PreToolUse/Task |
| `TASKS_DONE` | PostToolUse/Task (last task) |
| `WORKTREE_DELETED` | Stale check detects deleted worktree |

### Worktree-Aware Transitions

Non-worktree sessions: `STOP` → `waiting`, `ENDED` → `idle`
Worktree sessions: `STOP`/`ENDED` → `review` (stays visible until worktree is deleted)

### Safeguards

- Permission requests are debounced (3s) to avoid false positives from auto-approved tools
- Stale timeout (60s) catches sessions that miss a Stop hook

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Install session hooks

```bash
pnpm run setup
```

This installs 8 hooks into `~/.claude/settings.json` (UserPromptSubmit, PermissionRequest, PreToolUse, PostToolUse, PostToolUseFailure, Stop, SessionEnd, PreCompact) that write signal files for real-time status tracking.

### 3. Set API key

The daemon needs an Anthropic API key for AI summaries:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Start the app

```bash
pnpm start
```

## Development

```bash
# Start both daemon and UI
pnpm start

# Or run separately:
pnpm serve  # Start daemon on port 4450
pnpm dev    # Start UI dev server
```
