# lm-workbench

All-in-one MCP server for LM Studio. File ops, bash, git, search, web, tasks, memory, and skills — in a single lightweight toolkit.

One server. ~62 tools. Everything a local LLM agent needs to do real work.

---

## Where it came from

lm-workbench is a consolidation of two separate MCP servers that were running alongside each other in LM Studio:

### qwen3-mcp

The original toolkit, built for driving Qwen3 models locally. Started as a focused file/bash/git server and grew to 18 modules with 100+ tools, pulling in notebook editing, media reading, ComfyUI workflow management, GitHub blog deployment, structured thinking/planning, and more.

It worked, but the tool list got heavy. Every tool definition injected into the prompt adds tokens. For daily coding work, most of those specialized modules sat unused while eating context budget.

### mnemonic-mcp

A separate TypeScript MCP server ([c1hucktay4lors/mnemonic-mcp](https://github.com/c1hucktay4lors/mnemonic-mcp)) — also built here — that added persistent long-term memory. Stored everything in a single markdown file with `## Section` headers, with 11 tools for reading, saving, searching, categorizing, and tidying memory entries. Also included a `context_status` tool that reads LM Studio's own conversation JSON files to report exact token usage.

It was a TypeScript project using the high-level `McpServer` class and zod schemas — clean but another server process, another entry in mcp.json, another set of tool definitions to manage.

The memory logic in this project (`src/tools/memory-mn.js`) is a plain-JS port of that server, preserving the same file format, behavior, and tool names.

### The merge

lm-workbench takes the **core working set** from qwen3-mcp (filesystem, bash, git, search, edit, web, tasks, skills) and **ports the mnemonic server** to plain JS, merging it in as a single module. Result:

- One server instead of two
- One entry in `~/.lmstudio/mcp.json` instead of two
- Same memory file, same scratchpads, same behavior — just fewer moving parts
- ~62 tools instead of ~110+, reducing prompt overhead
- No TypeScript, no build step, no extra dependencies beyond the MCP SDK

The specialized modules (ComfyUI, notebook, media, planning, thinking, interaction, blog, summarize) are **not** included. If you need them, they still exist in the original qwen3-mcp project and can be copied in.

---

## What it does

One stdio MCP server that gives your local LLM agent the full toolchain for autonomous work:

| Module | Tools | What it covers |
|--------|-------|----------------|
| **Filesystem** | 10 | Read, write, list, create, delete, move, copy, stat, working dir |
| **Shell** | 6 | Run commands, background sessions, read/kill output |
| **Git** | 10 | Status, diff, log, add, commit, branch, checkout, push, pull, clone |
| **Search** | 3 | Glob patterns, grep with context, find definitions |
| **Edit** | 5 | String replace, insert line, replace lines, append, prepend |
| **Web** | 2 | DuckDuckGo search, fetch + strip HTML |
| **Tasks** | 7 | Todo tracking with file persistence |
| **Scratchpad** | 3 | Short-term notes that persist between sessions |
| **Memory** | 11 | Long-term memory: read, save, search, sections, categorize, tidy, context status |
| **Skills** | 3 | List, load, and install instruction packages from GitHub |

### Memory system

Two tiers of memory, both file-based:

- **Scratchpad** (`~/.lmstudio-mcp-memory/scratchpad_*.txt`) — quick working notes, planning scratch, intermediate state. Named pads, append or overwrite.
- **Persistent memory** (`~/.mcp-memory/memory.md`) — structured long-term memory in a single markdown file. Sections with `## headers`, keyword-based categorization on save, deduplication, backup rotation, and a `context_status` tool that reads LM Studio's actual conversation files to report real token usage (not estimates).

### Skills system

Skills are instruction packages — a `SKILL.md` file with step-by-step instructions for specialized tasks (document generation, code review, frontend patterns, etc.). They live in a `skills/` directory and the agent loads them on demand via `load_skill`.

Install new skills directly from GitHub:

```
install_skill → "https://github.com/anthropics/skills"
```

### Tool aliases

The server includes a normalization layer that maps common model hallucinations to the correct tool names. If the model calls `edit` instead of `edit_file`, or passes `pattern` instead of `old_string`, the server resolves it. Reduces friction with less capable models.

---

## Setup

```bash
git clone https://github.com/c1hucktay4lors/lm-workbench.git
cd lm-workbench
npm install
```

### LM Studio MCP config

Add to `~/.lmstudio/mcp.json`:

```json
{
  "mcpServers": {
    "lm-workbench": {
      "command": "node",
      "args": ["/path/to/lm-workbench/src/index.js"],
      "cwd": "/path/to/lm-workbench"
    }
  }
}
```

Open a new conversation in LM Studio and the tools appear automatically.

### Environment variables (optional)

| Variable | Purpose | Default |
|----------|---------|---------|
| `WORKING_DIR` | Restrict file operations to a specific directory | `process.cwd()` |
| `MEMORY_FILE_PATH` | Override memory file location | `~/.mcp-memory/memory.md` |
| `LMS_API_BASE` | LM Studio API base URL (for context_status) | `http://localhost:1234` |
| `LMS_CONVERSATIONS_DIR` | LM Studio conversations directory | `~/.lmstudio/conversations` |

---

## Project structure

```
lm-workbench/
├── src/
│   ├── index.js          # MCP server entry point, routing, aliases
│   ├── tools/
│   │   ├── filesystem.js # File read/write/list/delete/move/copy
│   │   ├── bash.js       # Shell commands + background sessions
│   │   ├── git.js        # Git operations
│   │   ├── search.js     # Glob, grep, find-definition
│   │   ├── edit.js       # Precise file editing
│   │   ├── web.js        # Web search + fetch
│   │   ├── tasks.js      # Task/todo management
│   │   ├── memory.js     # Scratchpad (short-term notes)
│   │   ├── memory-mn.js  # Persistent memory + context_status
│   │   └── skills.js     # Skill load/list/install
│   └── utils/
│       └── paths.js      # Path normalization & resolution
├── skills/               # Installed skill packages
│   ├── docx/
│   ├── frontend-design/
│   ├── mcp-builder/
│   ├── react-best-practices/
│   ├── shadcn-ui/
│   ├── static-analysis/
│   └── web-design-guidelines/
├── package.json
├── README.md
└── .gitignore
```

---

## Requirements

- **Node.js ≥ 18** (uses native `fetch`, ESM modules)
- No build step, no TypeScript, no extra runtime dependencies

## What's NOT included

This is deliberately a curated toolkit. The following modules exist in the original qwen3-mcp but are **not** part of lm-workbench:

- Notebook editing (Jupyter)
- Media reading (images, PDFs, screenshots)
- Structured thinking / planning
- User interaction prompts
- Conversation state management
- ComfyUI workflow tools
- GitHub Pages blog
- LLM-powered file summarization

If you need any of these, they're in the source project and can be added as additional modules.

---

## Tested models

Models that have been used with lm-workbench, smallest to largest:

- [Qwen3.5-9B](https://huggingface.co/lmstudio-community/Qwen3.5-9B-GGUF)
- [Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP](https://huggingface.co/DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF)
- [Qwen3.8-27B-Cold-Fusion-GAIN-V1.1-NM-DAU-NEO-MAX-MTP](https://huggingface.co/DavidAU/Qwen3.8-27B-Cold-Fusion-GAIN-V1.1-NM-DAU-NEO-MAX-MTP-GGUF)
- [Qwen3.8-27B](https://huggingface.co/lmstudio-community/Qwen3.8-27B-GGUF)
- [Qwen3.6-40B-Fable-Fusion-6-Core-Deckard-Eleanor-Heretic-Uncensored-NM-DAU-NEO-MAX-MTP](https://huggingface.co/DavidAU/Qwen3.6-40B-Fable-Fusion-6-Core-Deckard-Eleanor-Heretic-Uncensored-NM-DAU-NEO-MAX-MTP-GGUF)

> This list is a living one. If you've run lm-workbench with a model that works well, add it.

---

## License

MIT
