#!/usr/bin/env node
// lm-memory-sync — optional Google Drive synchronization for lm-workbench memory.
//
// Keeps the local memory directory (memory.md + backups/) in sync with a
// configured rclone remote (e.g. gdrive:lm-workbench/memory) using rclone
// bisync (bidirectional, conflict-preserving). The memory MCP tools are
// untouched: they always read/write the local file, and this tool runs
// independently (manually, or via the systemd user timer).
//
// Configuration (environment variables, no other config mechanism):
//   MEMORY_FILE_PATH          local memory file (shared with the MCP server;
//                             default: per-OS app-data dir, see --help)
//   LM_MEMORY_SYNC_REMOTE     rclone remote, e.g. gdrive:lm-workbench/memory
//   LM_MEMORY_SYNC_RCLONE     rclone binary (default: rclone on PATH)
//
// Exit codes:
//   0  success
//   1  configuration error (remote not set, rclone missing)
//   2  remote unreachable / sync failed (safe to retry later)
//   3  critical bisync abort — recovery required (run: lm-memory-sync --recover)
//   4  another sync is already running (lock held)
//   5  init refused: ambiguous state needs an explicit decision
//   6  local memory missing and nothing to do

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { memoryFilePath } from "../src/tools/memory-mn.js";

// ---------- Paths & config ----------

const LOCAL_FILE = path.resolve(memoryFilePath);
const LOCAL_DIR = path.dirname(LOCAL_FILE);
const REMOTE = (process.env.LM_MEMORY_SYNC_REMOTE || "").trim();
const RCLONE_BIN = process.env.LM_MEMORY_SYNC_RCLONE || "rclone";

// State (lock, log, last result) lives OUTSIDE the synced directory so it is
// never pushed to the remote and never seen by bisync.
const STATE_DIR = path.join(path.dirname(LOCAL_DIR), "memory-sync");

const RCLONE_TIMEOUT_MS = 120_000;
const STALE_LOCK_MS = 10 * 60 * 1000; // > bisync --max-lock (5m)

// rclone bisync flags used for EVERY run (normal sync, init, check, recover).
// Chosen per rclone's bisync docs (v1.7x):
//   --resilient --recover --max-lock 5m   background-safe: retryable after
//       interruptions, self-recovery, expiring locks (no manual cleanup)
//   --max-delete 50                       abort if >50% of files were deleted
//       on either side (protects against a failed listing being read as
//       "everything deleted" and propagated)
//   --conflict-resolve none --conflict-loser num --conflict-suffix conflict
//       conflicts keep BOTH versions (memory.md.conflict1/.conflict2 appear
//       on both sides) — nothing is ever silently dropped
//   --create-empty-src-dirs               keep the backups/ directory in sync
//   --drive-skip-gdocs                    ignore Google Docs (memory.md is a
//       plain file; if it were ever opened as a Doc, skip instead of break)
const BISYNC_FLAGS = [
  "--resilient",
  "--recover",
  "--max-lock", "5m",
  "--max-delete", "50",
  "--conflict-resolve", "none",
  "--conflict-loser", "num",
  "--conflict-suffix", "conflict",
  "--create-empty-src-dirs",
  "--drive-skip-gdocs",
];

// --check-access is only safe AFTER init (when memory.md exists on both sides).
// On the initial resync, one side may not have memory.md yet — bisync enforces
// check-access even during resync and would abort. So we add it dynamically:
const CHECK_ACCESS_FLAGS = ["--check-access", "--check-filename", "memory.md"];

// A small marker file created at init time to solve two problems with a
// 1-file tree (just memory.md):
//   1. bisync's "all files changed" safety check fires on ANY modification of
//      the sole file, aborting normal syncs. With a second file, modifying
//      only memory.md is no longer "all files".
//   2. Provides a stable target for --check-access (the marker never changes).
const RCLONE_TEST_FILE = "RCLONE_TEST";

// ---------- Exit codes ----------
const EXIT_OK = 0;
const EXIT_CONFIG = 1;
const EXIT_REMOTE = 2;
const EXIT_CRITICAL = 3;
const EXIT_LOCKED = 4;
const EXIT_AMBIGUOUS = 5;
const EXIT_NO_LOCAL = 6;

// ---------- Small helpers ----------

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fsSync.mkdirSync(STATE_DIR, { recursive: true });
    fsSync.appendFileSync(path.join(STATE_DIR, "sync.log"), line + "\n");
  } catch { /* logging is best-effort */ }
}

