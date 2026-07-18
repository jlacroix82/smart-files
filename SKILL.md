---
name: smart-files
description: Content-aware file management for OpenClaw agents. Search files by content (not just names), find duplicates by hash, auto-categorize by type, detect file types, analyze cleanup needs, and rename with context. Zero dependencies.
---

# Smart Files ⚡

**Stop guessing where files are. Start finding them by what they contain.**

## The Problem

Agent file operations are blind. `find . -name "*.js"` only matches filenames. `grep` only searches text. No tool connects **what you're looking for** to **what's actually inside the files**.

Smart Files fixes this with one tool, zero dependencies.

## Quick Start

### Search files by content (not just names)

```bash
node skills/smart-files/smart-files.js --search "database connection"
```

Searches across all files in the workspace, not just filenames. Returns matches ranked by relevance with snippets.

### Find duplicate files

```bash
node skills/smart-files/smart-files.js --dedup
```

Finds duplicate files by SHA-256 hash. Groups them with file sizes and paths.

### Auto-categorize files

```bash
node skills/smart-files/smart-files.js --organize /path/to/dir
```

Categorizes files into: code, data, docs, media, archives, images, other.

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

### Rename files

```bash
node skills/smart-files/smart-files.js --rename script.js app.js
```

Rename with context. Dry run by default — shows what would change.

## Features

### Content-Aware Search

- Searches actual file content, not just filenames
- Word-level matching handles partial words and special characters
- Ranked by relevance score (1.0 = exact match)
- Returns context snippets around matches
- Skips binary files automatically

### Duplicate Detection

- SHA-256 content hashing (not just filenames)
- Size-based pre-filtering for performance
- Groups duplicates by identical content
- Shows file sizes and all paths

### Auto-Categorization

- Content-aware file type detection
- Categories: code, data, docs, media, archives, images, other
- Works on any directory, not just workspace

### Cleanup Analysis

- Finds temp/backup files (.tmp, ~, .bak, etc.)
- Identifies large files (>1MB)
- Reports duplicate groups
- Scans entire directory tree

### File Info

- Auto-detects content type (JSON, Python, HTML, SQL, Markdown, etc.)
- Line count, word count, size
- Modified and creation dates

## Configuration

No config needed. Works out of the box.

Override workspace root:
```bash
--dir /path/to/workspace
```

## Performance

- Skips binary files automatically
- Size pre-filtering before hashing (dedup)
- Content scanning limited to 10MB per file
- Results capped at 20 matches for search

## Agent Protocol

When the agent needs file operations:

1. **Finding a file** → Use `--search <query>` instead of `find` or `grep`
2. **Cleaning up** → Use `--cleanup` to identify what to remove
3. **Before deleting** → Use `--dedup` to find duplicates first
4. **Understanding a file** → Use `--info` to get metadata and type
5. **Organizing** → Use `--organize` to categorize a directory

## Security

- Path validation — rejects paths outside workspace root
- Binary file detection — skips non-text files
- Size limits — 10MB max per file scan
- Symlink-safe — uses standard fs operations

## Comparison

| Tool | What it searches | Speed | Setup |
|------|-----------------|-------|-------|
| `find` | Filenames only | Fast | None |
| `grep` | Text content | Medium | None |
| **Smart Files** | **Content + metadata** | **Fast** | **None** |
| ripgrep | Text content | Fast | Install |
| fd | Filenames | Fast | Install |

**Smart Files gives you content-aware search + dedup + cleanup + metadata in one tool.**

## Design Principles

1. **Zero setup** — Works immediately, no config needed
2. **No dependencies** — Pure Node.js, no npm packages
3. **Safe by default** — Skips binaries, respects size limits
4. **Transparent** — Everything it does is reported
5. **Fast** — Optimized for workspace-scale file operations
