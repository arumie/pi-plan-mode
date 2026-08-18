# Plan Mode for pi

`@arumie/pi-plan-mode` is a pi package that adds a read-only planning mode and guided plan execution. While planning, project writes are blocked (except markdown plan files in the configured plans directory); when execution begins, Plan Mode tracks plan progress and restores normal access.

> **Security:** pi extensions run with your user permissions. Install this package only from a source you trust.

## Install

Install the initial release from its pinned Git tag:

```sh
pi install git:github.com/arumie/pi-plan-mode@v1.0.1
```

Restart pi (or run `/reload`) after installing. Confirm the package is registered with `pi list`.

For checkout development only, pi can load a local package directory:

```sh
pi -e /absolute/path/to/pi-plan-mode
```

Do not run the package alongside the legacy auto-discovered extension at `~/.pi/agent/extensions/plan-mode/`; both copies register `/plan` and `Ctrl+Alt+P`. Move or remove that directory before enabling the package-managed copy.

## Usage

- `/plan` — toggle read-only planning mode.
- `/plan list [filter]` — load a saved plan or resume an unfinished one.
- `/plan step [on|off|status]` — configure pausing after each execution step.
- `/todos` — show the full current plan progress list.
- `Ctrl+Alt+P` — toggle planning mode.
- `--plan` — start pi in planning mode.

Plan files are stored in `~/.pi/plans/` by default. Set `PI_PLAN_DIR` to use another directory.

See the [extension guide](extensions/plan-mode/README.md) for behavior, frontmatter, execution pre-flight, and command-allowlist details.

## Compatibility

This is a TypeScript pi extension, loaded directly by pi. It relies on pi's extension APIs and declares the pi packages it imports as peer dependencies, so it should be used with a current pi installation. The package does not bundle pi runtime dependencies.

## Development and validation

```sh
npm install
npm run release:check
```

The utility test uses Node's TypeScript stripping support. The type check covers the packaged extension entry point and utilities.

## Troubleshooting

- **`/plan` appears twice or the shortcut conflicts:** remove or move the legacy `~/.pi/agent/extensions/plan-mode/` directory, then restart pi. The package and a locally auto-discovered copy must not both be active.
- **A package update happened while pi was running:** restart pi (or run `/reload`) before continuing. The active session keeps its already-loaded extension modules until then.
- **A saved plan cannot resume:** inspect its frontmatter. Missing or malformed extension-managed `todos` data cannot safely be inferred from chat history; load it as a reference, repair/recreate the plan, then start execution again.

## Releases and updates

Git tags are the release mechanism:

1. Update `package.json`'s version, `CHANGELOG.md`, and documentation.
2. Run `npm run release:check`.
3. Commit and push `main`.
4. Create and push an annotated semantic-version tag, for example `v1.0.1`.
5. Install that exact revision with `pi install git:github.com/arumie/pi-plan-mode@v1.0.1`.

A Git ref in `pi install` is pinned. `pi update --extensions` reconciles the configured ref but does not advance it to a newer tag; install the new tag explicitly when upgrading. Remove the package with:

```sh
pi remove git:github.com/arumie/pi-plan-mode
```

## License

[MIT](LICENSE)
