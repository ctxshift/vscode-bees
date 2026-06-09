# Agent Instructions

This project uses **bees** ([ctxshift/bees](https://github.com/ctxshift/bees))
for issue tracking — a lightweight, single-binary tracker backed by local SQLite
with a git-tracked `issues.jsonl` export.

## Quick Reference

```bash
bees ready                       # Find available work (no blockers)
bees show <id>                   # View issue details
bees update <id> --status in_progress   # Claim/start work
bees close <id> --reason "..."   # Complete work
bees sync                        # Export DB to .bees/issues.jsonl, then commit it
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on
confirmation prompts. `cp`, `mv`, `rm` may be aliased to `-i` on some systems.

```bash
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file
rm -rf directory            # NOT: rm -r directory
```

Other commands that may prompt: `scp`/`ssh` (use `-o BatchMode=yes`), `apt-get`
(use `-y`), `brew` (set `HOMEBREW_NO_AUTO_UPDATE=1`).

## Issue Tracking with bees

**IMPORTANT**: This project uses **bees** for ALL issue tracking. Do NOT use
markdown TODOs, task lists, or other tracking methods.

### Why bees?

- Dependency-aware: track blockers and relationships between issues
- Git-friendly: every mutation auto-exports `issues.jsonl`, which is the
  versioned source of truth (commit it like code)
- Single static binary backed by SQLite — no server, no daemon, cross-platform
- Agent-optimized: `--json` output and ready-work detection

### Quick Start

**Check for ready work:**

```bash
bees ready --json
```

**Create new issues:**

```bash
bees create "Issue title" -d "Detailed context" -t bug|feature|task|epic|story -p 1-4 --json
```

**Claim and update:**

```bash
bees update <id> --status in_progress --json
bees update <id> --priority 1 --json
```

**Complete work:**

```bash
bees close <id> --reason "Completed" --json
```

**Link related work:**

```bash
bees dep add <issue> <depends-on> -t blocks      # blocks | related | parent-child
```

### Issue Types

- `bug` — Something broken
- `feature` — New functionality
- `task` — Work item (tests, docs, refactoring)
- `epic` — Large feature with subtasks
- `story` — User-facing unit of work

### Priorities

- `1` — Critical (security, data loss, broken builds)
- `2` — High (major features, important bugs)
- `3` — Medium
- `4` — Low / backlog

### Workflow for AI Agents

1. **Check ready work**: `bees ready` shows unblocked issues
2. **Claim your task**: `bees update <id> --status in_progress`
3. **Work on it**: implement, test, document
4. **Discover new work?** Create a linked issue:
   - `bees create "Found bug" -d "Details" -p 1`
   - `bees dep add <new-id> <parent-id> -t related`
5. **Complete**: `bees close <id> --reason "Done"`

### Sync

bees auto-exports after every mutation:

- Each write rewrites `.bees/issues.jsonl`
- Commit `issues.jsonl` to share issue state — git is the sync mechanism
- No Dolt, no manual export/import needed

### Important Rules

- ✅ Use bees for ALL task tracking
- ✅ Always use `--json` for programmatic use
- ✅ Link discovered work with `bees dep add`
- ✅ Check `bees ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

## Landing the Plane (Session Completion)

**When ending a work session**, complete ALL steps below. Work is NOT complete
until `git push` succeeds.

1. **File issues for remaining work** — create issues for anything needing follow-up
2. **Run quality gates** (if code changed) — `mise run check`
3. **Update issue status** — close finished work, update in-progress items
4. **PUSH TO REMOTE** — this is MANDATORY:
   ```bash
   bees sync                  # ensure issues.jsonl is current
   git add -A && git commit   # include issues.jsonl
   git pull --rebase
   git push
   git status                 # MUST show "up to date with origin"
   ```
5. **Clean up** — clear stashes, prune remote branches
6. **Verify** — all changes committed AND pushed
7. **Hand off** — provide context for the next session
