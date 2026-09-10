// memory-mn.js — plain-JS port of mnemonic-mcp (src/server.ts).
// 14 tools: read_memory, auto_save, save_memory, update_memory, delete_memory,
// search_memory, list_sections, save_to_section, replace_section, tidy_memory,
// context_status, list_chats, read_chat, search_chat.
// Exports flat tool definitions (mnemonicTools) + a dispatcher
// (handleMnemonicTool) matching lm-workbench's low-level Server style.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const BACKUP_RETENTION = 10;

function resolveMemoryPath() {
  // Allow override via env var for custom paths
  if (process.env.MEMORY_FILE_PATH) return process.env.MEMORY_FILE_PATH;

  const homeDir = os.homedir();
  const newDefault = path.join(homeDir, ".mcp-memory", "memory.md");

  // Backward compat: fall back to old XDG-style location if it exists
  const legacyPath = process.env.XDG_DATA_HOME || path.join(homeDir, ".local", "share", "mcp-memory");
  const legacyFile = path.join(legacyPath, "memory.md");

  try { fsSync.accessSync(newDefault); return newDefault; } catch {}
  try { fsSync.accessSync(legacyFile); return legacyFile; } catch {}

  // Neither exists yet — default to the simpler path going forward
  return newDefault;
}

const memoryFilePath = resolveMemoryPath();

// ---------- Smart Categorization ----------

const CATEGORY_RULES = [
  {
    section: "Tech Setup & Hardware",
    keywords: ["keyboard","mouse","monitor","gpu","cpu","ram","phone","tablet","laptop","desktop","pc","hardware","peripheral","device","samsung","iphone","android","windows","linux","macos","arch","kde","plasma","wayland","xorg","steamdeck","nvidia","amd","intel","rx ","geforce","switches","mechanical","logitech","keychron","gaming mouse","screen","display","ssd","nvme","storage","hard drive"],
  },
  {
    section: "Personal Preferences",
    keywords: ["coffee","tea","food","eat","drink","prefer","like ","love ","hate ","dislike","taste","flavor","diet","health","exercise","workout","sleep","schedule","morning routine","bedtime","music taste","movie","movies","show","shows","book","books","anime","genre"],
  },
  {
    section: "Interests & Projects",
    keywords: ["game","gaming","coding","programming","project","hobby","modding","learning","studying","interested in","into ","fan of","play ","watch ","read ","building","creating","developing","research","experiment"],
  },
  {
    section: "Communication Preferences",
    keywords: ["communicate","explain","talk to me","respond","format","style of answer","how you talk","directly","concise","verbose","step-by-step","no fluff","be brief"],
  },
];

// Additional rules for auto_save/smartSaveFact that detect project/identity facts
const AUTO_SAVE_CATEGORY_RULES = [
  ...CATEGORY_RULES,
  {
    section: "Interests & Projects",
    keywords: ["created ","built ","made ","working on","developing ","maintaining ","contributing to","open source","mcp server","tool for","cli tool","script i wrote"],
  },
];

function detectCategory(fact) {
  const lower = fact.toLowerCase();
  let bestMatch = null;
  let maxScore = 0;

  for (const rule of CATEGORY_RULES) {
    const score = rule.keywords.reduce((acc, kw) => acc + (lower.includes(kw) ? 1 : 0), 0);
    if (score > maxScore) { maxScore = score; bestMatch = rule; }
  }

  return maxScore >= 1 ? bestMatch : null;
}

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
}

async function readMemory() {
  try {
    return await fs.readFile(memoryFilePath, "utf-8");
  } catch (e) {
    // "no file yet" is a legitimate empty store; anything else is a real failure
    // that MUST propagate — swallowing it (old behavior) let a later write wipe
    // the whole store with a tiny file.
    if (e && e.code === "ENOENT") return "";
    throw new Error(`Cannot read memory file at ${memoryFilePath}: ${e.message}`);
  }
}

async function writeMemory(content) {
  ensureDirectory(memoryFilePath);
  // Back up the existing non-empty store before overwriting. A read failure
  // other than "file doesn't exist yet" is fatal: writing over an unreadable
  // store would silently destroy it.
  try {
    const existing = await fs.readFile(memoryFilePath, "utf-8");
    if (existing.trim()) createBackup();
  } catch (e) {
    if (!(e && e.code === "ENOENT")) {
      throw new Error(`Refusing to write memory: could not read existing store at ${memoryFilePath}: ${e.message}`);
    }
  }
  // Atomic write: temp file in the same directory, then rename over the target.
  // A crash mid-write can no longer leave a truncated store.
  const dir = path.dirname(memoryFilePath);
  const tmpPath = path.join(dir, `.${path.basename(memoryFilePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, memoryFilePath);
}

async function createBackup() {
  const backupDir = path.join(path.dirname(memoryFilePath), "backups");
  try {
    if (!fsSync.existsSync(backupDir)) await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -4);
    await fs.copyFile(memoryFilePath, path.join(backupDir, `memory-${stamp}.md`));
    const files = (await fs.readdir(backupDir)).filter(f => f.startsWith("memory-") && f.endsWith(".md")).sort();
    while (files.length > BACKUP_RETENTION) await fs.unlink(path.join(backupDir, files.shift()));
  } catch {} // non-fatal
}

function findSection(lines, name) {
  // Returns {start, end} with end EXCLUSIVE (fixed off-by-one from the original
  // mnemonic-mcp server.ts, which dropped the last line of a section on read
  // and mis-placed inserts/replaces for the final section in the file).
  const header = `## ${name}`;
  const s = lines.findIndex(l => l.trim() === header);
  if (s === -1) return null;
  for (let i = s + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) return { start: s, end: i };
  }
  return { start: s, end: lines.length };
}

