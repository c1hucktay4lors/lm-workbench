# Changelog

All notable changes to LM Workbench will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- code-review skill (general-purpose code review methodology: structure, style, security, performance, error handling)
- Chat recall tools in the Memory module: `list_chats` (all stored LM Studio conversations with id, name, date, transcript size), `read_chat` (raw user/assistant transcript by id/name-fragment/`latest`, with `from: start|end|split` end-anchored slicing, a `max_chars` cap, and `at_chars`/`context_chars` mid-chat windows), and `search_chat` (case-insensitive keyword search with hit offsets + snippets for locating discussions deep in a chat)

### Removed
- Git tool module (10 tools: git_status, git_diff, git_log, git_add, git_commit, git_branch, git_checkout, git_push, git_pull, git_clone) and src/tools/git.js. Usage data across real conversations showed 1 dedicated git-tool call vs. ~9 shell `git` calls, and every real-world git command (init -b, -c config, rm --cached, custom --format) required the shell anyway. Saves ~900 tokens of tool schema per message. Git remains fully available via `execute_command`.

### Changed
- README tool count: 60 → 50 focused tools

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