function fail(code, msg) {
  console.error(`\nlm-memory-sync: ${msg}`);
  try {
    fsSync.mkdirSync(STATE_DIR, { recursive: true });
    fsSync.appendFileSync(path.join(STATE_DIR, "sync.log"),
      `[${new Date().toISOString()}] EXIT ${code}: ${msg}\n`);
  } catch { /* ignore */ }
  process.exit(code);
}

function runRclone(args, { timeoutMs = RCLONE_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = spawnSync(RCLONE_BIN, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return { code: -1, out: "", err: String(e) };
  }
  if (res.error) return { code: -1, out: "", err: res.error.message };
  return { code: res.status == null ? -1 : res.status, out: res.stdout || "", err: res.stderr || "" };
}

function rcloneAvailable() {
  const r = runRclone(["version"], { timeoutMs: 10_000 });
  return r.code === 0;
}

function remoteReachable() {
  // `rclone size` touches the remote once; errors if unconfigured or offline.
  const r = runRclone(["size", REMOTE]);
  if (r.code !== 0) {
    return { ok: false, detail: (r.err || r.out || "rclone failed").trim().split("\n").slice(-3).join(" | ") };
  }
  return { ok: true, detail: (r.out || "").trim().split("\n").pop() || "ok" };
}

function remoteFileList() {
  const r = runRclone(["lsf", REMOTE, "-R", "--files-only"]);
  if (r.code !== 0) return null;
  return r.out.split("\n").map(s => s.trim()).filter(Boolean);
}

// ---------- Locking (prevents overlapping syncs) ----------

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  const lockPath = path.join(STATE_DIR, "sync.lock");
  fsSync.mkdirSync(STATE_DIR, { recursive: true });
  const tryCreate = () => {
    try {
      fsSync.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      return false;
    }
  };
  if (tryCreate()) return true;

  // Lock exists — is it stale?
  try {
    const info = JSON.parse(fsSync.readFileSync(lockPath, "utf-8"));
    const age = Date.now() - (info.ts || 0);
    if (age > STALE_LOCK_MS || (Number.isInteger(info.pid) && !pidAlive(info.pid))) {
      fsSync.rmSync(lockPath, { force: true });
      if (tryCreate()) return true;
    }
  } catch { /* unreadable lock: left in place (safe side) */ }
  return false;
}

function releaseLock() {
  try { fsSync.rmSync(path.join(STATE_DIR, "sync.lock"), { force: true }); } catch { /* ignore */ }
}

// ---------- Local/remote state probes ----------

function localState() {
  const dirExists = fsSync.existsSync(LOCAL_DIR);
  let fileExists = false, size = 0, mtime = null, backups = 0;
  if (dirExists && fsSync.existsSync(LOCAL_FILE)) {
    fileExists = true;
    const st = fsSync.statSync(LOCAL_FILE);
    size = st.size;
    mtime = st.mtime.toISOString();
  }
  const backupDir = path.join(LOCAL_DIR, "backups");
  if (fsSync.existsSync(backupDir)) {
    backups = fsSync.readdirSync(backupDir).filter(f => f.startsWith("memory-") && f.endsWith(".md")).length;
  }
  const conflicts = dirExists
    ? fsSync.readdirSync(LOCAL_DIR).filter(f => /\.conflict\d+$/.test(f))
    : [];
  return { dirExists, fileExists, size, mtime, backups, conflicts };
}

function bisyncState() {
  // rclone's per-machine bisync working dir (listings, locks, error state).
  let stateDir;
  if (process.platform === "win32") {
    stateDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "rclone", "bisync");
  } else if (process.platform === "darwin") {
    stateDir = path.join(os.homedir(), "Library", "Caches", "rclone", "bisync");
  } else {
    stateDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "rclone", "bisync");
  }
  const out = { stateDir, hasListings: false, lockedOut: false, lockFiles: [] };
  if (!fsSync.existsSync(stateDir)) return out;
  const frag = path.basename(LOCAL_DIR); // e.g. "memory"
  for (const f of fsSync.readdirSync(stateDir)) {
    if (!f.includes(frag)) continue;
    if (f.endsWith(".lck")) out.lockFiles.push(f);
    if (f.endsWith(".lst")) out.hasListings = true;
    if (f.endsWith(".lst-err")) out.lockedOut = true;
  }
  return out;
}