function listSections(content) {
  return [...content.matchAll(/^##\s+(.+)$/gm)].map(m => m[1].trim());
}

// Block-aware find/replace used by update_memory + delete_memory.
// The old code checked existence with a whole-file `includes()` but edited
// line-by-line, so a MULTI-LINE `find` passed the existence check yet never
// matched any single line → a no-op that still returned "Updated."/"Deleted."
// Here: multi-line finds are replaced at the string level, single-line finds
// keep the line-block semantics, and a no-op is reported as "not found".
function applyFindReplace(content, find, replace) {
  const f = (find == null ? "" : String(find));
  if (!f.trim()) return { ok: false, reason: "empty" };
  const ci = content.toLowerCase().indexOf(f.toLowerCase());
  if (ci === -1) return { ok: false, reason: "notfound" };

  let newContent;
  if (f.includes("\n")) {
    const rep = (replace == null ? "" : String(replace)).trim();
    newContent = content.slice(0, ci) + rep + content.slice(ci + f.length);
  } else {
    const lines = content.split("\n");
    const newLines = [];
    let skipBlock = false;
    let hit = false;
    for (const line of lines) {
      if (skipBlock && !line.trim()) { skipBlock = false; continue; }
      if (!skipBlock && line.toLowerCase().includes(f.toLowerCase())) {
        if (replace != null && String(replace).trim()) newLines.push(String(replace).trim());
        hit = true;
        skipBlock = true;
        continue;
      }
      if (!skipBlock || line.trim()) newLines.push(line);
    }
    if (!hit) return { ok: false, reason: "notfound" };
    newContent = newLines.join("\n");
  }
  return { ok: true, newContent: newContent.replace(/\n{3,}/g, "\n\n") };
}

async function smartSaveFact(fact, content) {
  const trimmedFact = fact.trim();

  // Dedup check
  if (content.toLowerCase().includes(trimmedFact.slice(0, 50).toLowerCase())) {
    return { saved: false };
  }

  // Use extended rules for auto-save to catch project/identity facts better
  const lower = trimmedFact.toLowerCase();
  let bestMatch = null;
  let maxScore = 0;

  for (const rule of AUTO_SAVE_CATEGORY_RULES) {
    const score = rule.keywords.reduce((acc, kw) => acc + (lower.includes(kw) ? 1 : 0), 0);
    if (score > maxScore) { maxScore = score; bestMatch = rule; }
  }

  if (maxScore >= 1 && bestMatch) {
    // Route to appropriate section using save_to_section logic inline
    const lines = content.split("\n");
    const range = findSection(lines, bestMatch.section);

    let newContent;
    if (!range) {
      // Create new section at end of file
      newContent = content.trimEnd() + `\n\n## ${bestMatch.section}\n- ${trimmedFact}`;
    } else {
      const before = lines.slice(0, range.end).join("\n");
      const after = lines.slice(range.end).join("\n");
      // Append the bullet at the end of the section and ALWAYS keep a blank
      // line before whatever follows (the next ## header). The old code did
      // `... - fact` + after, gluing the fact onto the next header line
      // ("- fact## NextSection") and corrupting the file structure.
      newContent = before.trimEnd() + `\n\n- ${trimmedFact}` + (after.trim() ? `\n\n` + after : "");
    }

    await writeMemory(newContent);
    return { saved: true, target: bestMatch.section };
  }

  // No confident match — fall back to dated entry at bottom
  const date = new Date().toISOString().split("T")[0];
  await writeMemory(content.trimEnd() + `\n\n[${date}] ${trimmedFact}`);
  return { saved: true, target: "dated entry" };
}

// ---------- Tool definitions (flat, JSON-schema style) ----------

export const mnemonicTools = [
  {
    name: "read_memory",
    description: "Read persistent memory. Use list_sections first if unsure where info is stored, then read that section directly.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description: "Section name to read (e.g., 'Tech Setup & Hardware'). Omit for full memory.",
        },
      },
    },
  },
  {
    name: "auto_save",
    description: "Silently save information about me worth remembering long-term. Call this proactively during conversations when I reveal preferences, facts, corrections, or project state — don't announce you're doing it unless asked.",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact to remember." },
      },
      required: ["fact"],
    },
  },
  {
    name: "save_memory",
    description: "Explicitly save a fact to memory when asked directly. Automatically categorizes into appropriate section.",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact to remember." },
      },
      required: ["fact"],
    },
  },
  {
    name: "update_memory",
    description: "Find and replace existing memory. Pass exact text to find.",
    inputSchema: {
      type: "object",
      properties: {
        find: { type: "string", description: "Existing text in memory to find." },
        replace: { type: "string", description: "New text, or empty/omit to delete." },
      },
      required: ["find"],
    },
  },
  {
    name: "delete_memory",
    description: "Delete something from memory. Provide a unique fragment.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "A distinctive part of the entry to delete." },
      },
      required: ["text"],
    },
  },
  {
    name: "search_memory",
    description: "Search for specific info in memory. Uses keyword matching across all entries.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_sections",
    description: "List all named sections in memory. Use this when you're unsure where info might be stored.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "save_to_section",
    description: "Add info to a categorized section. Creates it if needed.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "Section name without ##. E.g., 'Health & Wellness', 'Tech Setup'." },
        content: { type: "string", description: "Content to add." },
      },
      required: ["section", "content"],
    },
  },
  {
    name: "replace_section",
    description: "Replace ALL content in a named section.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "Exact name of existing section (no ##)." },
        new_content: { type: "string", description: "Full replacement." },
      },
      required: ["section", "new_content"],
    },
  },
  {
    name: "tidy_memory",
    description: "Organize standalone dated entries into appropriate sections. Use this when memory.md has many orphaned entries that could be categorized.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "context_status",
    description:
      "Check current LM Studio context-window usage for this conversation. Returns the authoritative context limit (from LM Studio), exact tokens used at the last generation step (read from LM Studio's own records, counted by llama.cpp's tokenizer), remaining tokens, percentage used, and a status level (NORMAL/WARNING/CRITICAL/EMERGENCY). Call this periodically during long tasks — especially before heavy work or when unsure if you can continue. On WARNING+ write/update your task checkpoint via Mnemonic-MCP; on CRITICAL/EMERGENCY create a full handoff immediately.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_chats",
    description:
      "List all stored LM Studio conversations (from ~/.lmstudio/conversations): id, name, creation date, message count, and full-transcript size (chars + rough token estimate, plus LM Studio's own recorded token count). Use this to find a previous chat, then pull its content with read_chat. The 'current' chat is the most recently modified file.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "read_chat",
    description:
      "Read the raw user/assistant transcript of a stored LM Studio conversation (no summary — the actual words that were said). Locate the chat with list_chats, then pass its id (or a unique name fragment, or 'latest'). Slicing: from controls end-anchored slices ('start' oldest, 'end' newest, 'split' half from each end — default), capped by max_chars (default 20000). For mid-chat windows (e.g. around a search_chat hit), pass at_chars (character offset) + context_chars (window size, default 20000). Tool calls are not part of these files (LM Studio keeps only their success status).",
    inputSchema: {
      type: "object",
      properties: {
        chat: {
          type: "string",
          description: "Chat id from list_chats (e.g. '1788900202315'), a unique fragment of its name, or 'latest' for the most recently modified chat.",
        },
        max_chars: {
          type: "number",
          description: "Maximum characters of transcript to return (default 20000, hard cap 500000). Raise it to pull more of the chat.",
        },
        from: {
          type: "string",
          enum: ["start", "end", "split"],
          description: "Which part to return: 'start' = oldest messages, 'end' = newest messages, 'split' = half from each end (default). Ignored when at_chars is given.",
        },
        at_chars: {
          type: "number",
          description: "Character offset in the transcript to center a window on (e.g. a hit offset from search_chat). Overrides from/max_chars when given.",
        },
        context_chars: {
          type: "number",
          description: "Window size in characters around at_chars (default 20000, hard cap 500000).",
        },
      },
      required: ["chat"],
    },
  },
  {
    name: "search_chat",
    description:
      "Keyword-search the transcript of a stored LM Studio conversation (case-insensitive substring). Returns total hit count, the first N hits (max_hits, default 10) with their character offsets and a short snippet around each. Use the offsets with read_chat(at_chars: <offset>, context_chars: <window>) to pull the surrounding discussion. This is how you find things in the MIDDLE of a long chat.",
    inputSchema: {
      type: "object",
      properties: {
        chat: {
          type: "string",
          description: "Chat id from list_chats, a unique fragment of its name, or 'latest'.",
        },
        query: {
          type: "string",
          description: "Substring to search for (case-insensitive).",
        },
        max_hits: {
          type: "number",
          description: "How many hits to return (default 10, max 50).",
        },
        context_chars: {
          type: "number",
          description: "Snippet characters on each side of a match (default 250, max 2000).",
        },
      },
      required: ["chat", "query"],
    },
  },
];

