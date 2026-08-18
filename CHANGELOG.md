# Changelog

All notable changes to this package are documented in this file.

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