function writeLastResult(obj) {
  try {
    fsSync.mkdirSync(STATE_DIR, { recursive: true });
    fsSync.writeFileSync(path.join(STATE_DIR, "last-result.json"), JSON.stringify(obj, null, 2));
  } catch { /* best-effort */ }
}

function readLastResult() {
  try { return JSON.parse(fsSync.readFileSync(path.join(STATE_DIR, "last-result.json"), "utf-8")); } catch { return null; }
}

async function promptLine(q) {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a); }));
}

// ---------- Commands ----------

function cmdHelp() {
  console.log(`lm-memory-sync — sync the lm-workbench memory directory with a configured rclone remote (Google Drive).

USAGE
  lm-memory-sync                 Normal bidirectional sync (no dangerous flags needed).
  lm-memory-sync --init          First-run setup; pick the initial source of truth.
  lm-memory-sync --check         Verify config + remote, and dry-run what a sync would do.
  lm-memory-sync --status        Show local/remote/bisync state and last sync result.
  lm-memory-sync --recover       Diagnose a failed/locked bisync state (read-only).
  lm-memory-sync --recover --apply
                                 Explicitly re-establish bisync state (recovery).
  lm-memory-sync --help, -h

INIT (first run on this machine)
  lm-memory-sync --init --from-local    Seed the remote from LOCAL memory.
  lm-memory-sync --init --from-remote   Seed this machine from REMOTE memory.
  Add --yes to skip the confirmation prompt (same explicit source choice).
  Without a source flag, --init detects the situation and asks. If BOTH sides
  already contain memory.md, it REFUSES and requires an explicit choice.
  Init is a one-way seed in the direction you choose; it never deletes data.
  (One side empty, the other has data -> that side is suggested automatically.)

NORMAL OPERATION
  lm-memory-sync                 (periodically, e.g. via the systemd user timer)
  lm-memory-sync --check         safe read-only preview of the next sync

RECOVERY (only when a sync reports a critical abort)
  1. lm-memory-sync --status             (shows the bisync state)
  2. lm-memory-sync --recover            (read-only diagnosis; changes nothing)
  3. lm-memory-sync --check              (dry-run preview of the resync)
  4. lm-memory-sync --recover --apply    (actually re-establish state; local wins)
  Recovery is always explicit; normal syncs never --resync automatically.

CONFIGURATION (environment variables — in your shell profile, the systemd
unit, or mcp.json; there are no other config files)
  MEMORY_FILE_PATH       Local memory file. Default:
                           Linux   $XDG_DATA_HOME/lm-workbench/memory/memory.md
                                   (usually ~/.local/share/lm-workbench/memory/memory.md)
                           Windows %LOCALAPPDATA%\\lm-workbench\\memory\\memory.md
                           macOS   ~/Library/Application Support/lm-workbench/memory/memory.md
                 The MCP server uses the same variable, so both always see the
                 same file. Existing stores at ~/.mcp-memory/memory.md or
                 ~/.local/share/mcp-memory/memory.md keep working until the
                 new location exists (then the new location wins).
  LM_MEMORY_SYNC_REMOTE  rclone remote for the memory directory, e.g.
                         gdrive:lm-workbench/memory  ("gdrive" is whatever
                         you named the remote in rclone config; any remote
                         name works)
  LM_MEMORY_SYNC_RCLONE  rclone binary to use (default: rclone on PATH)

SYSTEMD (Linux, user-level — no sudo, nothing installed globally)
  install -Dm644 systemd/lm-memory-sync.service ~/.config/systemd/user/
  install -Dm644 systemd/lm-memory-sync.timer   ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now lm-memory-sync.timer
  Disable: systemctl --user disable --now lm-memory-sync.timer
  Interval: edit OnUnitInactiveSec in the .timer (default 5m).

CONFLICTS
  If memory.md changed on two machines between syncs, bisync keeps BOTH
  versions: memory.md.conflict1 and memory.md.conflict2 appear on both sides.
  Compare, merge into memory.md, then delete the .conflictN files. Nothing is
  ever silently dropped; the MCP server also keeps up to 10 pre-overwrite
  backups in backups/.

EXIT CODES
  0 ok   1 config error   2 remote unreachable (retry later)
  3 critical bisync abort (run --recover)   4 already syncing (lock)
  5 init needs explicit decision   6 local memory missing

LOGS
  ${STATE_DIR}/sync.log   (also printed to stdout)
  rclone's bisync state   (see --status output)`);
}

