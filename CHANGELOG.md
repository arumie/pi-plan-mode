# Changelog

All notable changes to this package are documented in this file.

## [1.1.0] - 2026-10-01

### Added

- Add `update_plan` for revising saved plan steps and Context/Notes/Results sections during planning or execution.
- Add an optional run-only execution context note to the pre-flight menu, accessible with `Ctrl+N`.

### Changed

- Store concise todo labels in plan frontmatter while retaining full step descriptions in the plan body and execution context.
- Hide and block hashline mutation tools during plan mode while retaining its read and search tools.

### Fixed

- Preserve distinct completion flags for long steps with identical compact labels by persisting full-description hashes.
- Keep saved section checklists out of execution steps and ignore fenced code headings when extracting or updating sections.
- Use the same step extraction and validation for plan updates and reloads, including inline-code and command descriptions.
- Replace all old ordered steps even when explanatory prose separates them, without leaving stale steps to reappear on reload.
- Treat Plan/Context/Notes/Results as peer sections regardless of heading depth so section updates cannot delete another managed section.
- Preserve existing completion flags when revising a session-only plan without a backing file.

## [1.0.5] - 2026-09-25

### Changed

- Keep `save_plan` available in normal mode as well as plan mode; saving outside plan mode does not alter active plan progress.

## [1.0.4] - 2026-08-26

### Changed

- Make **Start execution** the first option in the execution pre-flight panel, ahead of model, thinking-level, and step-gating settings.

## [1.0.3] - 2026-08-18

### Changed

- Replace assistant-authored `[DONE:n]` markers with the execution-only `complete_plan_step` tool. The tool records only the next unfinished step, rejects invalid or repeated calls without mutating progress, and keeps session and on-disk todo state synchronized.

## [1.0.2] - 2026-08-18

### Changed

- Preserve complete normalized plan-step descriptions in managed todo frontmatter, including upgrades for legacy truncated entries when a saved plan is opened.
- Make the compact progress widget responsive to terminal width while retaining its fixed row budget and accurate `+N more` summary.

### Added

- ANSI- and Unicode-display-width-safe widget label truncation, plus regression coverage for full-description persistence and narrow terminals.

## [1.0.1] - 2026-08-18

### Changed

- Point the pi manifest at the explicit extension entry point and publish only runtime source files.
- Declare Node.js 22 as the supported runtime.

### Added

- Package-manifest regression test and GitHub Actions validation for tests, type checking, and package dry runs.
- Release-check command and troubleshooting guidance for duplicate loads, reloads, and malformed persisted plans.

## [1.0.0] - 2026-08-18

### Added

- Initial Git-distributed pi package for Plan Mode.
- Read-only planning, plan persistence, guided execution progress, execution pre-flight, and step-gating features migrated from the user-local extension.
