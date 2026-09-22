// test/memory-sync.test.mjs — tests for the memory path change and the
// lm-memory-sync CLI. Uses rclone's `local` backend as a stand-in remote so
// no Google Drive authentication is required. Run:
//
//   node test/memory-sync.test.mjs          (rclone must be on PATH)
//   TEST_RCLONE=/path/to/rclone node test/memory-sync.test.mjs
//
// Exit code 0 = all passed.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "lm-memory-sync.js");
const RCLONE = process.env.TEST_RCLONE || "rclone";

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${extra ? `  [${extra}]` : ""}`); }
}

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lmw-sync-test-"));
  for (const d of ["home", "home/.mcp-memory", "data", "cache", "state", "remote"]) {
    fs.mkdirSync(path.join(base, d), { recursive: true });
  }
  const env = {
    HOME: path.join(base, "home"),
    XDG_DATA_HOME: path.join(base, "data"),
    XDG_CACHE_HOME: path.join(base, "cache"),
    XDG_STATE_HOME: path.join(base, "state"),
    RCLONE_CONFIG: path.join(base, "rclone.conf"), // isolated, empty config
    PATH: process.env.PATH,
  };
  return {
    base, env,
    memDir: path.join(base, "data", "lm-workbench", "memory"),
    memFile: path.join(base, "data", "lm-workbench", "memory", "memory.md"),
    remoteRoot: path.join(base, "remote"),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

// Use a plain local path as the "remote" — rclone bisync works with two local
// paths directly (no remote config needed). This is exactly how rclone's own
// bisync test suite exercises local↔local sync.
function remotePath(sb) { return path.join(sb.remoteRoot, "lm-workbench", "memory"); }

function runCli(args, sb, extraEnv = {}, stdin) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...sb.env, LM_MEMORY_SYNC_RCLONE: RCLONE, ...extraEnv },
    timeout: 90_000,
    input: stdin,
  });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

function remoteHas(sb, file) {
  return fs.existsSync(path.join(sb.remoteRoot, "lm-workbench", "memory", file));
}
function remoteRead(sb, file) {
  try { return fs.readFileSync(path.join(sb.remoteRoot, "lm-workbench", "memory", file), "utf-8"); } catch { return null; }
}
function localRead(sb) { try { return fs.readFileSync(sb.memFile, "utf-8"); } catch { return null; } }
function writeLocal(sb, content) { fs.mkdirSync(path.dirname(sb.memFile), { recursive: true }); fs.writeFileSync(sb.memFile, content); }
function writeRemote(sb, content) {
  fs.mkdirSync(path.join(sb.remoteRoot, "lm-workbench", "memory"), { recursive: true });
  fs.writeFileSync(path.join(sb.remoteRoot, "lm-workbench", "memory", "memory.md"), content);
}
function syncEnv(sb) { return { LM_MEMORY_SYNC_REMOTE: REMOTE_NAME }; }

// ---------- 1. Memory MCP tools (in-process, isolated store) ----------

console.log("\n[1] MCP memory tools still work (in-process)");
{
  const sb = sandbox();
  const script = `
    const { handleMnemonicTool } = await import(${JSON.stringify(path.join(ROOT, "src", "tools", "memory-mn.js"))});
    const r = async (n, a) => (await handleMnemonicTool(n, a)).content[0].text;
    const out = [];
    out.push("save:" + await r("save_memory", { fact: "User prefers coffee black" }));
    out.push("read:" + (await r("read_memory", {})).replace(/\\s+/g, " "));
    out.push("search:" + (await r("search_memory", { query: "coffee black" })).split("\\n")[0]);
    out.push("update:" + await r("update_memory", { find: "coffee black", replace: "coffee with oat milk" }));
    out.push("after:" + (await r("read_memory", {})).includes("oat milk"));
    out.push("list:" + (await r("list_sections", {})).replace(/\\n/g, " | "));
    out.push("delete:" + await r("delete_memory", { text: "oat milk" }));
    out.push("gone:" + !(await r("read_memory", {})).includes("oat milk"));
    console.log(out.join("\\n"));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf-8",
    env: { ...sb.env, MEMORY_FILE_PATH: sb.memFile },
    timeout: 30_000,
  });
  const out = r.stdout || "";
  check("save_memory", /save:Saved/.test(out), out)
  check("read_memory round-trip", /User prefers coffee black/.test(out), out)
  check("search_memory", /Found 1 match/.test(out), out)
  check("update_memory", /update:Updated/.test(out), out)
  check("update visible", /after:true/.test(out), out)
  check("list_sections", /Personal Preferences|Interests/.test(out), out)
  check("delete_memory", /delete:Deleted/.test(out), out)
  check("delete visible", /gone:true/.test(out), out)
  check("backup created on overwrite", fs.existsSync(path.join(sb.memDir, "backups")) && fs.readdirSync(path.join(sb.memDir, "backups")).some(f => f.startsWith("memory-")), "");
  sb.cleanup();
}

