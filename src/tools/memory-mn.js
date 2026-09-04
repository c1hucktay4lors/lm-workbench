// memory-mn.js — plain-JS port of mnemonic-mcp (src/server.ts).
// 11 tools: read_memory, auto_save, save_memory, update_memory, delete_memory,
// search_memory, list_sections, save_to_section, replace_section, tidy_memory,
// context_status.
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
  try { return await fs.readFile(memoryFilePath, "utf-8"); } catch { return ""; }
}

async function writeMemory(content) {
  ensureDirectory(memoryFilePath);
  try {
    const existing = await fs.readFile(memoryFilePath, "utf-8");
    if (existing.trim()) createBackup();
  } catch {}
  await fs.writeFile(memoryFilePath, content, "utf-8");
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
      // Ensure proper newline separation: trim trailing whitespace/newlines from existing content,
      // then add blank line + new bullet for readability
      newContent = before.trimEnd() + `\n\n- ${trimmedFact}` + after;
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

// ---------- Dispatcher ----------

export async function handleMnemonicTool(name, args = {}) {
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
      if (!content.toLowerCase().includes(args.find.toLowerCase())) {
        return { content: [{ type: "text", text: "Not found in memory." }] };
      }

      const lines = content.split("\n");
      const newLines = [];
      let skipBlock = false;

      for (const line of lines) {
        if (skipBlock && !line.trim()) { skipBlock = false; continue; }
        if (!skipBlock && line.toLowerCase().includes(args.find.toLowerCase())) {
          if (args.replace?.trim()) newLines.push(args.replace.trim());
          skipBlock = true;
          continue;
        }
        if (!skipBlock || line.trim()) newLines.push(line);
      }

      await writeMemory(newLines.join("\n").replace(/\n{3,}/g, "\n\n"));
      return { content: [{ type: "text", text: !args.replace?.trim() ? "Deleted." : "Updated." }] };
    }

    case "delete_memory": {
      const content = await readMemory();
      if (!content.toLowerCase().includes(args.text.toLowerCase())) {
        return { content: [{ type: "text", text: "Not found." }] };
      }

      const lines = content.split("\n");
      const newLines = [];
      let skipBlock = false;

      for (const line of lines) {
        if (skipBlock && !line.trim()) { skipBlock = false; continue; }
        if (!skipBlock && line.toLowerCase().includes(args.text.toLowerCase())) { skipBlock = true; continue; }
        if (!skipBlock || line.trim()) newLines.push(line);
      }

      await writeMemory(newLines.join("\n").replace(/\n{3,}/g, "\n\n"));
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
        await writeMemory(before.trimEnd() + `\n${trimmedContent}` + after);
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

      // Extract ALL standalone dated entries anywhere in file (they shouldn't be inside sections)
      const datedEntries = [];

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^\[(\d{4}-\d{2}-\d{2})\]\s+(.+)$/);
        if (match) {
          datedEntries.push({ lineNum: i, date: match[1], fact: match[2] });
        }
      }

      if (datedEntries.length === 0) {
        return { content: [{ type: "text", text: "No standalone dated entries found to organize." }] };
      }

      // Categorize each entry and group by target section
      const moves = {}; // section -> [facts]
      const uncategorized = [];

      for (const entry of datedEntries) {
        const category = detectCategory(entry.fact);
        if (category) {
          if (!moves[category.section]) moves[category.section] = [];
          moves[category.section].push(`- ${entry.fact}`);
        } else {
          uncategorized.push(entry);
        }
      }

      // Build new content: remove dated entries, add to sections
      const keptLines = lines.filter((_, i) => !datedEntries.some(d => d.lineNum === i));

      // Insert categorized facts into their sections
      let resultContent = keptLines.join("\n");

      for (const [section, facts] of Object.entries(moves)) {
        const sectionHeader = `## ${section}`;
        if (resultContent.includes(sectionHeader)) {
          // Append to existing section — insert before next ## or end
          const idx = resultContent.indexOf(sectionHeader);
          let insertPoint = resultContent.length;
          for (let i = idx + sectionHeader.length; i < resultContent.length; i++) {
            if (resultContent[i] === "\n" && resultContent.slice(i + 1, i + 3) === "## ") {
              insertPoint = i + 1; // before next header's newline
              break;
            }
          }

          const factsBlock = `\n${facts.join("\n")}`;
          if (insertPoint < resultContent.length) {
            resultContent = resultContent.slice(0, insertPoint).trimEnd() + factsBlock + "\n" + resultContent.slice(insertPoint);
          } else {
            resultContent = resultContent.trimEnd() + factsBlock;
          }
        } else {
          // Create new section at end (before any remaining uncategorized dated entries)
          const factsBlock = `\n\n## ${section}\n${facts.join("\n")}`;

          if (uncategorized.length > 0) {
            // Insert before the first remaining dated entry line
            const firstUncatLine = resultContent.indexOf(`[${uncategorized[0].date}]`);
            if (firstUncatLine !== -1) {
              resultContent = resultContent.slice(0, firstUncatLine).trimEnd() + factsBlock + "\n\n" + resultContent.slice(firstUncatLine);
            } else {
              resultContent += factsBlock;
            }
          } else {
            resultContent = resultContent.trimEnd() + factsBlock;
          }
        }
      }

      // Clean up excessive blank lines and normalize formatting
      resultContent = resultContent.replace(/\n{3,}/g, "\n\n");

      await writeMemory(resultContent);

      const movedCount = Object.values(moves).reduce((sum, arr) => sum + arr.length, 0);
      const summaryLines = [`Tidied ${datedEntries.length} standalone entry${datedEntries.length > 1 ? "ies" : ""}.`];

      for (const [section, facts] of Object.entries(moves)) {
        summaryLines.push(`→ Moved ${facts.length} to "${section}"`);
      }

      if (uncategorized.length > 0) {
        summaryLines.push(`${uncategorized.length} left as dated entries (couldn't categorize confidently)`);
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

    default:
      throw new Error(`Unknown mnemonic tool: ${name}`);
  }
}