// ---------- Context Window Monitoring ----------
//
// Reports the REAL context usage of the active LM Studio conversation using
// data that LM Studio itself writes — not estimates:
//   - LIMIT (authoritative): GET {LMS_API_BASE}/api/v0/models -> loaded model's
//     `loaded_context_length` (what llama.cpp actually allocated).
//   - USED (exact, one step behind): newest ~/.lmstudio/conversations/*.conversation.json,
//     last genInfo.stats.promptTokensCount — the exact prompt token count written by
//     LM Studio from llama.cpp's tokenizer after each generation.
// Note: reflects the last COMPLETED generation; the in-flight tool round-trip adds a small delta.

const LMS_API_BASE = process.env.LMS_API_BASE || "http://localhost:1234";
const CONVERSATIONS_DIR =
  process.env.LMS_CONVERSATIONS_DIR || path.join(os.homedir(), ".lmstudio", "conversations");

const CTX_THRESHOLDS = { WARNING: 60, CRITICAL: 85, EMERGENCY: 95 };

async function lmsGetJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function findConversationFiles(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findConversationFiles(full)));
    else if (e.isFile() && e.name.endsWith(".conversation.json")) out.push(full);
  }
  return out;
}

async function findActiveConversation() {
  const files = await findConversationFiles(CONVERSATIONS_DIR);
  if (!files.length) return null;

  const withStat = [];
  for (const f of files) {
    try {
      const st = await fs.stat(f);
      withStat.push({ filePath: f, mtimeMs: st.mtimeMs });
    } catch {}
  }
  if (!withStat.length) return null;
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Newest first; skip files that fail to parse (mid-write or corrupt)
  for (const cand of withStat.slice(0, 5)) {
    try {
      const raw = await fs.readFile(cand.filePath, "utf-8");
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.messages)) {
        return { filePath: cand.filePath, mtimeMs: cand.mtimeMs, data };
      }
    } catch {}
  }
  return null;
}

function extractLatestPromptTokens(data) {
  let latest = null;

  const visitStep = (step) => {
    if (!step || typeof step !== "object") return;
    const stats = step.genInfo?.stats;
    if (stats && Number.isFinite(stats.promptTokensCount)) latest = stats.promptTokensCount;
  };

  for (const msg of data.messages ?? []) {
    const versions = Array.isArray(msg.versions) ? msg.versions : [msg];
    for (const v of versions) {
      if (!v || typeof v !== "object") continue;
      if (Array.isArray(v.steps)) { for (const s of v.steps) visitStep(s); }
      else visitStep(v); // singleStep: the version itself is a step
    }
  }

  return latest;
}

