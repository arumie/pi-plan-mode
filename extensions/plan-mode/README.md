# Plan Mode Extension

Read-only exploration mode for safe code analysis, distributed as the [`@arumie/pi-plan-mode`](../../README.md) pi package.

## Installation

Install the package from a pinned Git release:

```sh
pi install git:github.com/arumie/pi-plan-mode@v2.0.1
```

Restart pi (or run `/reload`) after installation. For local development from a checkout, use `pi -e /absolute/path/to/pi-plan-mode`. Do not leave the legacy auto-discovered `~/.pi/agent/extensions/plan-mode/` directory active at the same time: it would load a second copy and duplicate `/plan` and `Ctrl+Alt+P` registrations.

## Features

- **Writes limited to plans dir**: Only markdown files under `~/.pi/plans/` (override with `PI_PLAN_DIR`) can be written/edited; all other paths are blocked
- **Bash allowlist**: Only read-only bash commands are allowed, checked structurally (quote-aware) so read-only research like `gh pr view` and `rg -ln "a|b"` works
- **Plan extraction**: Extracts numbered steps only from the `Plan:` section, excluding fenced examples and subsequent Context/Notes/Results lists, and folding multi-line steps into one label
- **Progress tracking**: A compact, width-responsive widget tracks ordered steps while the detailed descriptions remain in the plan body; frontmatter stores concise labels (see [Progress widget](#progress-widget))
- **Plan and execution tools**: `complete_plan_step` records execution progress; `list_plans` lists saved plans in every mode; `update_plan` is available in every mode to revise a targeted plan's steps or saved Context, Notes, and Results sections
- **Session persistence**: State survives session resume
- **Pre-flight panel**: Before execution starts, pick the model, thinking level and step-gating mode, and optionally add run-only context
- **Execution model stays active**: After the plan finishes, the model used for execution remains selected to preserve its prompt cache; the pre-execution thinking level is restored when supported.
- **Step gating**: Optionally stop after each completed step and confirm before continuing (default: keep going)
- **Agent plan-save tool**: `save_plan` accepts a plan name and markdown content, creates a dated file automatically, and normalizes its frontmatter in plan mode and normal mode
- **`repo`/`title`/`date` frontmatter**: Plan files get a `---` fenced frontmatter block backfilled automatically on save
- **On-disk todo tracking**: The `todos` frontmatter is written as soon as the plan file is saved and mirrored as steps complete or the plan is revised, so a plan can be resumed from `/plan list` in a future session

## Commands

- `/plan` - Toggle plan mode
- `/plan step [on|off|status]` - Control whether execution stops after each completed step. `on` stops, `off` keeps going (the default), bare `/plan step` toggles, `status` just reports. Works mid-execution and is persisted to the active plan file.
- `/plan list [--all] [query]` - Pick a previously saved plan (from `~/.pi/plans/`, or `$PI_PLAN_DIR`). Defaults to plans whose `repo` metadata matches the current repo, detected from the origin remote name, falling back to the git root folder name (or working directory name outside git). Use `/plan list --all` to disable repo filtering for that invocation, including plans without repo metadata; the next `/plan list` still defaults to the current repo. Each entry shows its filename and `title · repo · date` metadata (with heading / filename-derived fallbacks for older plans). Optional `query` seeds an editable search field; type to fuzzy-search filename, title, repo, and date, with best matches first. Search is case-insensitive and supports non-consecutive characters and multiple terms. Use ↑↓ to navigate, Enter to select, and Esc to cancel. A query with no matches can be edited without closing the picker. For example, `/plan list dbmig` searches this repo, and `/plan list --all dbmig` searches every repo. Use `--` before a query containing a literal `--all`.
  - If the selected plan has unfinished `todos` in its frontmatter, you're prompted to **resume execution** (opens the same pre-flight panel, pre-seeded with the model/thinking/step mode that plan last ran with; you can add run-only context before continuing from the first incomplete step) or **load as reference only** (injects the file's contents as context, same as before).
  - Otherwise, the plan is loaded as reference only, unchanged from before.
- `/todos` - Show the **full** plan todo list (every step with `✓`/`○`, plus an `X/Y complete` header, the step-gating mode and the active model). The widget is a compact view; this is the authoritative one.
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

`save_plan`, `list_plans`, and `update_plan` are available outside plan mode. `list_plans` continues to list all repos (the repo scope applies only to `/plan list`) and returns stable filenames and paths; pass one as `plan` to `update_plan` when editing a specific saved plan. Outside planning/execution mode, `update_plan` requires this explicit target and does not change active execution progress.

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header, then save the finished plan with `save_plan` by supplying a short name and the complete markdown content. The tool creates `YYYY-MM-DD-task-summary.md` in the configured plans directory; the date is generated automatically.


```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Choose "Execute the plan" when prompted, then confirm (or change) the model, thinking level and step-gating mode; select **Context** or press `Ctrl+N` to add a note for this execution only
5. `list_plans` can identify a saved plan to revise with `update_plan`; during planning/execution, omitting `plan` updates the active plan. During execution, the agent calls `complete_plan_step` after each finished step and can revise the plan with `update_plan` if needed
6. Progress widget shows completion status and the current step-gating mode (compact - see [Progress widget](#progress-widget); `/todos` prints the full list)

At step 4, if the plan was never saved to disk during planning, the extension auto-saves it to `~/.pi/plans/` (or `$PI_PLAN_DIR`) so execution always has a durable, resumable home from the start.

### Execution pre-flight panel

Picking "Execute the plan" opens one screen describing *how* the plan will run:

```
┌─ Execute plan: Add frontmatter to plan files ─┐
│ ▶ Start execution                             │
│ Model             amazon-bedrock/…opus-5      │
│ Thinking          high                        │
│ After each step   keep going                  │
│ Context           none                        │
│ Cancel                                        │
└───────────────────────────────────────────────┘
```

- **Model** opens a picker that mirrors `/model`: it opens on the session-scoped models (from the `--models` flag / `enabledModels` setting) in their configured order, unfiltered, and offers a `Scope: scoped → switch to all` row to reach the full available catalogue (standing in for `/model`'s Tab toggle, which the list component cannot receive). Rows show the model id with provider/name underneath and a `✓` on the active model. A model whose provider has no usable credentials is not filtered out here (same as `/model`); the problem is reported when the switch is attempted and execution continues on the current model.
- **Thinking** offers pi's canonical level list (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) for every model. Plan mode deliberately does **no** capability filtering of its own: `pi.setThinkingLevel()` already clamps to what the model supports (a non-reasoning model resolves to `off`), so deriving a per-model subset from `reasoning`/`thinkingLevelMap` here could only drift from pi's rule. `xhigh` and `max` are therefore labelled `may be clamped down by the model` rather than hidden, and the level is never silently downgraded when you switch model. A level pinned by a scoped-model pattern (e.g. `anthropic/*:high`) is preferred for a freshly picked model and labelled. The **effective** level is read back from `pi.getThinkingLevel()` after applying, and that value - not the requested one - is what the start notice reports and what lands in the `thinking` frontmatter field; if the model clamped your choice, the notice says so (`thinking: high (requested xhigh, clamped by the model)`).
- **After each step** toggles step gating (see below).
- **Start execution** begins; **Cancel** / `Esc` leaves you in plan mode with the plan file already saved, so nothing is lost. `Esc` inside a sub-picker keeps the previous value.
- **Context** opens a multiline editor for a run-only note. Press `Ctrl+N` from anywhere in the pre-flight list to jump directly to it; the note is supplied to the agent during this execution, survives that session's continuation/resume, and is not saved to the plan file.
- Headless runs (print/RPC, `ctx.hasUI === false`) skip the panel entirely and execute with the session's current model and the default "keep going" mode.

The choices are applied with `pi.setModel()` / `pi.setThinkingLevel()`. Those also rewrite pi's **global defaults**, so the selected execution model intentionally remains active after the plan finishes (including when you re-enter plan mode mid-execution) to preserve the prompt cache. The pre-execution thinking level is restored on the active model and may be clamped if unsupported. The notice reports the model and effective thinking level. A no-op selection takes no snapshot and triggers no restore.

### Step gating (stop or keep going after each step)

`After each step` has two modes, persisted per plan and changeable at any time with `/plan step`:

- **keep going** (default): the agent is told to continue straight into the next remaining step without waiting for confirmation, until the plan is finished - the previous behaviour.
- **stop after each step**: the agent is told that after `complete_plan_step` succeeds it must "STOP: end your turn there. Do not start the next step, do not call further tools". When the run ends, the extension asks:

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
- `☐ n. ...` - the next pending steps, numbered to match `/todos` and the `📋 completed/total` footer.
- `  +N more` - how many remaining steps did not fit.

Full normalized step descriptions remain in the plan body and execution context. Only the extension-managed `todos` frontmatter labels are shortened to at most 100 characters (with `...` when needed); the TUI widget may further ellipsize a label to fit the current terminal width. Its custom component rerenders on resize, so wider terminals reveal more of the frontmatter label without losing the detailed plan text.

The compact row count intentionally remains fixed. pi's TUI hard-caps string-array widgets at `InteractiveMode.MAX_WIDGET_LINES` (10 lines), and a long plan used to lose exactly the still-pending portion. `buildTodoWidgetRows` in `plan/widget.ts` still emits at most `MAX_TODO_WIDGET_ROWS` (8) structural rows: summary, current step, pending steps, and an exact `+N more` tail. TUI mode renders those rows with the width-responsive component; RPC/non-TUI clients receive a bounded string-array fallback. Unit tests cover long-description persistence, width boundaries, and the fixed-row `+N more` regression sweep.

For the full, uncollapsed list at any time, use `/todos`.

## How It Works

### Plan Mode (Read-Only)
- `write`/`edit` allowed **only** for `*.md` files under `~/.pi/plans/` (or `$PI_PLAN_DIR`)
- Any other write/edit path is blocked with an explanatory reason
- `list_plans` lists saved plans and their filenames/paths in every mode. `update_plan` targets a filename or path returned by `list_plans`, or the active plan when omitted during planning/execution; it can replace the full ordered `Plan:` steps and apply exact-match edits or append text in `Context`, `Notes`, and `Results`. An edit must provide existing `oldText` that occurs exactly once in the selected section; it replaces only that match, and an empty `newText` removes only the match. Appends preserve existing text and create a missing section as a `##` heading. Plan/Context/Notes/Results are treated as peer sections regardless of heading depth, so updating one preserves the others. These saved sections are distinct from the pre-flight's run-only context note.
- Other active tools remain available except file mutators that bypass the plan-path guard: hashline `replace`, `replace_within`, `insert`, `copy`, `move`, and `undo_last_change` are hidden and blocked; read-only `read` and `anchor_grep` remain available.
- Bash commands filtered through allowlist
- Agent creates a plan without making changes
- The agent creates a new saved plan with `save_plan`, supplying only a short name and full markdown content. The tool creates the plans directory when needed, derives a collision-free `YYYY-MM-DD-task-summary.md` filename using the current date, and supplies the plan date itself.
- `save_plan` preserves agent-provided `repo`/`title` values when valid and backfills missing values: `repo` from `git remote get-url origin` (falling back to the cwd folder name) and `title` from the first markdown heading or supplied name. Existing `write`/`edit` calls remain available only to refine an already-saved plan and continue to backfill missing metadata without dropping extension-managed settings.
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
- `todos` is **exclusively extension-managed** — a single-line JSON array derived from the numbered `Plan:` list and kept in sync with execution progress. Each `text` is a concise label (up to 100 characters); the full normalized description remains in the markdown body and is used by execution. Shortened labels include a `textHash` of the full normalized description so shared prefixes cannot transfer completion between distinct steps; older labels without a hash are migrated when loaded. `complete_plan_step` records progress, while `update_plan` keeps step descriptions and progress summaries synchronized.
- `model` (a `"provider/modelId"` reference), `thinking` and `stepMode` (`continue` | `stop`) are **also exclusively extension-managed**: they record what the plan last executed with, are written by the pre-flight panel (and by `/plan step`), and are re-offered when the plan is resumed. Invalid values are ignored on read, an unknown/unavailable model falls back to the current one with a warning, and rewriting a plan's body never drops them.
- Plan files saved before this feature existed have no frontmatter block at all; every field falls back gracefully (heading-based title, filename-derived date, no `todos` ⇒ nothing to resume) and nothing about them is rewritten.

### Execution Mode
- Full tool access restored
- The model chosen in the pre-flight panel remains active after the plan finishes; the previous thinking level is restored where supported
- Agent executes steps in order
- Agent calls `complete_plan_step` after each finished step; it rejects calls outside execution, repeated steps, missing steps, and out-of-order steps without changing progress
- `update_plan` is available in every mode; in planning/execution it defaults to the active plan, while outside those modes it requires a filename or path from `list_plans`. Step changes require the complete ordered list and preserve completion for unchanged steps. Context/Notes/Results are changed only with exact-match `sectionEdits` or non-destructive `sectionAppends`; a stale or ambiguous match fails without writing the file.

For example, replace one exact passage or append without removing existing text:

```json
{
  "sectionEdits": [{ "section": "context", "oldText": "Old sentence.", "newText": "Updated sentence." }],
  "sectionAppends": [{ "section": "notes", "text": "Additional verification note." }]
}
```

An empty `newText` removes only the matched `oldText`. `oldText` must occur exactly once within that section; on a mismatch, re-read the plan and retry.

- Widget shows progress and the current step-gating mode
- In `stop after each step` mode, a `Step n/N complete - continue?` prompt appears after each completed step
- The backing plan file's compact `todos` frontmatter is kept in sync on disk as steps complete or the plan is revised, so progress survives a session restart or a resume via `/plan list`
- Resuming a plan (either via session restart or `/plan list`) leaves plan mode and grants full tool access, exactly like executing a freshly created plan does

### Command Allowlist

The bash gate is structural, not a substring scan (`checkCommandSafety` in `security/command-safety.ts`):

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

The focused helpers under `plan/` and `security/` are re-exported through `utils.ts` for compatibility and covered by the utility test file:

```sh
node --experimental-strip-types extensions/plan-mode/utils.test.ts
```

Every command that plan mode wrongly blocked in the past is pinned as an "allowed" case there, so widening the allowlist can't silently regress into letting writes through.

Thinking-level *capability* logic is intentionally **not** reimplemented here, so there is nothing model-specific to test: `THINKING_LEVELS` is pinned as pi's full canonical list (the picker's only source of options) and `pi.setThinkingLevel()` owns the clamping. A regression test uses the real `thinkingLevelMap: {"xhigh":"xhigh","max":"max"}` metadata that once reduced the picker to `off/xhigh/max` (and clamped a session on `high` down to `off`) to pin that the offered set stays complete for any model.
