# Claude Code Hook Lifecycle — Empirical Findings

Verified by logging all 14 hook events via `debug-hook.sh`.

## Available Hooks (14 total)

| # | Hook Event | Matcher support | Forwarded to daemon |
|---|-----------|----------------|---------------------|
| 1 | `SessionStart` | session start type | yes |
| 2 | `UserPromptSubmit` | no | yes |
| 3 | `PreToolUse` | tool name | yes |
| 4 | `PermissionRequest` | tool name | yes |
| 5 | `PostToolUse` | tool name | yes |
| 6 | `PostToolUseFailure` | tool name | yes |
| 7 | `Notification` | notification type | yes |
| 8 | `SubagentStart` | agent type | yes |
| 9 | `SubagentStop` | agent type | yes |
| 10 | `Stop` | no | yes |
| 11 | `TeammateIdle` | no | yes |
| 12 | `TaskCompleted` | no | yes |
| 13 | `PreCompact` | compaction type | yes |
| 14 | `SessionEnd` | exit reason | yes |

---

## Verified Scenarios

### Scenario 1: Simple text prompt (no tools) ✅

**Session**: `79d8590c` | **Mode**: `default`

```
14:23:46.089  SessionStart       tool=n/a   source=startup
14:23:46.758  UserPromptSubmit   tool=n/a
14:23:49.979  Stop               tool=n/a
14:23:50.526  SessionEnd         tool=n/a   reason=other
```

**Result**: Clean lifecycle. `SessionStart` → `UserPromptSubmit` → `Stop` → `SessionEnd`.

---

### Scenario 2: Auto-approved tool (Read) ✅

**Session**: `921132ef` | **Mode**: `default`

```
14:24:11.875  SessionStart       tool=n/a   source=startup
14:24:12.687  UserPromptSubmit   tool=n/a
14:24:16.064  PreToolUse         tool=Read
14:24:16.594  PostToolUse        tool=Read
14:24:19.111  Stop               tool=n/a
14:24:19.656  SessionEnd         tool=n/a   reason=other
```

**Result**: `PreToolUse` → `PostToolUse` fires for auto-approved Read. No `PermissionRequest` (tool is auto-approved in default mode).

---

### Scenario 3: Permission-requiring tool — APPROVE ✅

**Session**: `27fbd8f0` | **Mode**: `default` (same session covers scenarios 3, 4, 5)

After ExitPlanMode approval, Write and Bash both required permission in default mode:

```
15:33:07.302  PreToolUse         tool=Write           mode=default
15:33:07.906  PermissionRequest  tool=Write           mode=default
               [user approves Write]
15:33:11.409  PostToolUse        tool=Write           mode=default   ← 3.5s later

15:33:14.811  PreToolUse         tool=Bash            mode=default
15:33:16.734  PermissionRequest  tool=Bash            mode=default
               [user approves Bash]
15:33:18.871  PostToolUse        tool=Bash            mode=default   ← 2.1s later
```

**Result**: **YES — `PostToolUse` fires after user approves a permission-requiring tool.**
The sequence is: `PreToolUse` → `PermissionRequest` → [user approves] → `PostToolUse`.

---

### Scenario 4: Permission-requiring tool — DENY ✅

**Session**: `27fbd8f0` | **Mode**: `plan`

Read triggered a permission request in plan mode. User denied it:

```
15:32:28.853  PreToolUse         tool=Read            mode=plan
15:32:29.400  PermissionRequest  tool=Read            mode=plan
               [user denies Read]
15:32:35.221  PostToolUseFailure tool=Read            mode=plan      ← 5.8s later
```

**Result**: **YES — `PostToolUseFailure` fires after user denies a tool.**
The sequence is: `PreToolUse` → `PermissionRequest` → [user denies] → `PostToolUseFailure`.

---

### Scenario 5: ExitPlanMode — approve plan ✅

**Session**: `27fbd8f0` | **Mode**: `default` → `plan` → `default`

Full lifecycle showing EnterPlanMode + ExitPlanMode:

```
15:32:20.521  UserPromptSubmit                        mode=default
15:32:24.666  PreToolUse         tool=EnterPlanMode   mode=default
15:32:25.211  PostToolUse        tool=EnterPlanMode   mode=plan      ← auto-approved, mode switches!
15:32:28.853  PreToolUse         tool=Read            mode=plan
15:32:29.400  PermissionRequest  tool=Read            mode=plan      ← plan mode triggers perms
15:32:35.221  PostToolUseFailure tool=Read            mode=plan      ← denied
15:32:41.295  PreToolUse         tool=Write           mode=plan
15:32:42.151  PostToolUse        tool=Write           mode=plan      ← auto-approved (plan file write)
15:32:44.994  PreToolUse         tool=ExitPlanMode    mode=plan
15:32:45.554  PermissionRequest  tool=ExitPlanMode    mode=plan      ← THE key event
               [user approves plan — 8.4s pause]
15:32:53.938  PostToolUse        tool=ExitPlanMode    mode=default   ← mode switches back!
15:33:07.302  PreToolUse         tool=Write           mode=default   ← continues working...
```

**Result**: **YES — `PostToolUse` fires for `ExitPlanMode` after user approves the plan.**

Key observations:
1. `EnterPlanMode` is auto-approved (no `PermissionRequest`)
2. `ExitPlanMode` triggers `PermissionRequest` (requires user plan approval)
3. `PostToolUse` fires after plan approval with mode changed to `default`
4. Session continues working normally after plan approval

---

### Scenario 6: AskUserQuestion ✅

**Session**: `e5110435` | **Mode**: `default`

```
15:56:31.250  SessionStart
15:56:37.197  UserPromptSubmit                            mode=default
15:56:42.563  PreToolUse         tool=AskUserQuestion     mode=default
15:56:43.119  PermissionRequest  tool=AskUserQuestion     mode=default
               [user answers question — 3.2s pause]
15:56:46.327  PostToolUse        tool=AskUserQuestion     mode=default
15:56:49.270  SessionEnd                                  reason=prompt_input_exit
```

**Result**: **YES — `AskUserQuestion` triggers `PermissionRequest`**, and `PostToolUse` fires after the user answers.

Key observations:
1. `AskUserQuestion` follows the same permission pattern as all other permission-requiring tools
2. No `Stop` event — user typed `/exit` immediately after answering, ending the session directly

---

### Scenario 7: Task tool (subagent) ✅

**Session**: `0737e7d7` | **Mode**: `default`

```
14:24:30.044  SessionStart       tool=n/a   source=startup
14:24:30.758  UserPromptSubmit   tool=n/a
14:24:35.535  PreToolUse         tool=Task
14:24:36.094  SubagentStart      tool=n/a   agent_type=Bash
14:24:38.458  PreToolUse         tool=Bash          (inside subagent)
14:24:39.757  PostToolUse        tool=Bash          (inside subagent)
14:24:41.822  SubagentStop       tool=n/a   agent_type=Bash
14:24:42.367  PostToolUse        tool=Task
14:24:45.341  Stop               tool=n/a
14:24:45.931  SessionEnd         tool=n/a   reason=other
```

**Result**: Full subagent lifecycle visible:
1. `PreToolUse`/Task fires before subagent spawn
2. `SubagentStart` fires with `agent_type=Bash` **and `agent_id`** (unique per subagent instance)
3. Subagent's own tools fire `PreToolUse`/`PostToolUse` on the same session
4. `SubagentStop` fires when subagent finishes (also carries `agent_id`)
5. `PostToolUse`/Task fires AFTER subagent completes
6. Both `SubagentStart`/`SubagentStop` AND `PreToolUse`/`PostToolUse` (Task) fire — they're complementary, not alternatives

**Tool attribution limitation** (verified via full payload dump, Scenario 12):
- `SubagentStart`/`SubagentStop` carry `agent_id` (e.g., `"a25c31a"`)
- `PreToolUse`/`PostToolUse` inside subagents do **NOT** carry `agent_id` — payload is identical to main-agent tool events
- This means tools inside subagents cannot be directly attributed to their parent subagent
- Temporal attribution (tools between SubagentStart/SubagentStop) works for a single foreground subagent, but is ambiguous with multiple concurrent subagents

---

### Scenario 8: End session ✅

Covered by all scenarios:
- `claude -p` sessions end with `SessionEnd` (reason=`other`)
- Interactive sessions end with `SessionEnd` (reason=`prompt_input_exit`)

---

### Scenario 9: PreCompact (/compact) ✅

**Session**: `21655e4f` | **Mode**: `default` (resumed session)

```
16:03:18.835  SessionStart                               source=resume
16:03:23.837  PreCompact                                                ← /compact triggered!
16:03:38.643  SubagentStop                               mode=default   ← active subagent killed
16:03:39.178  SessionStart                               source=compact ← new session after compact!
16:03:46.375  SessionEnd                                 reason=prompt_input_exit
```