function requireRemote() {
  if (!REMOTE) {
    fail(EXIT_CONFIG,
      "LM_MEMORY_SYNC_REMOTE is not set (e.g. LM_MEMORY_SYNC_REMOTE=gdrive:lm-workbench/memory).\n" +
      "Without it, lm-memory-sync cannot sync — the MCP memory tools are unaffected.");
  }
  if (!rcloneAvailable()) {
    fail(EXIT_CONFIG, `rclone binary not found/usable: "${RCLONE_BIN}" (install rclone, or set LM_MEMORY_SYNC_RCLONE).`);
  }
}

function cmdSync({ dryRun = false } = {}) {
  requireRemote();
  const local = localState();
  if (!local.dirExists || !local.fileExists) {
    fail(EXIT_NO_LOCAL,
      `local memory not found at ${LOCAL_FILE}.\n` +
      "Run lm-memory-sync --init first to seed it from the remote (or set MEMORY_FILE_PATH).");
  }
  if (!acquireLock()) {
    fail(EXIT_LOCKED, "another lm-memory-sync is already running (lock held) — nothing to do.");
  }
  try {
    // Normal syncs use --check-access to guard against wiping memory.md.
    const args = ["bisync", LOCAL_DIR, REMOTE, ...BISYNC_FLAGS, ...CHECK_ACCESS_FLAGS];
    if (dryRun) args.push("--dry-run");
    logLine(`bisync ${dryRun ? "(dry-run) " : ""}${LOCAL_DIR} <-> ${REMOTE}`);
    const r = runRclone(args);
    const tail = (r.out + "\n" + r.err).trim().split("\n").slice(-15).join("\n");
    if (tail) console.log(tail);

    if (r.code === 0) {
      logLine(dryRun ? "dry-run OK" : "sync OK");
      writeLastResult({ ok: true, at: new Date().toISOString(), dryRun });
      return EXIT_OK;
    }
    writeLastResult({ ok: false, at: new Date().toISOString(), dryRun, code: r.code });
    if (r.code === 7) {
      fail(EXIT_CRITICAL,
        "bisync aborted critically (state locked). Local memory is intact. Recover explicitly:\n" +
        "  lm-memory-sync --recover\n" +
        "  lm-memory-sync --check            (dry-run preview)\n" +
        "  lm-memory-sync --recover --apply");
    }
    fail(EXIT_REMOTE, `sync failed (rclone exit ${r.code}). Local and remote memory are intact; retry when the remote is reachable.`);
  } finally {
    releaseLock();
  }
}