function ctxRecommendation(status, pct) {
  switch (status) {
    case "EMERGENCY":
      return `CONTEXT NEARLY FULL (${pct.toFixed(1)}%). Immediately: (1) write a COMPLETE handoff checkpoint to Mnemonic-MCP via save_to_section/replace_section — task goal, current state, exact next steps, key file paths, decisions made; (2) finish the current step minimally and stop expanding context. The user can resume from your checkpoint in a fresh chat.`;
    case "CRITICAL":
      return `Context at ${pct.toFixed(1)}%. Write/update your task checkpoint in Mnemonic-MCP NOW if not done recently, then continue with minimal verbosity: avoid re-reading large files, prefer targeted reads (offset/limit), keep responses concise.`;
    case "WARNING":
      return `Context at ${pct.toFixed(1)}%. Start preserving state: write/update your task checkpoint in Mnemonic-MCP and be economical — use offset/limit on file reads, avoid redundant listings, summarize instead of dumping large outputs.`;
    default:
      return `Context healthy (${pct.toFixed(1)}%). For long tasks, call context_status again at natural checkpoints (every few major steps) so you can checkpoint via Mnemonic-MCP before running low.`;
  }
}

// ---------- Conversation Recall ----------
//
// Reads the stored LM Studio conversation files (the same ones context_status
// uses) and reconstructs the raw user/assistant transcript.
//
// File anatomy (verified against live files, LM Studio 0.3.x):
//   data.messages[]            — one entry per chat message
//     .versions[]              — regenerations; .currentlySelected picks the visible one
//       .role                  — "user" | "assistant"
//       user:      { type:"singleStep", content:[blocks] }
//       assistant: { type:"multiStep",  steps:[ {type:"contentBlock", content:[blocks]} |
//                                            {type:"toolStatus", ...} ] }
//     blocks: { type:"text", text:"..." } (non-text blocks are skipped)
//
// Note: completed tool calls are stored only as success/failure status — their
// names/arguments are NOT in the file, so transcripts are inherently
// user/assistant text only.

const CHARS_PER_TOKEN_EST = 3.5; // rough, for display estimates only
const READ_CHAT_MAX_CAP = 500000; // hard cap: ~140k tokens of transcript

