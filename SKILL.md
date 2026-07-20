---
name: smart-files
description: Content-aware file management for OpenClaw agents. Search files by content (not just names), find duplicates by hash, auto-categorize by type, detect file types, analyze cleanup needs, and rename with context. Zero dependencies.
---

# Smart Files ⚡

**Stop guessing where files are. Find them by what they contain.**

## The Problem

Agent file operations are blind. `find . -name "*.js"` only matches filenames. `grep` only searches text. No tool connects **what you're looking for** to **what's actually inside the files**.

Smart Files fixes this with one tool, zero dependencies.

## Quick Start

### Search files by content (not just names)

```bash
node skills/smart-files/smart-files.js --search "database connection"
```

Searches across all files in the workspace, not just filenames. Returns matches ranked by relevance with sanitized snippets.

⚠️ **Privacy Note**: Search returns content snippets. Sensitive patterns (API keys, tokens, passwords) are automatically redacted, but this is a best-effort filter. Do not trust content search on directories containing secrets.

### Find duplicate files

```bash
node skills/smart-files/smart-files.js --dedup
```

Finds duplicate files by SHA-256 hash. Groups them with file sizes and paths.

### Auto-categorize files (read-only)

```bash
node skills/smart-files/smart-files.js --organize /path/to/dir
```

Categorizes files into: code, data, docs, media, archives, images, other. **Read-only** — never modifies files.

### File metadata and type detection

```bash
node skills/smart-files/smart-files.js --info /path/to/file
```

Shows size, type, lines, words, modified date, and auto-detected content type.

### Cleanup analysis

```bash
node skills/smart-files/smart-files.js --cleanup /path/to/dir
```

Finds temp files, large files (>1MB), and duplicate groups.

### Workspace overview

```bash
node skills/smart-files/smart-files.js --status
```

Total files, total size, extension breakdown, largest files.

### Rename files (dry-run)

```bash
node skills/smart-files/smart-files.js --rename script.js app.js
```

Rename preview. Shows what would change without modifying.

### Auto-Organize Watcher ⚠️

```bash
# Dry-run preview (DEFAULT — safe, no files modified)
node skills/smart-files/smart-files.js --watch /path/to/dir

# Actually move/organize files (DESTRUCTIVE)
node skills/smart-files/smart-files.js --watch /path/to/dir --force
```

⚠️ **Watch mode is DRY-RUN by default.** It shows what would change without touching files. Use `--force` explicitly to enable destructive operations (move, rename, delete). `--force` includes a 5-second abort window.

**Watch mode behavior (with --force):**
1. **Monitors** a directory using `fs.watch` (fallback: polling)
2. **Cleans filenames** — removes illegal chars, normalizes whitespace/dates
3. **Categorizes** — copies files to category subdirectories (Pictures/, Documents/, Code/, etc.)
4. **Deduplicates** — skips files with known content hashes
5. **Unlinks originals** — files are copy-then-delete (no atomic move), original inode is destroyed

⚠️ **Watch mode is inherently destructive with --force:**
- Files are moved by copy+unlink — the original is deleted
- No built-in rollback (journal records actions for manual recovery)
- Runs continuously, modifying new files as they appear
- Always run `--dry-run` first to preview what would change

**Custom rules** via `.smart-files-rules.json` in the watched directory:
```json
[
  { "exts": [".js", ".ts"], "category": "Scripts" },
  { "exts": [".py", ".rb"], "category": "Scripts" },
  { "exts": [".jpg", ".png"], "category": "Images" }
]
```

Actions are journaled to `memory/smart-files-journal.json`.

## Features

### Content-Aware Search

- Searches actual file content, not just filenames
- Word-level matching handles partial words and special characters
- Ranked by relevance score (1.0 = exact match)
- Returns context snippets with automatic secret redaction
- Skips binary files automatically

### Duplicate Detection

- SHA-256 content hashing (not just filenames)
- Size-based pre-filtering for performance
- Groups duplicates by identical content
- Shows file sizes and all paths

### Auto-Categorization (read-only)

- Extension-based file type classification
- Categories: code, data, docs, media, archives, images, other
- Works on any directory, not just workspace
- Read-only — never modifies files

### Cleanup Analysis

- Finds temp/backup files (.tmp, ~, .bak, etc.)
- Identifies large files (>1MB)
- Reports duplicate groups
- Scans entire directory tree

### File Info

- Auto-detects content type (JavaScript, Python, HTML, SQL, Markdown, JSON, YAML, etc.)
- Line count, word count, size
- Modified and creation dates

### Auto-Organize Watcher

- Monitors directories with `fs.watch` + polling fallback
- **DRY-RUN by default** — no files modified without `--force`
- Customizable rules via `.smart-files-rules.json`
- Journal of all actions for audit trail
- 5-second abort window when `--force` is used

## Configuration

No config needed. Works out of the box.

Override workspace root:
```bash
--dir /path/to/workspace
```

Environment variables:
- `SMART_FILES_WORKSPACE` — Override workspace root directory

## Performance

- Skips binary files automatically (null-byte check + extension filter)
- Size pre-filtering before hashing (dedup)
- Content scanning limited to 10MB per file
- Results capped at 20 matches for search
- Default skip directories: .git, node_modules, .npm, .cache

## Agent Protocol

When the agent needs file operations:

1. **Finding a file** → Use `--search <query>` instead of `find` or `grep`
2. **Cleaning up** → Use `--cleanup` to identify what to remove
3. **Before deleting** → Use `--dedup` to find duplicates first
4. **Understanding a file** → Use `--info` to get metadata and type
5. **Organizing** → Use `--organize` to categorize a directory (read-only)
6. **Watching** → Use `--watch --dry-run` first, only use `--force` after previewing

## Security & Privacy

| Protection | Details |
|------------|---------|
| **Read-only by default** | All modes except `--watch --force` never modify files |
| **Binary detection** | Null-byte check + binary extension filter |
| **Oversized file skip** | Configurable MAX_SCAN_SIZE (10MB default) |
| **No shell execution** | Pure Node.js fs ops — no child_process |
| **Snippet sanitization** | API keys, tokens, PEM keys automatically redacted from search output |
| **Workspace path awareness** | Detects and warns when scanning outside workspace |
| **Watch safety gate** | `--watch` defaults to dry-run; `--force` has 5-second abort window |

⚠️ **Privacy Warning**: Content search reads file contents and returns snippets. Even with automatic redaction, this is a best-effort filter — not a security boundary. Do not run `--search` on directories containing secrets, credentials, or personal data you don't want exposed in terminal output or agent context.

⚠️ **Watch Mode Warning**: `--watch --force` is destructive. It copies, moves, and deletes files. Always preview with `--dry-run` first. The journal provides an audit trail but is NOT a backup — there is no automatic rollback.

## Comparison

| Tool | What it searches | Safety | Setup |
|------|-----------------|--------|-------|
| `find` | Filenames only | Read-only | None |
| `grep` | Text content | Read-only | None |
| **Smart Files** | **Content + metadata + organize** | **Read-only default** | **None** |
| ripgrep | Text content | Read-only | Install |
| fd | Filenames | Read-only | Install |

**Smart Files gives you content-aware search + dedup + cleanup + metadata in one tool.**

## Design Principles

1. **Zero setup** — Works immediately, no config needed
2. **No dependencies** — Pure Node.js, no npm packages
3. **Safe by default** — Read-only unless you explicitly `--force` watch mode
4. **Transparent** — Everything it does is reported; journal tracks watch actions
5. **Fast** — Optimized for workspace-scale file operations
6. **Honest** — Privacy warnings where they matter, not false security claims