async function cmdInit() {
  const argv = process.argv.slice(2);
  const from = argv.includes("--from-local") ? "local" : argv.includes("--from-remote") ? "remote" : null;
  const assumeYes = argv.includes("--yes") || argv.includes("-y");

  requireRemote();

  const local = localState();
  const reach = remoteReachable();
  if (!reach.ok) fail(EXIT_REMOTE, `remote not reachable: ${reach.detail}`);
  const remoteFiles = remoteFileList() || [];
  const remoteHasMemory = remoteFiles.some(f => f === "memory.md");

  // Ensure the local base directory exists (bisync requires both base dirs).
  fsSync.mkdirSync(LOCAL_DIR, { recursive: true });

  logLine(`init: local memory ${local.fileExists ? `present (${local.size} bytes)` : "absent"}; remote files: [${remoteFiles.join(", ") || "(empty)"}]`);

  // Create the RCLONE_TEST marker file locally. This solves two problems
  // with a 1-file tree (just memory.md): bisync's "all files changed" safety
  // check would fire on any modification of the sole file, and we need a
  // stable target for --check-access on subsequent normal syncs. Bisync will
  // copy this to the remote during the resync below.
  const markerPath = path.join(LOCAL_DIR, RCLONE_TEST_FILE);
  if (!fsSync.existsSync(markerPath)) {
    fsSync.writeFileSync(markerPath, "");
    logLine(`created ${RCLONE_TEST_FILE} marker file`);
  }

  // Decide the seed direction.
  let dir = from;
  if (!dir) {
    if (local.fileExists && !remoteHasMemory) dir = "local";
    else if (!local.fileExists && remoteHasMemory) dir = "remote";
    else if (local.fileExists && remoteHasMemory) {
      console.error("Both local AND remote already contain memory.md. Refusing to guess.\n" +
        "Pick one explicitly (init copies in that direction only; nothing is deleted):\n" +
        "  lm-memory-sync --init --from-local      (local wins; remote-only files still come down)\n" +
        "  lm-memory-sync --init --from-remote     (remote wins; local-only files still go up)");
      fail(EXIT_AMBIGUOUS, "ambiguous init state — explicit --from-local or --from-remote required.");
    } else {
      dir = "local"; // neither side has memory.md: start a new empty store
    }
  }

  // If the source side has no memory.md at all, create an empty local store
  // so both sides end up with a valid (empty) memory.md.
  if (!local.fileExists && !remoteHasMemory) {
    if (!assumeYes) {
      const answer = await promptLine("Create an empty memory.md locally to start a new memory store? [y/N] ");
      if (!/^[yY]/.test(answer.trim())) fail(EXIT_AMBIGUOUS, "init cancelled.");
    }
    fsSync.writeFileSync(LOCAL_FILE, "");
    logLine("created empty local memory.md");
  }

  if (!assumeYes && !from) {
    const answer = await promptLine(`Seed in the direction ${dir === "local" ? "LOCAL -> remote" : "remote -> LOCAL"}? Nothing is deleted. [y/N] `);
    if (!/^[yY]/.test(answer.trim())) fail(EXIT_AMBIGUOUS, "init cancelled.");
  }

  if (!acquireLock()) fail(EXIT_LOCKED, "another lm-memory-sync is already running (lock held).");
  try {
    // First bisync run: --resync is required exactly once (per rclone docs).
    // path1 = local dir, path2 = remote; pick the winner explicitly.
    const args = ["bisync", LOCAL_DIR, REMOTE, ...BISYNC_FLAGS,
      "--resync", "--resync-mode", dir === "local" ? "path1" : "path2"];
    logLine(`init resync (winner: ${dir})`);
    const r = runRclone(args);
    const tail = (r.out + "\n" + r.err).trim().split("\n").slice(-15).join("\n");
    if (tail) console.log(tail);
    if (r.code !== 0) {
      fail(r.code === 7 ? EXIT_CRITICAL : EXIT_REMOTE,
        `init failed (rclone exit ${r.code}). Nothing was deleted; fix the cause and re-run --init.`);
    }
    logLine("init OK — both sides now share the same memory.md");
    writeLastResult({ ok: true, at: new Date().toISOString(), init: true });
  } finally {
    releaseLock();
  }
  console.log("\nDone. Normal operation from now on is simply:  lm-memory-sync");
}

function cmdCheck() {
  requireRemote();
  const local = localState();
  console.log(`local dir:   ${LOCAL_DIR}${local.dirExists ? "" : "  (MISSING)"}`);
  console.log(`local file:  ${LOCAL_FILE}${local.fileExists ? `  (${local.size} bytes, mtime ${local.mtime})` : "  (MISSING)"}`);
  console.log(`backups:     ${local.backups}`);
  if (local.conflicts.length) console.log(`CONFLICT COPIES PRESENT: ${local.conflicts.join(", ")}`);
  const st = bisyncState();
  console.log(`bisync state: ${st.stateDir}${st.hasListings ? " (listings present)" : " (no listings yet — first run will --resync)"}`);
  if (st.lockedOut) console.log("bisync LOCKED OUT (.lst-err) — run lm-memory-sync --recover");
  if (st.lockFiles.length) console.log(`bisync lock files present: ${st.lockFiles.join(", ")}`);
  const reach = remoteReachable();
  console.log(`remote:      ${REMOTE + (reach.ok ? "  (reachable)" : "  (UNREACHABLE: " + reach.detail + ")")}`);
  if (reach.ok) {
    const files = remoteFileList();
    if (files) console.log(`remote files: ${files.join(", ") || "(empty)"}`);
  }
  if (local.fileExists && reach.ok) {
    console.log("\nDry-run of next sync:");
    // Preview uses the same flags as a normal sync (including --check-access).
    const r = runRclone(["bisync", LOCAL_DIR, REMOTE, ...BISYNC_FLAGS, ...CHECK_ACCESS_FLAGS, "--dry-run"]);
    const tail = (r.out + "\n" + r.err).trim().split("\n").slice(-25).join("\n");
    console.log(tail);
    if (r.code !== 0) {
      console.log(`\ndry-run reported issues (rclone exit ${r.code}); no changes were made.`);
      process.exitCode = r.code === 7 ? EXIT_CRITICAL : EXIT_REMOTE;
      return;
    }
  }
}

