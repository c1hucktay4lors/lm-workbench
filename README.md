# LM Workbench

All-in-one MCP server for LM Studio. File operations, bash, git, search, web, tasks, memory, and skills — in a single toolkit.

## What it is

**LM Workbench** is a consolidation of two MCP toolkits I was using together:

[**marduk191's qwen3-mcp**](https://github.com/marduk191/qwen3_mcp)

and

[**My own mnemonic-mcp**](https://github.com/c1hucktay4lors/mnemonic-mcp)

**qwen3-mcp** provided the core agent tooling used by lm-workbench.

Their toolkit is very robust, but also contained tools I had never used and probably won't with what I do with LLMs, so I wanted to remove them to slim it down.

I created **mnemonic-mcp** to give models I run in LM studio access to a simple, long-term memory storage location and the **ability to read LM Studio's conversation data to report actual context usage** so that the model can determine what to do next with the context it has.

The result of my trimming and additions is a toolkit that has:

- Persistent long-term memory
- Scratchpads for short-term state
- Real LM Studio context-status reporting
- Filesystem, shell, search, editing, web, tasks, and skills (Git via `execute_command`)
- No extra runtime dependencies beyond the MCP SDK
- 53 focused tools instead of ~141 from both toolkits combined

My thinking was: 

**Less tools = less tokens at the beginning = more work done.**

Because running LLMs on your own hardware can be pricey, and I wanted to stretch the GPU power I have as much as possible, while giving the model tools to actually create things, not just tell me how to do it.

## What it does

The following tools are directly pulled from Qwen3-mcp, minus the memory section.

| Module | Tools | What it covers |
|---|---:|---|
| Filesystem | 10 | Read, write, list, create, delete, move, copy, stat, working directory |
| Shell | 6 | Run commands, background sessions, read/kill output |
| Search | 3 | Glob patterns, grep with context, find definitions |
| Edit | 5 | String replace, insert line, replace lines, append, prepend |
| Web | 2 | DuckDuckGo search, fetch + strip HTML |
| Tasks | 7 | Todo tracking with file persistence |
| Scratchpad | 3 | Short-term notes that persist between sessions |
| Memory | 14 | Long-term memory, search, organization, context status, and chat recall |
| Skills | 3 | List, load, and install instruction packages from GitHub |

## Memory system

Two tiers of file-based memory are provided.

### Scratchpad

Short-term working notes for planning, intermediate state, and temporary information.

Stored under:

`~/.lmstudio-mcp-memory/`

### Persistent memory

Structured long-term memory stored in:

`~/.mcp-memory/memory.md`

Memory supports sections, keyword-based categorization, deduplication, backup rotation, searching, and cleanup.

The `context_status` tool reads LM Studio's actual conversation files to report real token usage rather than estimating it (this is a bit spotty on if the model calls it naturally, still working on it. But does work if you tell it to check context status).

### Chat recall

`list_chats`, `read_chat`, and `search_chat` read the same conversation files (~/.lmstudio/conversations/*.conversation.json) and let a model recall previous chats as the **raw user/assistant transcript** — no handoff summary. `list_chats` indexes every stored chat (id, name, date, transcript size, recorded token count). `read_chat` pulls a chat by id/name-fragment/`latest` with three slicing modes: end-anchored (`from: start | end | split`, capped by `max_chars`) or an explicit mid-chat window (`at_chars` + `context_chars`). `search_chat` keyword-searches a chat's transcript and returns hit offsets + snippets, so you can find a specific discussion deep in a long chat and then window around it with `read_chat`. Note: completed tool calls aren't stored in these files (only their success status), so transcripts are inherently user/assistant text only.

## Skills system

Skills are instruction packages containing a `SKILL.md` file with step-by-step instructions for specialized tasks.

They live in the `skills/` directory and can be loaded on demand.

Skills can also be installed directly from GitHub:

```text
install_skill → "https://github.com/anthropics/skills"
```

## Tool aliases

The server includes a normalization layer that maps common model hallucinations to the correct tool names.

For example:

- `edit` → `edit_file`
- `bash` → `execute_command`
- `pattern` → `old_string`

This reduces tool-calling friction with models that occasionally use incorrect tool names or parameter names.

## Setup

Clone the repository:

```bash
git clone https://github.com/c1hucktay4lors/lm-workbench.git
cd lm-workbench
npm install
```

### LM Studio MCP configuration

Add the following to your mcp.json:

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

Replace `/path/to/lm-workbench` with the directory where you cloned the repository.

Open a new conversation in LM Studio and the tools should appear automatically.

## Environment variables

All environment variables are optional.

| Variable | Purpose | Default |
|---|---|---|
| `WORKING_DIR` | Restrict file operations to a specific directory | `process.cwd()` |
| `MEMORY_FILE_PATH` | Override persistent memory location | `~/.mcp-memory/memory.md` |
| `LMS_API_BASE` | LM Studio API base URL | `http://localhost:1234` |
| `LMS_CONVERSATIONS_DIR` | LM Studio conversation directory | `~/.lmstudio/conversations` |

## Project structure

```text
lm-workbench/
├── src/
│   ├── index.js
│   ├── tools/
│   │   ├── filesystem.js
│   │   ├── bash.js
│   │   ├── git.js
│   │   ├── search.js
│   │   ├── edit.js
│   │   ├── web.js
│   │   ├── tasks.js
│   │   ├── memory.js
│   │   ├── memory-mn.js
│   │   └── skills.js
│   └── utils/
│       └── paths.js
├── skills/
│   ├── code-review/
│   ├── docx/
│   ├── frontend-design/
│   ├── mcp-builder/
│   ├── react-best-practices/
│   ├── shadcn-ui/
│   ├── static-analysis/
│   └── web-design-guidelines/
├── package.json
├── package-lock.json
├── README.md
└── .gitignore
```

## Requirements

- Node.js 18+
- LM Studio (have not tried others yet, but I believe most tools will work outside of LM Studio, minus the `context_status` one)
- An MCP-compatible local LLM

No build step is required.

## Tested models

Models that have been used with LM Workbench's OG toolkits, and theoretically should work with this:

- [Qwen3.5-9B](https://huggingface.co/lmstudio-community/Qwen3.5-9B-GGUF)
- [DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP](https://huggingface.co/DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF)
- [DavidAU/Qwen3.8-27B-Cold-Fusion-GAIN-V1.1-NM-DAU-NEO-MAX-MTP](https://huggingface.co/DavidAU/Qwen3.8-27B-Cold-Fusion-GAIN-V1.1-NM-DAU-NEO-MAX-MTP-GGUF)
- [Qwen3.8-27B](https://huggingface.co/lmstudio-community/Qwen3.8-27B-GGUF) (This model at Q4_K_M was what did the majority of the merging in this project, and is the primary test model for it)
- [DavidAU/Qwen3.6-40B-Fable-Fusion-6-Core-Deckard-Eleanor-Heretic-Uncensored-NM-DAU-NEO-MAX-MTP](https://huggingface.co/DavidAU/Qwen3.6-40B-Fable-Fusion-6-Core-Deckard-Eleanor-Heretic-Uncensored-NM-DAU-NEO-MAX-MTP-GGUF)


## License

MIT

## Credits

LM Workbench would not exist in its current form without the work of the projects it was derived from.

- **qwen3-mcp** — https://github.com/marduk191/qwen3_mcp
- **mnemonic-mcp** — https://github.com/c1hucktay4lors/mnemonic-mcp

Credit remains with the original authors for their respective components and ideas.
