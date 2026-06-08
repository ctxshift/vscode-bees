# Bees - VS Code Extension

<img src="resources/icon.png" alt="Bees icon" width="128" align="right">

VS Code extension for managing [Bees](https://github.com/ctxshift/bees) issues.
Bees is a lightweight, single-binary issue tracker backed by local SQLite, with
issues exported to a git-tracked `issues.jsonl`. The extension drives the `bees`
CLI directly (no server, no socket), so it works on Linux, macOS, and Windows.

![Bees VS Code Extension](docs/images/beads-vscode-screenshot.png)

## Features

**Kanban Board View**

- Toggle between Table and Board views for issues
- Drag cards between columns to change status
- See status distribution at a glance (Open, In Progress, Blocked, Closed)
- All columns collapsible for focused workflow (closed by default)
- Cards show title, ID, type, priority, assignee, and labels
- Filter-aware: shows "3/5" count when filters hide items
- Click any card to open details

**Issues Panel**

- Sortable, filterable table with global search
- Filter by status, priority, type, assignee, and labels
- Multi-column sorting (shift+click for secondary sort)
- Persistent column visibility, order, and sort preferences
- Filter presets: Not Closed, Blocked, Epics
- Click-to-copy issue IDs

**Details Panel**

- View/edit title, description, status, priority, type, labels, assignee
- Colored inline dropdowns for quick field editing
- Markdown rendering in description/notes with timezone-aware timestamps
- Dependency management with grouped relationship types (blocks, related, parent-child)

**Multi-Project**

- Auto-detects `.bees` directories in the workspace
- Project switcher and compact dashboard controls
- Reads issues, details, and comments via `bees … --json`
- Polls the database for near-real-time updates

## Requirements

- VS Code 1.85.0+
- [Bees CLI](https://github.com/ctxshift/bees) (`bees`, or `bees.exe` on Windows) on your `PATH`
- An initialized project (`bees init`)

If you manage tools with [mise](https://mise.jdx.dev), a bare `bees` (or a mise/asdf
shim) is resolved to the real binary automatically — see `bees.useMise` below.

## Installation

Install the packaged `.vsix`:

```
code --install-extension vscode-bees-<version>.vsix
```

or grab it from the [GitHub Releases](https://github.com/ctxshift/vscode-bees/releases).

## Usage

1. Initialize: `bees init`
2. Click the Bees icon in the Activity Bar
3. Browse, filter, and edit issues across the Dashboard, Issues, and Details views

### Issues Panel

- Click column headers to sort (shift+click for multi-column)
- Search by title, description, or issue ID
- Filter by status, priority, type, assignee, labels
- Use filter presets or create custom filter combinations
- Show/hide and reorder columns via ⋮ menu
- Click a row to view details, click an issue ID to copy

### Details Panel

- Click badges to edit type/status/priority inline
- "Assign to me" quick action for assignee
- Add/remove labels with auto-generated colors
- Markdown rendering in description/notes
- View dependencies grouped by relationship type

## Commands

| Command                    | Description                |
| -------------------------- | -------------------------- |
| `Bees: Switch Project`     | Select active project      |
| `Bees: Refresh`            | Refresh all views          |
| `Bees: Open Issues Panel`  | Focus the Issues view      |
| `Bees: Open Issue Details` | Open the Details view      |
| `Bees: Copy Issue ID`      | Copy the selected issue ID |

## Settings

| Setting                  | Default  | Description                                              |
| ------------------------ | -------- | ------------------------------------------------------- |
| `bees.pathToBd`          | `"bees"` | Path to the `bees` CLI (`bees.exe` on Windows)          |
| `bees.useMise`           | `true`   | Resolve a bare name / mise shim via `mise which`        |
| `bees.refreshInterval`   | `3000`   | Database change polling interval in ms (0 = disable)    |
| `bees.renderMarkdown`    | `true`   | Render markdown in text fields                          |
| `bees.userId`            | `""`     | Your user ID for "Assign to me" (defaults to $USER)     |
| `bees.tooltipHoverDelay` | `1000`   | Delay in ms before showing tooltip on hover (0 = disable) |

## Troubleshooting

**"No Bees projects found"** — run `bees init` in the project root.

**`spawn bees ENOENT`** — the `bees` binary isn't found. Set `bees.pathToBd` to the
full path to `bees.exe`, or (with mise) keep `bees.useMise` enabled and ensure
`mise which bees` resolves in the project directory.

**Commands fail** — check the "Bees" output channel and verify `bees` runs in your terminal.

## Development

```
mise run setup     # install dependencies
mise run check     # typecheck + lint + test
mise run build     # compile extension + webview
mise run package   # build the .vsix
```

## Credits

Built with ❤️ using [Claude Code](https://claude.com/claude-code)

Issue type icons from [Font Awesome Free](https://fontawesome.com) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/))

## License

Apache License 2.0