function cmdStatus() {
  const local = localState();
  console.log("lm-memory-sync status");
  console.log(`  local file:   ${LOCAL_FILE}${local.fileExists ? `  (${local.size} bytes, mtime ${local.mtime})` : "  (MISSING)"}`);
  console.log(`  backups:      ${local.backups}`);
  if (local.conflicts.length) console.log(`  CONFLICTS:    ${local.conflicts.join(", ")}  (merge manually, then delete)`);
  console.log(`  remote:       ${REMOTE || "(not configured — MCP memory still works locally)"}`);
  if (REMOTE) {
    const reach = remoteReachable();
    console.log(`  remote state: ${reach.ok ? "reachable" : "UNREACHABLE (" + reach.detail + ")"}`);
    if (reach.ok) {
      const files = remoteFileList();
      if (files) console.log(`  remote files: ${files.length ? files.join(", ") : "(empty)"}`);
    }
  }
  const st = bisyncState();
  console.log(`  bisync state: ${st.stateDir}`);
  console.log(`                 listings: ${st.hasListings ? "present" : "none"}${st.lockedOut ? "  ** LOCKED OUT (.lst-err) ** run --recover" : ""}${st.lockFiles.length ? `  locks: ${st.lockFiles.join(", ")}` : ""}`);
  const last = readLastResult();
  if (last) console.log(`  last sync:    ${last.at}  ${last.ok ? "OK" : `FAILED (rclone exit ${last.code})`}${last.dryRun ? " (dry-run)" : ""}`);
  if (process.platform === "linux") {
    try {
      const t = spawnSync("systemctl", ["--user", "is-active", "lm-memory-sync.timer"], { encoding: "utf-8" });
      if (t.status === 0) console.log(`  timer:        ${ (t.stdout || "").trim() || "unknown" }`);
    } catch { /* systemctl not available */ }
  }
}

function cmdRecover() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  requireRemote();
  const st = bisyncState();
  console.log("lm-memory-sync --recover (diagnosis)");
  console.log(`  bisync state dir: ${st.stateDir}`);
  console.log(`  listings: ${st.hasListings ? "present" : "none"}`);
  if (!st.lockedOut) {
    console.log("  no lockout detected — bisync state looks usable; a normal sync should work.\n" +
      "  If a normal sync still fails, run: lm-memory-sync --check");
    return EXIT_OK;
  }
  console.log("  LOCKED OUT: bisync renamed its listings to *.lst-err after an error.");
  console.log("  Recovery re-establishes state (one resync, local wins). This is a one-way");
  console.log("  seed — remote-only files still come down, local-only files go up, and the\n" +
      "  winning side's memory.md overwrites the other's (no deletions).\n" +
      "  Preview first with --check, then re-run with --apply.");
  if (!apply) {
    console.log("\nWhen ready, run:  lm-memory-sync --recover --apply");
    return EXIT_CRITICAL;
  }
  if (!acquireLock()) fail(EXIT_LOCKED, "another lm-memory-sync is already running (lock held).");
  try {
    // Recovery resync: no --check-access (state may be inconsistent).
    const args = ["bisync", LOCAL_DIR, REMOTE, ...BISYNC_FLAGS, "--resync", "--resync-mode", "path1"];
    logLine("recover --apply (resync, local wins)");
    const r = runRclone(args);
    const tail = (r.out + "\n" + r.err).trim().split("\n").slice(-15).join("\n");
    if (tail) console.log(tail);
    if (r.code === 0) {
      logLine("recover OK");
      writeLastResult({ ok: true, at: new Date().toISOString(), recovered: true });
      console.log("\nRecovery complete.");
      return EXIT_OK;
    }
    fail(EXIT_REMOTE, `recovery failed (rclone exit ${r.code}). State is still locked; inspect manually: ${st.stateDir}`);
  } finally {
    releaseLock();
  }
}

// ---------- Main ----------

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  cmdHelp();
  process.exit(EXIT_OK);
}
if (argv.includes("--init")) {
  cmdInit().catch((e) => { console.error(`\nlm-memory-sync: ${e.message}`); process.exit(EXIT_CONFIG); });
} else if (argv.includes("--check")) {
  process.exit(cmdCheck());
} else if (argv.includes("--status")) {
  process.exit(cmdStatus());
} else if (argv.includes("--recover")) {
  process.exit(cmdRecover());
} else {
  // Bare `lm-memory-sync` (no flags) = normal sync.
  process.exit(cmdSync());
}
