# Changelog

All notable changes to this package are documented in this file.

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
