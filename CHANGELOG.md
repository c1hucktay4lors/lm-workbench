# Changelog

All notable changes to LM Workbench will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `lm-memory-sync` CLI for optional Google Drive synchronization of the memory directory via rclone bisync
- systemd user service/timer templates for automatic periodic sync (`systemd/lm-memory-sync.service`, `.timer`)
- code-review skill (general-purpose code review methodology: structure, style, security, performance, error handling)

### Changed
- Default persistent memory location moved to per-user application-data directory:
  - Linux: `~/.local/share/lm-workbench/memory/memory.md` (respects `$XDG_DATA_HOME`)
  - Windows: `%LOCALAPPDATA%\lm-workbench\memory\memory.md`
  - macOS: `~/Library/Application Support/lm-workbench/memory/memory.md`
- Existing stores at `~/.mcp-memory/memory.md` and `~/.local/share/mcp-memory/memory.md` continue to work via backward-compatibility fallback

### Fixed
- (nothing yet)

### Removed
- (nothing yet)

---

## [1.0.0] - 2026-06-15

### Added
- Initial release
- Filesystem tools (10): read, write, list, create, delete, move, copy, stat, working dir
- Shell tools (6): execute command, background sessions, read/kill output
- Git tools (10): status, diff, log, add, commit, branch, checkout, push, pull, clone
- Search tools (3): glob, grep with context, find definitions
- Edit tools (5): string replace, insert line, replace lines, append, prepend
- Web tools (2): DuckDuckGo search, fetch + strip HTML
- Task tools (7): todo tracking with file persistence
- Scratchpad tools (3): short-term notes, named pads, append/overwrite
- Persistent memory tools (11): read, save, search, sections, categorize, tidy, context status
- Skills tools (3): list, load, install from GitHub
- Tool alias normalization layer for common model hallucinations
- Bundled skills: code-review, docx, frontend-design, mcp-builder, react-best-practices, shadcn-ui, static-analysis, web-design-guidelines

### Notes
- Consolidated from qwen3-mcp (core tools) + mnemonic-mcp (memory system)
- Plain JavaScript, no build step
- No TypeScript, no extra runtime dependencies beyond @modelcontextprotocol/sdk and glob