// ---------- 2. Path resolution (defaults, overrides, backward compat) ----------

console.log("\n[2] Memory path resolution");
{
  const script = `
    console.log(require("node:os").homedir());
  `;
  void script;
  const probe = (env, extra = {}) => {
    const code = `
      import { memoryFilePath } from ${JSON.stringify(path.join(ROOT, "src", "tools", "memory-mn.js"))};
      console.log(memoryFilePath);
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf-8", env: { ...env, ...extra }, timeout: 20_000 });
    return (r.stdout || "").trim().split("\n").pop();
  };

  let sb = sandbox();
  check("default = XDG app-data location",
    probe(sb.env) === path.join(sb.env.XDG_DATA_HOME, "lm-workbench", "memory", "memory.md"),
    probe(sb.env));
  check("MEMORY_FILE_PATH override wins",
    probe(sb.env, { MEMORY_FILE_PATH: "/custom/place/memory.md" }) === "/custom/place/memory.md", "");
  fs.rmSync(sb.base, { recursive: true, force: true });

  sb = sandbox();
  fs.writeFileSync(path.join(sb.env.HOME, ".mcp-memory", "memory.md"), "old store");
  check("legacy ~/.mcp-memory store still used when new location absent",
    probe(sb.env) === path.join(sb.env.HOME, ".mcp-memory", "memory.md"), probe(sb.env));
  fs.rmSync(sb.base, { recursive: true, force: true });

  sb = sandbox();
  fs.writeFileSync(path.join(sb.env.HOME, ".mcp-memory", "memory.md"), "old store");
  fs.mkdirSync(path.dirname(sb.memFile), { recursive: true });
  fs.writeFileSync(sb.memFile, "new store");
  check("new location preferred once it exists", probe(sb.env) === sb.memFile, probe(sb.env));
  sb.cleanup();
}

// ---------- 3. CLI: missing configuration ----------

console.log("\n[3] CLI detects missing configuration");
{
  const sb = sandbox();
  const r = runCli([], sb); // normal sync, no remote configured
  check("sync without remote -> exit 1 (config error)", r.code === 1, `code=${r.code}`);
  check("helpful message names LM_MEMORY_SYNC_REMOTE", /LM_MEMORY_SYNC_REMOTE/.test(r.err + r.out), r.err.slice(-300));
  const st = runCli(["--status"], sb);
  check("--status works without a remote (exit 0)", st.code === 0, `code=${st.code}`);
  check("--status says not configured", /not configured/.test(st.out), st.out);
  const h = runCli(["--help"], sb);
  check("--help exit 0 + documents everything", h.code === 0 && /--init/.test(h.out) && /--recover/.test(h.out) && /CONFLICTS/.test(h.out) && /SYSDIM|SYSTEMD/.test(h.out), h.out.slice(0, 200));
  sb.cleanup();
}

// ---------- 4. Init: local exists, remote empty ----------

console.log("\n[4] Init: local data -> empty remote");
{
  const sb = sandbox();
  writeLocal(sb, "## Real Memory\n- important local fact\n");
  fs.mkdirSync(remotePath(sb), { recursive: true }); // empty remote dir
  const r = runCli(["--init", "--from-local", "--yes"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("init exit 0", r.code === 0, (r.err || r.out).slice(-400));
  check("remote now has memory.md", remoteHas(sb, "memory.md"), "");
  check("remote content == local content", remoteRead(sb, "memory.md") === localRead(sb), "");
  check("local content untouched", localRead(sb).includes("important local fact"), "");
  sb.cleanup();
}

// ---------- 5. Init: remote exists, local absent ----------

console.log("\n[5] Init: remote data -> empty local");
{
  const sb = sandbox();
  writeRemote(sb, "## Real Memory\n- important remote fact\n");
  writeRemote(sb, "## Real Memory\n- important remote fact\n"); // creates dir
  const r = runCli(["--init", "--from-remote", "--yes"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("init exit 0", r.code === 0, (r.err || r.out).slice(-400));
  check("local memory.md now exists", fs.existsSync(sb.memFile), "");
  check("local content == remote content", localRead(sb) === remoteRead(sb, "memory.md"), "");
  sb.cleanup();
}

// ---------- 6. Init: BOTH sides exist -> refuse without explicit choice ----------

console.log("\n[6] Init: both sides have memory -> refuses to guess");
{
  const sb = sandbox();
  writeLocal(sb, "LOCAL-ONLY-CONTENT\n");
  writeRemote(sb, "REMOTE-ONLY-CONTENT\n");
  writeRemote(sb, "REMOTE-ONLY-CONTENT\n"); // creates dir
  const r = runCli(["--init"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) }, "n\n");
  check("bare --init with both sides populated -> exit 5 (ambiguous)", r.code === 5, `code=${r.code}`);
  check("local unchanged", localRead(sb) === "LOCAL-ONLY-CONTENT\n", "");
  check("remote unchanged", remoteRead(sb, "memory.md") === "REMOTE-ONLY-CONTENT\n", "");
  check("message names both explicit options", /--from-local/.test(r.err + r.out) && /--from-remote/.test(r.err + r.out), "");

  // Explicit choice: local wins.
  const r2 = runCli(["--init", "--from-local", "--yes"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("explicit --from-local succeeds", r2.code === 0, (r2.err || r2.out).slice(-300));
  check("remote now equals local", remoteRead(sb, "memory.md") === "LOCAL-ONLY-CONTENT\n", remoteRead(sb, "memory.md"));
  sb.cleanup();
}

// ---------- 7. Normal sync in both directions ----------

console.log("\n[7] Normal sync (both directions)");
{
  const sb = sandbox();
  writeLocal(sb, "baseline\n");
  fs.mkdirSync(remotePath(sb), { recursive: true });
  runCli(["--init", "--from-local", "--yes"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });

  writeLocal(sb, "desktop edited this\n");
  let r = runCli([], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("local->remote sync", r.code === 0 && remoteRead(sb, "memory.md") === "desktop edited this\n", (r.err || r.out).slice(-300));

  writeRemote(sb, "laptop edited this\n");
  r = runCli([], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("remote->local sync", r.code === 0 && localRead(sb) === "laptop edited this\n", (r.err || r.out).slice(-300));
  sb.cleanup();
}

// ---------- 8. Offline / unreachable remote fails safely ----------

console.log("\n[8] Unreachable remote fails safely");
{
  const sb = sandbox();
  writeLocal(sb, "precious local memory\n");
  const before = localRead(sb);
  // Non-existent path → rclone size fails → exit 2 (remote unreachable)
  const r = runCli([], sb, { LM_MEMORY_SYNC_REMOTE: "/nonexistent-lmw-test-remote" });
  // Non-existent path → bisync can't start → rclone exit 7 (critical) → our exit 3.
  check("sync with bad remote -> exit 3 (critical/config error)", r.code === 3, `code=${r.code}`);
  check("local memory untouched", localRead(sb) === before, "");
  check("message says local memory is intact", /intact/.test(r.err + r.out), "");
  sb.cleanup();
}

// ---------- 9. Concurrent modification -> conflict copies, no data loss ----------

console.log("\n[9] Concurrent modification keeps both versions");
{
  const sb = sandbox();
  writeLocal(sb, "shared baseline\n");
  fs.mkdirSync(remotePath(sb), { recursive: true });
  runCli(["--init", "--from-local", "--yes"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });

  // Simulate two machines editing before any sync:
  writeLocal(sb, "desktop version of the edit\n");
  writeRemote(sb, "laptop version of the edit\n");
  const r = runCli([], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("sync exit 0 (conflict handled, not an error)", r.code === 0, `code=${r.code} ${(r.err || r.out).slice(-300)}`);

  const localDir = fs.readdirSync(sb.memDir);
  const remoteDir = fs.readdirSync(path.join(sb.remoteRoot, "lm-workbench", "memory"));
  const names = (list) => list.filter(f => /\.conflict\d+$/.test(f)).sort();
  check("local side has .conflict copies", names(localDir).length >= 2, JSON.stringify(localDir));
  check("remote side has .conflict copies", names(remoteDir).length >= 2, JSON.stringify(remoteDir));

  // BOTH original versions must still exist somewhere (no silent data loss).
  // Conflict copies are named memory.md.conflict1 / .conflict2 (not .md extension).
  const allLocal = localDir.filter(f => f.startsWith("memory.md")).map(f => fs.readFileSync(path.join(sb.memDir, f), "utf-8"));
  const allRemote = remoteDir.filter(f => f.startsWith("memory.md")).map(f => fs.readFileSync(path.join(remotePath(sb), f), "utf-8"));
  check("desktop version preserved", allLocal.some(c => c.includes("desktop version")) && allRemote.some(c => c.includes("desktop version")), "");
  check("laptop version preserved", allLocal.some(c => c.includes("laptop version")) && allRemote.some(c => c.includes("laptop version")), "");
  sb.cleanup();
}

// ---------- 10. Repeated syncs are idempotent ----------

console.log("\n[10] Repeated syncs are idempotent");
{
  const sb = sandbox();
  writeLocal(sb, "stable content\n");
  fs.mkdirSync(remotePath(sb), { recursive: true });
  runCli(["--init", "--from-local", "--yes"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });

  const r1 = runCli([], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  const r2 = runCli([], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("second sync exit 0", r1.code === 0 && r2.code === 0, `c1=${r1.code} c2=${r2.code}`);
  check("content unchanged after repeat syncs", localRead(sb) === "stable content\n" && remoteRead(sb, "memory.md") === "stable content\n", "");
  const stray = fs.readdirSync(sb.memDir).filter(f => /\.conflict\d+$/.test(f));
  check("no conflict copies spawned", stray.length === 0, JSON.stringify(stray));
  sb.cleanup();
}

// ---------- 11. Overlapping sync attempts are rejected ----------

console.log("\n[11] Lock prevents overlapping syncs");
{
  const sb = sandbox();
  writeLocal(sb, "locked test\n");
  fs.mkdirSync(remotePath(sb), { recursive: true });
  runCli(["--init", "--from-local", "--yes"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });

  // Hold the lock with a live pid (this process).
  const stateDir = path.join(path.dirname(sb.memDir), "memory-sync");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "sync.lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));

  const r = runCli([], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("second sync while locked -> exit 4", r.code === 4, `code=${r.code}`);
  check("content unchanged", localRead(sb) === "locked test\n", "");

  // Stale lock (dead pid) is taken over safely.
  fs.writeFileSync(path.join(stateDir, "sync.lock"), JSON.stringify({ pid: 999999999, ts: Date.now() }));
  const r2 = runCli([], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("stale lock is recovered -> sync runs", r2.code === 0, `code=${r2.code} ${(r2.err || r2.out).slice(-200)}`);
  sb.cleanup();
}

// ---------- 12. --status and --check report sane state ----------

console.log("\n[12] --status / --check output");
{
  const sb = sandbox();
  writeLocal(sb, "status probe\n");
  fs.mkdirSync(remotePath(sb), { recursive: true });
  runCli(["--init", "--from-local", "--yes"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  const st = runCli(["--status"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("--status shows local file", /status probe|memory\.md/.test(st.out) && st.code === 0, st.out);
  check("--status shows remote files", /memory\.md/.test(st.out), st.out);
  const ck = runCli(["--check"], sb, { LM_MEMORY_SYNC_REMOTE: remotePath(sb) });
  check("--check exit 0 with reachable remote", ck.code === 0, `code=${ck.code} ${(ck.err || ck.out).slice(-200)}`);
  check("--check shows dry-run", /Dry-run|bisync/i.test(ck.out), ck.out.slice(0, 200));
  sb.cleanup();
}

// ---------- Summary ----------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log("Failed:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