**Result**: `PreCompact` fires when `/compact` runs. After compaction, a new `SessionStart` fires with `source=compact`. Active subagents get `SubagentStop` during compaction.

---

### Scenario 10: Background task (Notification test) ✅

**Session**: `8ba853e4` | **Mode**: `default`

```
16:05:04.147  UserPromptSubmit
16:05:08.498  PreToolUse         tool=Task
16:05:09.053  SubagentStart                              agent_type=Bash
16:05:09.083  PostToolUse        tool=Task               ← immediate! (run_in_background)
16:05:12.288  PreToolUse         tool=Bash               (inside subagent)
16:05:13.577  PostToolUse        tool=Bash
16:05:16.384  SubagentStop                               agent_type=Bash
16:05:17.740  Stop
16:05:33.853  SessionEnd                                 reason=prompt_input_exit
```

**Result**: **`Notification` did NOT fire.** Background task completed normally but no Notification hook was triggered.

Key observation: For background tasks (`run_in_background=true`), `PostToolUse/Task` fires *immediately* at spawn time (same second as SubagentStart), NOT when the subagent finishes. This is different from foreground tasks (Scenario 7) where `PostToolUse/Task` fires after `SubagentStop`.

---

### Scenario 11: Agent teams (TeammateIdle + TaskCompleted) ✅

**Session**: `20103035` | **Mode**: `default`

```
16:06:50.970  UserPromptSubmit
16:06:56.747  PreToolUse         tool=TeamCreate
16:06:57.297  PostToolUse        tool=TeamCreate
16:07:02.139  PreToolUse         tool=TaskCreate
16:07:02.683  PostToolUse        tool=TaskCreate
16:07:09.687  PreToolUse         tool=Task               (spawn teammate)
16:07:10.311  SubagentStart                              agent_type=worker-1
16:07:10.311  PostToolUse        tool=Task               ← immediate (background teammate)
               ...teammate works: TaskList, TaskUpdate, Bash...
16:07:24.334  PreToolUse         tool=TaskUpdate         (mark task completed)
16:07:24.859  TaskCompleted                              ← fires between Pre/PostToolUse!
16:07:25.401  PostToolUse        tool=TaskUpdate
               ...teammate sends messages via SendMessage...
16:07:33.321  SubagentStop                               agent_type=worker-1
16:07:33.870  TeammateIdle                               ← fires right after SubagentStop!
16:07:34.407  SubagentStart                              agent_type=worker-1  (resumed for shutdown)
               ...SendMessage, TeamDelete...
16:07:49.347  Stop
16:07:58.846  SessionEnd                                 reason=prompt_input_exit
```

**Result**: Both `TaskCompleted` and `TeammateIdle` verified.

Key observations:
1. `TaskCompleted` fires between `PreToolUse/TaskUpdate` and `PostToolUse/TaskUpdate` when a task is marked done
2. `TeammateIdle` fires immediately after `SubagentStop` when a teammate's turn ends
3. Teammate can be resumed after going idle (`SubagentStart` fires again with same agent_type)
4. Team tools (`TeamCreate`, `TaskCreate`, `TaskList`, `TaskUpdate`, `SendMessage`, `TeamDelete`) all follow normal `PreToolUse`/`PostToolUse` pattern

---

### Scenario 12: Subagent hook payload inspection ✅

**Session**: `dff2ba48` | **Mode**: `bypassPermissions`

Full JSON payloads dumped (via modified debug hook with `jq -c 'del(.tool_input)'`) to verify what fields are available on each hook event, especially inside subagents.

```
PreToolUse/Task      → {session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_use_id}
SubagentStart        → {session_id, transcript_path, cwd, hook_event_name, agent_id: "a25c31a", agent_type: "Bash"}
PreToolUse/Bash      → {session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_use_id}
PostToolUse/Bash     → {session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_use_id}
SubagentStop         → {session_id, transcript_path, cwd, hook_event_name, agent_id: "a25c31a", agent_type: "Bash"}
PostToolUse/Task     → {session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_use_id}
```

**Result**: **`PreToolUse`/`PostToolUse` inside subagents do NOT carry `agent_id` or any subagent identifier.**

Key findings:
1. `SubagentStart` has `agent_id` (short hash, e.g., `"a25c31a"`) + `agent_type` — uniquely identifies each subagent instance
2. `SubagentStop` has the same `agent_id` + `agent_type` — correctly brackets the subagent lifecycle
3. `PreToolUse`/`PostToolUse` inside subagents have the **exact same fields** as main-agent tool events — no `agent_id`, no `parent_tool_use_id`, no subagent context
4. This means tool → subagent attribution must rely on temporal ordering (unambiguous for single subagent, ambiguous for concurrent)