function extractTranscript(data) {
  const turns = [];
  for (const msg of data.messages ?? []) {
    const versions = Array.isArray(msg.versions) ? msg.versions : [msg];
    if (!versions.length) continue;
    const sel = Number.isInteger(msg.currentlySelected) && msg.currentlySelected >= 0
      ? msg.currentlySelected
      : 0;
    const v = versions[sel] ?? versions[0];
    if (!v || typeof v !== "object") continue;
    const role = v.role;
    if (role !== "user" && role !== "assistant") continue;

    const parts = [];
    const seen = new Set();
    const walk = (o) => {
      if (!o || typeof o !== "object" || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (o.type === "text" && typeof o.text === "string" && o.text.trim()) {
        parts.push(o.text.trim());
        return;
      }
      if (o.type === "contentBlock" || o.type === "singleStep" || o.type === "multiStep") {
        if (o.content) walk(o.content);
        if (o.steps) walk(o.steps);
        return;
      }
      // Fallback: descend (finite JSON; toolStatus payloads contain no text blocks)
      for (const val of Object.values(o)) walk(val);
    };
    walk(v.content ?? v);

    const text = parts.join("\n\n");
    if (text) turns.push({ role, text });
  }
  return turns;
}

function chatDisplayName(data, fallback) {
  if (typeof data.name === "string" && data.name.trim()) return data.name.trim();
  for (const m of data.messages ?? []) {
    for (const v of m.versions ?? []) {
      if (v.role === "user") {
        const t = extractTranscript({ messages: [m] })[0]?.text;
        if (t) return t.split("\n")[0].slice(0, 80);
      }
    }
  }
  return fallback;
}

function fmtChars(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

async function loadAllChats() {
  const files = await findConversationFiles(CONVERSATIONS_DIR);
  const out = [];
  for (const filePath of files) {
    let stat;
    try { stat = await fs.stat(filePath); } catch { continue; }
    const id = path.basename(filePath).replace(/\.conversation\.json$/, "");
    let data = null, name = null, chars = 0, msgCount = 0, recorded = null;
    try {
      data = JSON.parse(await fs.readFile(filePath, "utf-8"));
      if (!data || !Array.isArray(data.messages)) continue;
      msgCount = data.messages.length;
      if (typeof data.tokenCount === "number") recorded = data.tokenCount;
      name = chatDisplayName(data, id);
      chars = extractTranscript(data).reduce((acc, t) => acc + t.text.length + t.role.length + 5, 0);
    } catch { /* mid-write or corrupt file — still list it, marked unreadable */ }
    out.push({
      filePath, id, name,
      createdAt: data?.createdAt ? Number(data.createdAt) : null,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      msgCount, chars,
      estTokens: Math.round(chars / CHARS_PER_TOKEN_EST),
      recorded,
      readable: data != null,
    });
  }
  out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  return out;
}

function fmtDate(ms) {
  if (!ms) return "unknown date";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function resolveChat(query) {
  const chats = await loadAllChats();
  if (!chats.length) {
    return { error: `No conversation files found in ${CONVERSATIONS_DIR}.` };
  }
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return { error: "chat argument is empty — pass an id, a name fragment, or 'latest'." };

  if (q === "latest") return { chat: chats[0] };
  const exact = chats.filter((c) => c.id === q);
  if (exact.length === 1) return { chat: exact[0] };
  if (exact.length > 1) return { error: `Multiple chats share id fragment '${query}' — use the full id: ${exact.map((c) => c.id).join(", ")}` };

  const byName = chats.filter((c) => (c.name ?? "").toLowerCase().includes(q));
  const byIdPrefix = chats.filter((c) => c.id.startsWith(q));
  const matches = byName.length ? byName : byIdPrefix;

  if (matches.length === 1) return { chat: matches[0] };
  if (matches.length > 1) {
    return {
      error:
        `Ambiguous chat '${query}' — matches ${matches.length} chats:\n` +
        matches.map((c) => `  ${c.id}  ${fmtDate(c.createdAt)}  ${c.name}`).join("\n") +
        "\nPass the full id or a more specific fragment.",
    };
  }
  return {
    error:
      `No chat matching '${query}'. Available chats:\n` +
      chats.map((c) => `  ${c.id}  ${fmtDate(c.createdAt)}  ${c.name}`).join("\n"),
  };
}

async function handleListChats() {
  const chats = await loadAllChats();
  if (!chats.length) {
    return { content: [{ type: "text", text: `No conversation files found in ${CONVERSATIONS_DIR}.` }] };
  }
  const lines = [
    `STORED CHATS (${chats.length}) — newest first. Read one with read_chat (pass its id or a name fragment).`,
    "─".repeat(70),
    `${"id".padEnd(15)}${"created".padEnd(18)}${"msgs".padEnd(6)}${"transcript".padEnd(17)}${"recorded".padEnd(12)}name`,
  ];
  for (const c of chats) {
    lines.push(
      [
        c.id.padEnd(15),
        fmtDate(c.createdAt).padEnd(18),
        String(c.msgCount).padEnd(6),
        (c.readable ? `${fmtChars(c.chars)}ch/~${fmtChars(c.estTokens)}tok` : "unreadable").padEnd(17),
        (c.recorded != null ? `${fmtChars(c.recorded)}tok` : "—").padEnd(12),
        (c.name ?? "(unnamed)") + (c.mtimeMs === chats[0].mtimeMs ? "  ← most recent" : ""),
      ].join("")
    );
  }
  lines.push("─".repeat(70));
  lines.push("transcript = raw user/assistant text size (tool calls are not stored). recorded = LM Studio's last counted prompt tokens for that chat.");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleReadChat(args = {}) {
  const { error, chat } = await resolveChat(args.chat);
  if (error) return { content: [{ type: "text", text: `read_chat: ${error}` }] };
  if (!chat.readable) {
    return { content: [{ type: "text", text: `read_chat: chat ${chat.id} exists (${chat.name}) but its file couldn't be parsed right now (mid-write or corrupt). Try again in a moment.` }] };
  }

  let data;
  try {
    data = JSON.parse(await fs.readFile(chat.filePath, "utf-8"));
  } catch (e) {
    return { content: [{ type: "text", text: `read_chat: failed to read ${chat.filePath}: ${e.message}` }] };
  }

  const turns = extractTranscript(data);
  const full = turns.map((t) => `### ${t.role}\n${t.text}`).join("\n\n");

  let maxChars = Number(args.max_chars);
  if (!Number.isFinite(maxChars) || maxChars < 1000) maxChars = 20000;
  const capped = maxChars > READ_CHAT_MAX_CAP;
  maxChars = Math.min(maxChars, READ_CHAT_MAX_CAP);

  const from = ["start", "end", "split"].includes(args.from) ? args.from : "split";
  const atChars = Number(args.at_chars);

  let body, showing;
  if (Number.isFinite(atChars) && atChars >= 0 && full.length > maxChars) {
    // Window centered on an explicit offset (e.g. a search_chat hit)
    let win = Number(args.context_chars);
    if (!Number.isFinite(win) || win < 1000) win = 20000;
    win = Math.min(win, READ_CHAT_MAX_CAP);
    const start = Math.max(0, Math.min(Math.floor(atChars - win / 2), full.length - win));
    body = full.slice(start, start + win);
    showing = `chars ${start}–${start + win} (window of ${win} centered on offset ${Math.floor(atChars)})`;
  } else if (full.length <= maxChars) {
    body = full;
    showing = `FULL transcript (${full.length} chars)`;
  } else if (from === "start") {
    body = full.slice(0, maxChars);
    showing = `first ${maxChars} chars (oldest messages) — the rest is omitted`;
  } else if (from === "end") {
    body = full.slice(full.length - maxChars);
    showing = `last ${maxChars} chars (newest messages) — the earlier part is omitted`;
  } else {
    const half = Math.floor(maxChars / 2);
    const omitted = full.length - half * 2;
    body =
      full.slice(0, half) +
      `\n\n[... ${omitted} chars omitted from the middle — call read_chat again with from:"start" or from:"end" (or a larger max_chars) to get the rest ...]\n\n` +
      full.slice(full.length - half);
    showing = `first ${half} + last ${half} chars (split) of ${full.length}`;
  }

  if (!body.trim()) {
    return { content: [{ type: "text", text: `read_chat: chat ${chat.id} (${chat.name}) has no user/assistant text content.` }] };
  }

  const header = [
    `CHAT RECALL — "${chat.name}"`,
    `id: ${chat.id} | created: ${fmtDate(chat.createdAt)} | messages: ${chat.msgCount}`,
    `full transcript: ${full.length} chars (~${fmtChars(Math.round(full.length / CHARS_PER_TOKEN_EST))} tokens)${chat.recorded != null ? ` | last recorded prompt size: ${chat.recorded} tokens` : ""}`,
    typeof data.systemPrompt === "string" && data.systemPrompt.trim()
      ? `system prompt used: ${data.systemPrompt.trim().slice(0, 200)}${data.systemPrompt.trim().length > 200 ? "… (truncated)" : ""}`
      : "system prompt used: (none)",
    `showing: ${showing}`,
    "note: tool calls are not stored in these files (only their success status) — this is the complete user/assistant exchange.",
    "─".repeat(70),
  ];
  return { content: [{ type: "text", text: [...header, body].join("\n") }] };
}

function searchTranscript(text, query, maxHits, contextChars) {
  const needle = String(query).trim().toLowerCase();
  if (!needle) return { total: 0, hits: [], error: "empty query" };
  const hay = text.toLowerCase();
  const step = Math.max(needle.length, 1);
  const hits = [];
  let total = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    total++;
    if (hits.length < maxHits) {
      const a = Math.max(0, i - contextChars);
      const b = Math.min(text.length, i + needle.length + contextChars);
      const snippet =
        (a > 0 ? "… " : "") +
        text.slice(a, b).replace(/\s+/g, " ") +
        (b < text.length ? " …" : "");
      hits.push({ offset: i, snippet });
    }
    if (total >= 100000) break; // safety valve for tiny needles
    i = hay.indexOf(needle, i + step);
  }
  return { total, hits };
}

async function handleSearchChat(args = {}) {
  const { error, chat } = await resolveChat(args.chat);
  if (error) return { content: [{ type: "text", text: `search_chat: ${error}` }] };
  if (!chat.readable) {
    return { content: [{ type: "text", text: `search_chat: chat ${chat.id} (${chat.name}) couldn't be parsed right now (mid-write or corrupt).` }] };
  }
  const query = String(args.query ?? "").trim();
  if (!query) return { content: [{ type: "text", text: "search_chat: 'query' is required." }] };

  let maxHits = Number(args.max_hits);
  if (!Number.isFinite(maxHits) || maxHits < 1) maxHits = 10;
  maxHits = Math.min(maxHits, 50);
  let ctx = Number(args.context_chars);
  if (!Number.isFinite(ctx) || ctx < 20) ctx = 250;
  ctx = Math.min(ctx, 2000);

  let data;
  try {
    data = JSON.parse(await fs.readFile(chat.filePath, "utf-8"));
  } catch (e) {
    return { content: [{ type: "text", text: `search_chat: failed to read ${chat.filePath}: ${e.message}` }] };
  }
  const full = extractTranscript(data).map((t) => `### ${t.role}\n${t.text}`).join("\n\n");

  const { total, hits } = searchTranscript(full, query, maxHits, ctx);
  if (total === 0) {
    return { content: [{ type: "text", text: `search_chat: no occurrences of '${query}' in "${chat.name}" (${chat.id}, ${full.length} chars).` }] };
  }

  const lines = [
    `SEARCH — '${query}' in "${chat.name}" (${chat.id})`,
    `${total} total hit${total > 1 ? "s" : ""} — showing ${hits.length}`,
    "─".repeat(70),
  ];
  hits.forEach((h, n) => {
    lines.push(`[${n + 1}] @${h.offset}`);
    lines.push(`    ${h.snippet}`);
    lines.push("");
  });
  if (total > hits.length) lines.push(`${total - hits.length} more hit(s) not shown — raise max_hits (cap 50).`);
  lines.push(`Read a window around a hit: read_chat(chat: "${chat.id}", at_chars: <offset>, context_chars: 4000–10000)`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------- Dispatcher ----------

export async function handleMnemonicTool(name, args = {}) {
  // Catch-all: any thrown error (I/O failure on the store, unknown tool, ...)
  // becomes a readable tool result instead of crashing the server. For the
  // write paths the error is raised *before* writeMemory is reached, so a
  // failed read can never turn into a full-store wipe.
  try {
    return await dispatchMnemonicTool(name, args);
  } catch (e) {
    return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
  }
}

async function dispatchMnemonicTool(name, args = {}) {
  switch (name) {
    case "read_memory": {
      let content = await readMemory();
      if (!content.trim()) return { content: [{ type: "text", text: "Memory is empty." }] };

      if (args.section?.trim()) {
        const lines = content.split("\n");
        const range = findSection(lines, args.section.trim());
        if (!range) {
          const sections = listSections(content);
          return { content: [{ type: "text", text: `Section '${args.section}' not found. Available: ${sections.length ? sections.join(", ") : "(none)"}.` }] };
        }
        const body = lines.slice(range.start, range.end).join("\n").trim();
        return { content: [{ type: "text", text: body || `Section '${args.section}' is empty.` }] };
      }

      let result = content;
      if (content.length > 8000) {
        const entries = (content.match(/^\[\d{4}-\d{2}-\d{2}\]/gm) || []).length;
        result += `\n\n[Memory note: ${content.length} chars, ${entries} entries. Consider consolidating.]`;
      }
      return { content: [{ type: "text", text: result }] };
    }

    case "auto_save": {
      const content = await readMemory();
      const result = await smartSaveFact(args.fact, content);

      if (!result.saved) {
        return { content: [{ type: "text", text: "" }] }; // silent skip
      }

      // Silent — no announcement needed. Model can optionally log internally.
      const targetStr = result.target ? ` (to ${result.target})` : "";
      return { content: [{ type: "text", text: targetStr }] };
    }

    case "save_memory": {
      const content = await readMemory();
      const result = await smartSaveFact(args.fact, content);

      if (!result.saved) {
        return { content: [{ type: "text", text: "Skipped — similar info exists. Use update_memory to change it." }] };
      }

      const where = result.target ? ` (to ${result.target})` : "";
      return { content: [{ type: "text", text: "Saved." + where }] };
    }

    case "update_memory": {
      const content = await readMemory();
      const isDelete = !args.replace?.trim();
      const res = applyFindReplace(content, args.find, args.replace);
      if (!res.ok) {
        return { content: [{ type: "text", text: "Not found in memory." }] };
      }
      await writeMemory(res.newContent);
      return { content: [{ type: "text", text: isDelete ? "Deleted." : "Updated." }] };
    }

    case "delete_memory": {
      const content = await readMemory();
      const res = applyFindReplace(content, args.text, "");
      if (!res.ok) {
        return { content: [{ type: "text", text: "Not found." }] };
      }
      await writeMemory(res.newContent);
      return { content: [{ type: "text", text: "Deleted." }] };
    }

    case "search_memory": {
      const content = await readMemory();
      if (!content.trim()) return { content: [{ type: "text", text: "Empty." }] };

      // Tokenize into meaningful words (skip short stop words)
      const stopWords = new Set(["a","an","the","is","are","was","were","to","for","of","in","on","at","by","with","and","or","but","it","my","me","you","your","has","have","had","do","does","did","be","been","being"]);
      const tokens = args.query.toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));

      if (!tokens.length) return { content: [{ type: "text", text: `No meaningful search terms in "${args.query}".` }] };

      const matches = [];
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        // Line matches if it contains at least one search token
        if (!tokens.some(t => lineLower.includes(t))) continue;

        let block = "";
        for (let j = i; j < lines.length && lines[j].trim(); j++) block += (block ? "\n" : "") + lines[j];
        if (!matches.includes(block)) matches.push(block);
      }

      if (!matches.length) return { content: [{ type: "text", text: `No matches for "${args.query}".` }] };
      const result = `Found ${matches.length} match${matches.length > 1 ? "es" : ""}:\n\n${matches.map((m, i) => `${i + 1}. ${m}`).join("\n\n")}`;
      return { content: [{ type: "text", text: result }] };
    }

    case "list_sections": {
      const content = await readMemory();
      if (!content.trim()) return { content: [{ type: "text", text: "Memory is empty." }] };

      // Find section headers and any standalone dated entries not under a section
      const sections = listSections(content);
      const hasStandaloneEntries = /^\[\d{4}-\d{2}-\d{2}\]/m.test(content) && !content.startsWith("##");

      let result = `Sections in memory:\n`;
      for (const s of sections) result += `- ${s}\n`;
      if (hasStandaloneEntries) result += `- (standalone dated entries)\n`;

      return { content: [{ type: "text", text: result.trim() }] };
    }

    case "save_to_section": {
      const fileContent = await readMemory();
      const lines = fileContent.split("\n");
      const trimmedSection = args.section.trim();
      const trimmedContent = args.content.trim();

      const range = findSection(lines, trimmedSection);

      if (!range) {
        await writeMemory(fileContent.trimEnd() + `\n\n## ${trimmedSection}\n${trimmedContent}`);
        return { content: [{ type: "text", text: `Created '${trimmedSection}' and added content.` }] };
      } else {
        const before = lines.slice(0, range.end).join("\n");
        const after = lines.slice(range.end).join("\n");
        // Same gluing guard as smartSaveFact: keep a blank line before the next
        // ## header so the appended content never fuses onto it.
        await writeMemory(before.trimEnd() + `\n${trimmedContent}` + (after.trim() ? `\n\n` + after : ""));
      }

      return { content: [{ type: "text", text: `Added to '${trimmedSection}'.` }] };
    }

    case "replace_section": {
      const fileContent = await readMemory();
      const lines = fileContent.split("\n");
      const range = findSection(lines, args.section);

      if (!range) return { content: [{ type: "text", text: `Section '${args.section}' not found. Use save_to_section to create it.` }] };

      const newLines = [...lines.slice(0, range.start), lines[range.start], "", args.new_content.trim(), "", ...lines.slice(range.end)];
      await writeMemory(newLines.join("\n"));
      return { content: [{ type: "text", text: `Replaced '${args.section}'.` }] };
    }

    case "tidy_memory": {
      const content = await readMemory();
      if (!content.trim()) return { content: [{ type: "text", text: "Nothing to tidy." }] };

      const lines = content.split("\n");
      const DATED_RE = /^\[(\d{4}-\d{2}-\d{2})\]\s+(.+)$/;

      // Collect standalone dated entries, INCLUDING any indented continuation
      // lines (wrapped entries) so they move as one unit and are never orphaned.
      const entries = []; // { lineNum, date, fact, cont: [line indices] }
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(DATED_RE);
        if (!m) continue;
        const fact = m[2].trim();
        const date = m[1];
        const cont = [];
        let j = i + 1;
        while (j < lines.length) {
          const l = lines[j];
          if (!l.trim()) break;             // blank line ends the entry
          if (l.trim().startsWith("#")) break; // next header
          if (l === l.trimStart()) break;   // not indented → not a continuation
          cont.push(j);
          j++;
        }
        entries.push({ lineNum: i, date, fact, cont });
      }

      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No standalone dated entries found to organize." }] };
      }

      // Categorize each entry (using fact + continuations for a fairer match).
      const moves = {};        // section -> [lines to insert]
      const sectionCount = {}; // section -> number of entries moved there
      const uncategorized = [];
      const removedIdx = new Set(); // ONLY lines of entries we actually move

      for (const entry of entries) {
        const fullText = [entry.fact, ...entry.cont.map(c => lines[c].trim())].join(" ");
        const category = detectCategory(fullText);
        if (category) {
          if (!moves[category.section]) moves[category.section] = [];
          moves[category.section].push(`- ${entry.fact}`);
          for (const c of entry.cont) moves[category.section].push(lines[c]);
          sectionCount[category.section] = (sectionCount[category.section] || 0) + 1;
          removedIdx.add(entry.lineNum);
          for (const c of entry.cont) removedIdx.add(c);
        } else {
          // UNCLASSIFIED → stays exactly where it was. The old code deleted
          // every dated line and only re-inserted the classified ones, so
          // these were silently destroyed (and the summary lied about it).
          uncategorized.push(entry);
        }
      }

      // Nothing classifiable — don't rewrite (avoid a needless backup), be honest.
      if (Object.keys(moves).length === 0) {
        return { content: [{ type: "text", text:
          `Nothing to move: ${uncategorized.length} dated entry${uncategorized.length > 1 ? "ies" : ""} couldn't be categorized confidently and were left in place.` }] };
      }

      // Build new content: keep everything except the moved entries' lines.
      let resultContent = lines.filter((_, i) => !removedIdx.has(i)).join("\n");

      // Insert each classified group into its target section (existing or new),
      // always keeping a blank line before any following ## header.
      for (const [section, factLines] of Object.entries(moves)) {
        const rlines = resultContent.split("\n");
        const range = findSection(rlines, section);
        if (range) {
          const before = rlines.slice(0, range.end).join("\n");
          const after = rlines.slice(range.end).join("\n");
          resultContent = before.trimEnd() + "\n" + factLines.join("\n") + (after.trim() ? "\n\n" + after : "");
        } else {
          resultContent = resultContent.trimEnd() + `\n\n## ${section}\n` + factLines.join("\n");
        }
      }

      resultContent = resultContent.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
      await writeMemory(resultContent);

      const movedCount = Object.values(sectionCount).reduce((a, b) => a + b, 0);
      const summaryLines = [`Tidied ${entries.length} standalone dated entr${entries.length > 1 ? "ies" : "y"} (${movedCount} moved, ${uncategorized.length} kept in place).`];
      for (const [section] of Object.entries(moves)) {
        summaryLines.push(`→ Moved ${sectionCount[section]} to "${section}"`);
      }
      if (uncategorized.length > 0) {
        summaryLines.push(`→ Kept ${uncategorized.length} as dated entries (couldn't categorize confidently — left in place, nothing deleted)`);
      }
      return { content: [{ type: "text", text: summaryLines.join("\n") }] };
    }

    case "context_status": {
      // --- 1. Context limit from LM Studio API (authoritative) ---
      let loadedModels;
      try {
        const data = await lmsGetJson(`${LMS_API_BASE}/api/v0/models`);
        loadedModels = (data.data ?? []).filter((m) => m.state === "loaded");
      } catch (e) {
        return { content: [{ type: "text", text: `context_status ERROR: cannot reach LM Studio API at ${LMS_API_BASE} (${e.message}). Is the server running?` }] };
      }

      // --- 2. Active conversation + exact tokens used (authoritative) ---
      const active = await findActiveConversation();
      if (!active) {
        return { content: [{ type: "text", text: `context_status ERROR: no conversation files found in ${CONVERSATIONS_DIR}.` }] };
      }

      const tokensUsed = extractLatestPromptTokens(active.data);
      if (tokensUsed == null) {
        return { content: [{ type: "text", text: `context_status ERROR: no generation stats found in active conversation yet (${active.filePath}).` }] };
      }

      // --- 3. Pick the right loaded model for this conversation ---
      const convModelId = active.data.lastUsedModel?.identifier;
      let model = convModelId ? loadedModels.find((m) => m.id === convModelId) : undefined;
      if (!model || !Number.isFinite(model.loaded_context_length)) {
        model = loadedModels.find(
          (m) => m.type !== "embeddings" && Number.isFinite(m.loaded_context_length)
        );
      }

      // --- 4. Compose report ---
      const lines = ["CONTEXT STATUS", "═".repeat(50)];

      if (!model || !Number.isFinite(model.loaded_context_length)) {
        lines.push("No generative model currently loaded in LM Studio.");
        if (loadedModels.length) lines.push(`Loaded models: ${loadedModels.map((m) => m.id).join(", ")}`);
      } else {
        const limit = model.loaded_context_length;
        const remaining = limit - tokensUsed;
        const pct = (tokensUsed / limit) * 100;
        const status = pct >= CTX_THRESHOLDS.EMERGENCY ? "EMERGENCY" : pct >= CTX_THRESHOLDS.CRITICAL ? "CRITICAL" : pct >= CTX_THRESHOLDS.WARNING ? "WARNING" : "NORMAL";

        lines.push(`Model: ${model.id}`);
        lines.push(`Context limit: ${limit} tokens`);
        lines.push(`Tokens used (exact, at last generation step): ${tokensUsed}`);
        lines.push(`Remaining: ${remaining} tokens`);
        lines.push(`Percent used: ${pct.toFixed(1)}%`);
        lines.push(`Status: ${status}`);
        lines.push("");
        lines.push(ctxRecommendation(status, pct));
      }

      const ageSec = Math.round((Date.now() - active.mtimeMs) / 1000);
      lines.push("");
      lines.push("─".repeat(50));
      lines.push(`Source: LM Studio records (conversation file updated ${ageSec}s ago).`);
      lines.push("Note: tokens_used is exact as of the last completed generation step; the current in-flight tool round-trip adds a small amount on top.");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "list_chats": {
      return await handleListChats();
    }

    case "read_chat": {
      return await handleReadChat(args);
    }

    case "search_chat": {
      return await handleSearchChat(args);
    }

    default:
      throw new Error(`Unknown mnemonic tool: ${name}`);
  }
}
