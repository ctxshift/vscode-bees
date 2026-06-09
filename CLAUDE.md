# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is **vscode-bees** ([ctxshift/vscode-bees](https://github.com/ctxshift/vscode-bees)),
a VS Code extension for the [bees](https://github.com/ctxshift/bees) issue tracker.
It was forked from [jdillon/vscode-beads](https://github.com/jdillon/vscode-beads)
and retargeted from Beads/Dolt to bees (a single static binary backed by local SQLite).

## Build Commands

Use mise tasks (they wrap the underlying `bun run` scripts and pin the toolchain):

```bash
mise run setup      # install dependencies (bun install)
mise run check      # typecheck + lint + test
mise run build      # build extension + webview
mise run watch      # watch mode (extension + webview in parallel)
mise run package    # create the VSIX
```

The underlying scripts (`bun run compile`, `bun run lint`, `bun run typecheck`,
`bun run test`, `bun run package`) still work directly if you prefer.

## Development Workflow

**Branch before making changes** unless told to push `main` directly. Create a
feature branch (`fix/`, `feat/`, `chore/`) before code changes when opening a PR.

**Local testing:**

1. Extension Development Host: open the repo in VS Code, run `mise run watch`,
   press `F5`, then `Ctrl+R` to reload after changes.
2. Install the VSIX: `mise run package` then
   `code --install-extension vscode-bees-<version>.vsix` and reload the window.

Point the `bees.pathToBd` setting at your `bees` binary (or leave it as the
default `bees` and let mise resolve it — see `bees.useMise`).

## Architecture

VS Code extension for managing [bees](https://github.com/ctxshift/bees) issues
via the `bees` CLI.

### Data Flow

1. **BeadsBeesBackend** (`src/backend/BeadsBeesBackend.ts`) — the only backend.
   Spawns `bees <command> --json` via `execFile` (no shell, no socket, no
   server), parses responses. Mutations are followed by `show(id)` to return the
   full issue. Labels go through `bees label add|remove`.
2. **BeadsProjectManager** (`src/backend/BeadsProjectManager.ts`) — discovers
   `.bees` (or `.beads`) directories on the filesystem, manages the active
   project, resolves the `bees` executable (including via `mise which`), and
   polls `bees.db` mtime for change detection.
3. **View Providers** (`src/providers/`) — extend `BaseViewProvider`, register
   webview views, handle message passing.
4. **React Webviews** (`src/webview/`) — single React app routed by `viewType`.
   Receives data via `postMessage`, sends actions back to the extension.

### Key Patterns

- All bees operations go through the CLI (`bees list --json`, `bees show <id>
  --json`, etc.) — never read `.bees` files directly
- bees is embedded SQLite; there is **no** server/daemon to manage. Do not
  reintroduce Dolt or socket/daemon concepts
- Status/priority normalization in `src/backend/types.ts`
- Webview↔Extension communication via typed messages (`ExtensionMessage`,
  `WebviewMessage`)
- A single webview bundle (`dist/webview/main.js`) serves all views; the view
  type determines which component renders
- **Prefer components over ad-hoc markup**: extract reusable UI into
  `src/webview/common/` (e.g. `StatusBadge`, `FilterChip`)
- **No native HTML controls**: use the custom components (`Dropdown`,
  `ColoredSelect`) for VS Code-themed styling

> Note: many internal identifiers still use the legacy `Beads`/`bead` names
> (e.g. `BeadsProjectManager`, `BeadsIssue`, `beadId`, CSS `beads-*`). These are
> internal only — public settings, command IDs, and copy use `bees`/`Bees`.

### Build System

- esbuild for both extension (Node/CommonJS) and webview (browser/IIFE)
- Extension entry: `src/extension.ts` → `dist/extension.js`
- Webview entry: `src/webview/index.tsx` → `dist/webview/main.js`

## CHANGELOG

Maintain `CHANGELOG.md` using [Keep a Changelog](https://keepachangelog.com/) format.

- Add entries under `## [Unreleased]` as features/fixes are completed
- Only log notable changes: features, bug fixes, breaking changes
- Skip minor/internal changes (refactors, typos, CI tweaks)
- Keep entries terse — one line per change
- Use sections: `### Added`, `### Fixed`, `### Changed`, `### Removed`

At release time, `[Unreleased]` content moves to `## [x.y.z] - date`.

## Code Conventions

- **kebab-case**: source code, docs, configs (`my-module.ts`, `api-reference.md`)
- **UPPERCASE**: only for standard files (`README.md`, `CHANGELOG.md`, `CLAUDE.md`, `LICENSE`)

## Icons

Use [Font Awesome Free](https://fontawesome.com) icons unless there's a good
reason not to. Icons live as SVG files in `src/webview/icons/` and are imported
via the `Icon` component or `icons` object. See `src/webview/icons/index.ts`.

## Upstream Sync

Two upstreams are relevant:

- **bees** ([ctxshift/bees](https://github.com/ctxshift/bees)) — the CLI this
  extension drives. Watch for new commands, flags, `--json` output shape changes,
  and new `issue_type` values (update `BeadType`, `TYPE_LABELS`, `TYPE_COLORS`,
  `TYPE_SORT_ORDER` in `src/webview/types.ts` and add icons).
- **vscode-beads** ([jdillon/vscode-beads](https://github.com/jdillon/vscode-beads))
  — the fork origin. Cherry-pick UI/UX improvements, but skip anything Dolt- or
  daemon-related.