---

### Bonus: This session's own events (session `9dd99bcd`, mode `bypassPermissions`)

From the current Claude Code VSCode session:
- `PreToolUse`/`PostToolUse` fire for every tool (Bash, Read, Glob, TaskOutput)
- `PostToolUseFailure` fires when Bash commands fail (exit code != 0)
- No `PermissionRequest` — session runs in `bypassPermissions` mode
- No `Notification` events observed

---

## Summary of Verified Findings

### Confirmed behavior

| Hook | Verified? | Fires when |
|------|-----------|------------|
| `SessionStart` | ✅ | Session begins, before anything else |
| `UserPromptSubmit` | ✅ | User sends prompt, after SessionStart |
| `PreToolUse` | ✅ | Before every tool, including Task, Read, Bash, EnterPlanMode, ExitPlanMode |
| `PermissionRequest` | ✅ | When tool requires user approval (Bash, Write, ExitPlanMode, AskUserQuestion) |
| `PostToolUse` | ✅ | After every successful tool AND after user approves a permission |
| `PostToolUseFailure` | ✅ | After failed tool OR after user denies a permission |
| `SubagentStart` | ✅ | When subagent spawns (has `agent_id` + `agent_type`) |
| `SubagentStop` | ✅ | When subagent finishes (has `agent_id` + `agent_type`) |
| `Stop` | ✅ | When turn ends |
| `SessionEnd` | ✅ | When session terminates |
| `Notification` | ❌ | Never fired in any scenario (11 tested). Possibly unused or very specific trigger. |
| `TeammateIdle` | ✅ | When a teammate's turn ends — fires right after `SubagentStop` |
| `TaskCompleted` | ✅ | When `TaskUpdate` marks a task done — fires between Pre/PostToolUse |
| `PreCompact` | ✅ | When `/compact` runs — followed by new `SessionStart` with `source=compact` |

### All questions answered

1. **Does `PostToolUse` fire after user approves a permission-requiring tool?** ✅ **YES** (Scenario 3)
2. **Does `PostToolUseFailure` fire after user denies a tool?** ✅ **YES** (Scenario 4)
3. **Does `PostToolUse` fire for `ExitPlanMode`?** ✅ **YES** (Scenario 5 — THE key question)
4. **Does `AskUserQuestion` trigger `PermissionRequest`?** ✅ **YES** — same pattern as all permission tools (Scenario 6)
5. **Do `PreToolUse`/`PostToolUse` inside subagents carry `agent_id`?** ❌ **NO** — payload is identical to main-agent events (Scenario 12)
6. **Do `SubagentStart`/`SubagentStop` carry `agent_id`?** ✅ **YES** — unique per instance, e.g., `"a25c31a"` (Scenario 12)

### Complete hook sequences (all verified)

```
Auto-approved tool:
  PreToolUse → [tool executes] → PostToolUse

Failed tool:
  PreToolUse → [tool fails] → PostToolUseFailure

Permission-requiring tool — APPROVED:
  PreToolUse → PermissionRequest → [user approves] → PostToolUse

Permission-requiring tool — DENIED:
  PreToolUse → PermissionRequest → [user denies] → PostToolUseFailure

EnterPlanMode (auto-approved):
  PreToolUse/EnterPlanMode (mode=default) → PostToolUse/EnterPlanMode (mode=plan)

ExitPlanMode (requires approval):
  PreToolUse/ExitPlanMode (mode=plan) → PermissionRequest → [user approves] → PostToolUse/ExitPlanMode (mode=default)

AskUserQuestion (requires user response):
  PreToolUse/AskUserQuestion → PermissionRequest → [user answers] → PostToolUse/AskUserQuestion

Subagent (Task tool, foreground):
  PreToolUse/Task → SubagentStart → [subagent runs with own Pre/PostToolUse] → SubagentStop → PostToolUse/Task

Subagent (Task tool, background):
  PreToolUse/Task → SubagentStart → PostToolUse/Task (immediate!) → ... → SubagentStop (later)

Compaction (/compact):
  PreCompact → SubagentStop (kills active subagents) → SessionStart (source=compact)

Agent teams:
  TeamCreate → TaskCreate → Task (spawn teammate) → SubagentStart/worker
  ... teammate works: TaskUpdate → TaskCompleted ...
  SubagentStop/worker → TeammateIdle → SubagentStart/worker (resume) → ...
```

