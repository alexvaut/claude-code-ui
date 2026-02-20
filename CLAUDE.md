# Claude Code Session Tracker

A real-time Kanban dashboard for monitoring Claude Code sessions across projects.

## Architecture

pnpm monorepo with two packages:

- **`packages/daemon`** — Node.js backend that receives hook events from Claude Code sessions via HTTP POST, derives status via a pure state machine, reads JSONL for content only, and publishes state over `@durable-streams/server` (port 4450)
- **`packages/ui`** — React 19 + Vite 7 frontend that subscribes to the daemon stream via `@tanstack/react-db` and displays sessions in a Kanban board grouped by Git repo

## Getting Started

```sh
pnpm install        # install deps
pnpm start          # run daemon + UI dev server concurrently
pnpm setup          # install Claude hooks for session signals
```

## Key Commands

| Command | Description |
|---------|-------------|
| `pnpm start` | Run daemon + UI concurrently |
| `pnpm dev` | UI dev server only |
| `pnpm serve` | Daemon only |
| `pnpm --filter @claude-code-ui/daemon test` | Run daemon tests (vitest) |
| `pnpm lint` | Lint UI (ESLint flat config) |

## Tech Stack

| Layer | Tech |
|-------|------|
| Package manager | pnpm 10 with workspaces |
| UI framework | React 19, Vite 7, TypeScript 5.9 |
| Routing | TanStack Router (file-based, `/packages/ui/src/routes/`) |
| State / data | `@tanstack/db` + `@tanstack/react-db` via `@durable-streams` — no Redux/Zustand |
| UI components | Radix UI Themes v3 (dark theme, violet accent) |
| Daemon runtime | tsx (dev), tsc → `dist/` (prod) |
| Status engine | Pure transition function (hook-signal driven) |
| Validation | Zod v4 (schemas duplicated in both packages) |
| Testing | Vitest (daemon only, no UI tests) |

## Code Conventions

### General
- TypeScript strict mode in both packages
- Named imports; `type` keyword for type-only imports
- PascalCase for components/types, camelCase for functions/variables/hooks
- ESM throughout — daemon uses `.js` extensions on relative imports; UI does not (bundler mode)

### UI
- Use **Radix UI Themes** components exclusively — no plain HTML elements
- Style with Radix props (`size`, `color`, `variant`) and CSS custom properties (`var(--grass-3)`, `var(--radius-4)`) — avoid inline styles
- Query data with `useLiveQuery` from `@tanstack/react-db` (`.from()`, `.orderBy()`) — never filter in JS
- DB singleton via `getSessionsDb()` (async init) / `getSessionsDbSync()` (after init) in `src/data/sessionsDb.ts`
- File-based routing in `src/routes/`; route loaders initialize DB before render

### Daemon
- `SessionWatcher` (EventEmitter) in `src/watcher.ts` is the core; it drives `StreamServer` in `src/server.ts`
- State machine is a pure `transition(state, event, isWorktree)` function in `src/status-machine.ts` — 6 internal states (`working`, `tasking`, `needs_approval`, `waiting`, `review`, `idle`), 8 hook events
- Hooks forward raw JSON payloads via HTTP POST (`POST /hook` on port 4451) to the daemon — a single `forward-hook.sh` script handles all 8 hook events; the daemon's `handleHook()` method is the sole source of state transitions — JSONL only provides content (timestamps, message counts, todo progress)
- `needs_approval` is internal; published as `waiting` with `hasPendingToolUse: true` — 5 public statuses
- Permission debounce (3s) prevents false "Needs Approval" from auto-approved tools
- Worktree sessions use `review` instead of `waiting`/`idle`; persistent git cache at `~/.claude/git-info-cache.json` survives worktree deletion
- Idle timeout: daemon's `checkStaleSessions()` moves `waiting`/`needs_approval` sessions to `idle` after 1 hour of inactivity
- `SessionEnd` with `reason: "other"` is ignored from `waiting` state (VS Code sessions can resume); only `reason: "prompt_input_exit"` triggers the `ENDED` transition
- Transition logs written to `~/.claude/session-logs/`, served via HTTP on port 4451; logs include both `[hook]` event lines (every hook event) and state transition lines
- AI summaries generated with `@anthropic-ai/sdk` (Claude Sonnet) in `src/summarizer.ts`
- See `packages/daemon/HOOK-LIFECYCLE.md` for full hook event documentation

## Key Files

| File | Purpose |
|------|---------|
| `packages/daemon/src/serve.ts` | Daemon entry point |
| `packages/daemon/src/watcher.ts` | JSONL watcher + session tracking + `handleHook()` |
| `packages/daemon/src/hook-handler.ts` | HTTP handler for `POST /hook` + Zod validation |
| `packages/daemon/src/status-machine.ts` | Pure state transition function (hook-driven) |
| `packages/daemon/src/schema.ts` | Zod schemas + durable streams state schema |
| `packages/daemon/src/server.ts` | Stream server publishing |
| `packages/daemon/src/strip-tags.ts` | System XML tag stripping for clean display |
| `packages/daemon/src/git.ts` | Git info resolution with worktree support |
| `packages/daemon/src/transition-log.ts` | Per-session state transition + hook event logging |
| `packages/daemon/src/log-server.ts` | HTTP server for transition logs + hook endpoint (port 4451) |
| `packages/daemon/scripts/hooks/forward-hook.sh` | Single hook script for all 8 events (POST to daemon) |
| `packages/daemon/HOOK-LIFECYCLE.md` | Empirical hook event documentation |
| `packages/ui/src/main.tsx` | React entry point |
| `packages/ui/src/routes/__root.tsx` | Root layout (Theme, header) |
| `packages/ui/src/routes/index.tsx` | Main Kanban page |
| `packages/ui/src/data/sessionsDb.ts` | StreamDB singleton |
| `packages/ui/src/data/schema.ts` | UI-side Zod schemas (mirrors daemon) |
| `packages/ui/src/components/SessionCard.tsx` | Session card component |

## Verification



## Instructions

- `CLAUDE.md` and `README.md` must be kept up to date — every plan must include a step to update docs if the changes affect architecture, states, schemas, or key files
- Always verify UI changes with MCP Playwright — save screenshots to `screenshots/` with numbered prefix (e.g. `001-panels.png`)
- if something fails, build a failing unit tests first that is reproducing then fix it
- Always respect the architecture, for example: hooks are first classe al the way !
- DRY principle: always !