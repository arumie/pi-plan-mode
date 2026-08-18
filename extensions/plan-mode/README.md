# Plan Mode Extension

Read-only exploration mode for safe code analysis, distributed as the [`@arumie/pi-plan-mode`](../../README.md) pi package.

## Installation

Install the package from a pinned Git release:

```sh
pi install git:github.com/arumie/pi-plan-mode@v1.0.1
```

Restart pi (or run `/reload`) after installation. For local development from a checkout, use `pi -e /absolute/path/to/pi-plan-mode`. Do not leave the legacy auto-discovered `~/.pi/agent/extensions/plan-mode/` directory active at the same time: it would load a second copy and duplicate `/plan` and `Ctrl+Alt+P` registrations.

## Features

- **Writes limited to plans dir**: Only markdown files under `~/.pi/plans/` (override with `PI_PLAN_DIR`) can be written/edited; all other paths are blocked
- **Bash allowlist**: Only read-only bash commands are allowed, checked structurally (quote-aware) so read-only research like `gh pr view` and `rg -ln "a|b"` works
- **Plan extraction**: Extracts numbered steps from `Plan:` sections, folding multi-line steps into one label
- **Progress tracking**: A compact widget shows progress during execution - completed steps collapse into one summary line, the current step is highlighted, and the tail is summarized as `+N more` so the list never gets truncated (see [Progress widget](#progress-widget))
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume
- **Pre-flight panel**: Before execution starts, pick the model, thinking level and step-gating mode in one screen
- **Model/thinking auto-restore**: The model borrowed for execution is handed back when the plan finishes
- **Step gating**: Optionally stop after each completed step and confirm before continuing (default: keep going)
- **`repo`/`title`/`date` frontmatter**: Plan files get a `---` fenced frontmatter block backfilled automatically on save
- **On-disk todo tracking**: The `todos` frontmatter is written as soon as the plan file is saved (not only when execution starts) and mirrored as steps complete, so a plan can be resumed from `/plan list` in a future session

## Commands

- `/plan` - Toggle plan mode
- `/plan step [on|off|status]` - Control whether execution stops after each completed step. `on` stops, `off` keeps going (the default), bare `/plan step` toggles, `status` just reports. Works mid-execution and is persisted to the active plan file.
- `/plan list [filter]` - Pick a previously saved plan (from `~/.pi/plans/`, or `$PI_PLAN_DIR`). Each entry shows its filename with `title · repo · date` faded underneath (falling back to the first markdown heading / filename-derived values for plans saved before this feature existed). Optional `filter` narrows the list by filename, title, repo, or date substring.
  - If the selected plan has unfinished `todos` in its frontmatter, you're prompted to **resume execution** (opens the same pre-flight panel, pre-seeded with the model/thinking/step mode that plan last ran with, then restores full tool access and continues from the first incomplete step) or **load as reference only** (injects the file's contents as context, same as before).
  - Otherwise, the plan is loaded as reference only, unchanged from before.
- `/todos` - Show the **full** plan todo list (every step with `✓`/`○`, plus an `X/Y complete` header, the step-gating mode and the active model). The widget is a compact view; this is the authoritative one.
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Choose "Execute the plan" when prompted, then confirm (or change) the model, thinking level and step-gating mode in the pre-flight panel
5. During execution, the agent marks steps complete with `[DONE:n]` tags
6. Progress widget shows completion status and the current step-gating mode (compact - see [Progress widget](#progress-widget); `/todos` prints the full list)

At step 4, if the plan was never saved to disk during planning, the extension auto-saves it to `~/.pi/plans/` (or `$PI_PLAN_DIR`) so execution always has a durable, resumable home from the start.

### Execution pre-flight panel

Picking "Execute the plan" opens one screen describing *how* the plan will run:

```
┌─ Execute plan: Add frontmatter to plan files ─┐
│ Model             amazon-bedrock/…opus-5      │
│ Thinking          high                        │
│ After each step   keep going                  │
│ ▶ Start execution                             │
│ Cancel                                        │
└───────────────────────────────────────────────┘
```

- **Model** opens a picker that mirrors `/model`: it opens on the session-scoped models (from the `--models` flag / `enabledModels` setting) in their configured order, unfiltered, and offers a `Scope: scoped → switch to all` row to reach the full available catalogue (standing in for `/model`'s Tab toggle, which the list component cannot receive). Rows show the model id with provider/name underneath and a `✓` on the active model. A model whose provider has no usable credentials is not filtered out here (same as `/model`); the problem is reported when the switch is attempted and execution continues on the current model.
- **Thinking** offers pi's canonical level list (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) for every model. Plan mode deliberately does **no** capability filtering of its own: `pi.setThinkingLevel()` already clamps to what the model supports (a non-reasoning model resolves to `off`), so deriving a per-model subset from `reasoning`/`thinkingLevelMap` here could only drift from pi's rule. `xhigh` and `max` are therefore labelled `may be clamped down by the model` rather than hidden, and the level is never silently downgraded when you switch model. A level pinned by a scoped-model pattern (e.g. `anthropic/*:high`) is preferred for a freshly picked model and labelled. The **effective** level is read back from `pi.getThinkingLevel()` after applying, and that value - not the requested one - is what the start notice reports and what lands in the `thinking` frontmatter field; if the model clamped your choice, the notice says so (`thinking: high (requested xhigh, clamped by the model)`).
- **After each step** toggles step gating (see below).
- **Start execution** begins; **Cancel** / `Esc` leaves you in plan mode with the plan file already saved, so nothing is lost. `Esc` inside a sub-picker keeps the previous value.
- Headless runs (print/RPC, `ctx.hasUI === false`) skip the panel entirely and execute with the session's current model and the default "keep going" mode.

The choices are applied with `pi.setModel()` / `pi.setThinkingLevel()`. Those also rewrite pi's **global defaults**, so the extension snapshots the previous model/level first and restores it when the plan completes (or when you re-enter plan mode mid-execution), reporting `Restored <provider>/<id> (thinking: <level>)` with the level read back from `pi.getThinkingLevel()`, so the notice states what is actually in effect. A no-op selection takes no snapshot and triggers no restore.

### Step gating (stop or keep going after each step)

`After each step` has two modes, persisted per plan and changeable at any time with `/plan step`:

- **keep going** (default): the agent is told to continue straight into the next remaining step without waiting for confirmation, until the plan is finished - the previous behaviour.
- **stop after each step**: the agent is told that after tagging a completed step it must "STOP: end your turn there. Do not start the next step, do not call further tools". When the run ends, the extension asks:

  ```
  Step 2/7 complete - continue?
    Continue to next step
    Continue without stopping again
    Stay paused
  ```

  `Continue to next step` sends the next step as a follow-up and triggers a turn. `Continue without stopping again` switches the plan to "keep going" (persisted) and continues. `Stay paused` (or `Esc`) hands control back to you.

Gating is instruction-based - the agent is asked to stop, and the prompt above is the checkpoint. The prompt only appears when a step was actually completed during that run, so a run that stopped to ask a clarifying question is never hijacked by it. While gating is on, the footer shows `📋 2/7 ⏯` and the progress widget appends `after each step: stop after each step`.

### Progress widget

During execution the widget renders a **compact** view of the todo list rather than one line per step:

```
☑ 10 done · 4 left
▶ 11. Manually smoke-test in a real session: start /plan, execute a...
☐ 12. Update the Plan Mode documentation: describe the...
after each step: keep going
```

- `☑ N done · M left` - all completed steps, collapsed into one summary line (`N done · all steps complete` once the plan is finished, when it is the only row).
- `▶ n. ...` - the step being worked on (the first step that is not completed yet), in the accent color.
- `☐ n. ...` - the next pending steps, numbered to match `/todos`, the `📋 completed/total` footer and the `[DONE:n]` tags.
- `  +N more` - how many remaining steps did not fit.

The reason for collapsing: pi's TUI hard-caps string-array widgets at `InteractiveMode.MAX_WIDGET_LINES` (10 lines) and replaces the overflow with `... (widget truncated)`. Since completed steps render first, a plan with more than ~9 steps used to lose exactly the part that mattered - everything still to do. `buildTodoWidgetRows` in `utils.ts` therefore emits at most `MAX_TODO_WIDGET_ROWS` (8) rows, leaving room for the trailing `after each step: ...` line plus one spare, so the truncation marker can never appear. A unit test sweeps plan sizes 1..30 as a regression guard.

For the full, uncollapsed list at any time, use `/todos`.

## How It Works

### Plan Mode (Read-Only)
- `write`/`edit` allowed **only** for `*.md` files under `~/.pi/plans/` (or `$PI_PLAN_DIR`)
- Any other write/edit path is blocked with an explanatory reason
- Other active tools remain available
- Bash commands filtered through allowlist
- Agent creates a plan without making changes
- When the agent saves a plan file with `write`, missing `repo`/`title`/`date` frontmatter fields are backfilled automatically (without touching anything the agent already supplied): `repo` from `git remote get-url origin` (falling back to the cwd folder name), `title` from the first markdown heading or the filename, `date` from the filename or today
- The `todos` frontmatter is derived from the numbered list under the file's `Plan:` header and stamped in immediately — on every `write`/`edit` of a plan file, and again when the planning turn ends — regardless of whether you then execute, keep refining, or stay in plan mode. Re-stamping preserves the `completed` state of steps whose text is unchanged
- When a plan file was saved during the round, its body is the source of truth for the todo list; only if it has no recognizable `Plan:` steps does the extension fall back to extracting them from the chat message

### Frontmatter convention

Plan files may start with a `---` fenced frontmatter block:

```
---
repo: my-repo
title: Add frontmatter to plan files
date: 2026-07-30
model: "amazon-bedrock/eu.anthropic.claude-opus-5"
thinking: high
stepMode: stop
todos: [{"step":1,"text":"...","completed":false}]
---
```

- `repo`/`title`/`date` may be authored by the agent (or left out and backfilled, see above).
- `todos` is **exclusively extension-managed** — a single-line JSON array, derived from the plan body's numbered `Plan:` steps and kept in sync with execution progress. The agent never authors or edits this field directly; it keeps using the `[DONE:n]` chat-tag protocol as always, and the extension translates that into on-disk frontmatter.
- `model` (a `"provider/modelId"` reference), `thinking` and `stepMode` (`continue` | `stop`) are **also exclusively extension-managed**: they record what the plan last executed with, are written by the pre-flight panel (and by `/plan step`), and are re-offered when the plan is resumed. Invalid values are ignored on read, an unknown/unavailable model falls back to the current one with a warning, and rewriting a plan's body never drops them.
- Plan files saved before this feature existed have no frontmatter block at all; every field falls back gracefully (heading-based title, filename-derived date, no `todos` ⇒ nothing to resume) and nothing about them is rewritten.

### Execution Mode
- Full tool access restored
- The model/thinking level chosen in the pre-flight panel are applied, and restored when the plan finishes
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress and the current step-gating mode
- In `stop after each step` mode, a `Step n/N complete - continue?` prompt appears after each completed step
- The backing plan file's `todos` frontmatter is kept in sync on disk as steps complete (and once more when the plan finishes), so progress survives a session restart or a resume via `/plan list`
- Resuming a plan (either via session restart or `/plan list`) leaves plan mode and grants full tool access, exactly like executing a freshly created plan does

### Command Allowlist

The bash gate is structural, not a substring scan (`checkCommandSafety` in `utils.ts`):

1. The command line is split into segments quote-aware (`&&`, `||`, `|`, `;`, `&`, newlines) — a `|` or `>` inside a quoted `rg`/`grep` pattern never counts as shell syntax, and heredoc bodies are treated as data.
2. Each segment's **command word** must be on the read-only allowlist; commands with mixed read/write subcommands (`git`, `gh`, `go`, `npm`, `docker`, `kubectl`, ...) additionally have to match a read-only subcommand pattern.
3. Output redirections must target `/dev/null` or an existing descriptor, so `2>&1` and `>/dev/null` are fine while `> out.txt` is blocked.
4. `$(...)`, backtick and `<(...)` substitutions are validated recursively; `>(...)` is rejected.
5. Per-command argument rules catch write escape hatches on otherwise-safe commands: `find -exec/-delete`, `fd --exec`, `rg --pre`, `sed -i`, `awk 'print > "f"'`, `curl -o/-d/-X POST`, `gh api -X POST/-f`, `git --exec`.
6. Leading `VAR=value` assignments and shell keywords (`if`, `do`, `for`, `time`, ...) are stepped over so the command that actually runs is the one checked.

Blocked commands get a reason (e.g. ``\`rm\` can modify the system and is not allowed in plan mode``), which is fed back to the model instead of a generic "not allowlisted".

Allowed (examples):
- File inspection: `cat`, `head`, `tail`, `less`, `bat`, `xxd`, `strings`
- Search/listing: `grep`, `rg`, `fd`, `find` (without `-exec`/`-delete`), `ls`, `eza`, `tree`
- Text processing: `wc`, `sort`, `uniq`, `cut`, `jq`, `yq`, `awk`, `sed -n`, `diff`
- Git read: `git status/log/diff/show/blame/branch/remote get-url/ls-files/config --get`, ...
- GitHub read: `gh pr view/list/diff/checks`, `gh issue view/list`, `gh repo view`, `gh run list/view`, `gh search ...`, `gh api` (GET)
- Tooling info: `go env/list/doc/vet`, `npm list/outdated/why`, `docker ps/inspect`, `kubectl get/describe/logs`
- Network reads: `curl` (GET, no `-o`), `wget -O -`
- System info: `uname`, `whoami`, `date`, `uptime`, `ps`, `df`

Blocked (examples):
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`, `tee`, any `>`/`>>` to a real file
- Git/GitHub write: `git add/commit/push/checkout`, `gh pr create/merge/checkout`, `gh run rerun`
- Package install: `npm install`, `yarn add`, `pip install`, `brew install`
- Build/codegen: `go build`, `go test`, `shuttle run ...`, `lunarctl schema generate`
- Arbitrary execution: `bash -c`, `sh`, `eval`, `xargs`, `env FOO=1 <cmd>`
- System: `sudo`, `kill`, `reboot`; editors: `vim`, `nano`, `code`

## Tests

`utils.ts` (bash gating, frontmatter, todo extraction/sync, compact widget rows, execution settings, thinking-level list, model-picker rows) has a dependency-free test file:

```sh
node --experimental-strip-types extensions/plan-mode/utils.test.ts
```

Every command that plan mode wrongly blocked in the past is pinned as an "allowed" case there, so widening the allowlist can't silently regress into letting writes through.

Thinking-level *capability* logic is intentionally **not** reimplemented here, so there is nothing model-specific to test: `THINKING_LEVELS` is pinned as pi's full canonical list (the picker's only source of options) and `pi.setThinkingLevel()` owns the clamping. A regression test uses the real `thinkingLevelMap: {"xhigh":"xhigh","max":"max"}` metadata that once reduced the picker to `off/xhigh/max` (and clamped a session on `high` down to `off`) to pin that the offered set stays complete for any model.
