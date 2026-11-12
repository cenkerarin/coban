import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, Profile } from './config.ts';

// Per-account usage read from Claude Code's own session logs
// (CLAUDE_CONFIG_DIR/projects/**/*.jsonl). "used" = input + output + cache_creation tokens;
// cache_read is cheap and excluded. Non-Claude profiles have no logs: used=0, limit5h=0.
export type AccountUsage = {
  profileId: string;
  title: string;
  used5h: number;
  used7d: number;
  used30m: number;        // recent burn, for the time-to-limit estimate
  limit5h: number;
  pct5h: number;          // used5h / limit5h, can exceed 1; 0 when unknown
  resetAt: number | null; // oldest message in the 5h window + 5h
  limited: boolean;       // one of this account's agents hit a limit in the last 5h
};

export const WINDOW_5H = 5 * 3600_000;
const WINDOW_30M = 30 * 60_000;
const WINDOW_7D = 7 * 24 * 3600_000;
// Rough per-5h budget (tokens) when the profile sets no limit5h. Plans differ; tune it in config.json.
export const DEFAULT_LIMIT_5H = 5_000_000;

type Entry = { ts: number; tokens: number };
type FileCache = { mtime: number; size: number; entries: Map<string, Entry> };
const cache = new Map<string, FileCache>(); // keeps hub-side re-scans cheap

export const isClaude = (p: Profile) => /^claude\b/.test(p.cmd.trim());
const configDir = (p: Profile) => p.env?.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function jsonlFiles(dir: string, since: number, out: string[] = []): string[] {
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(f, since, out);
    else if (e.name.endsWith('.jsonl')) {
      try { if (fs.statSync(f).mtimeMs >= since) out.push(f); } catch {}
    }
  }
  return out;
}

// One entry per API message: Claude Code writes a line per content block, all sharing message.id.
function readFile(f: string): Map<string, Entry> {
  const st = fs.statSync(f);
  const c = cache.get(f);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.entries;
  const entries = new Map<string, Entry>();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const u = d?.message?.usage;
    if (d.type !== 'assistant' || !u) continue;
    const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const key = d.message.id ?? d.requestId ?? d.uuid;
    const prev = entries.get(key);
    if (!prev || tokens > prev.tokens) entries.set(key, { ts: Date.parse(d.timestamp), tokens });
  }
  cache.set(f, { mtime: st.mtimeMs, size: st.size, entries });
  return entries;
}

export function profileUsage(p: Profile, limitedAt?: number, now = Date.now()): AccountUsage {
  const limited = !!limitedAt && now - limitedAt < WINDOW_5H;
  const base = { profileId: p.id, title: p.title, limited };
  if (!isClaude(p)) return { ...base, used5h: 0, used7d: 0, used30m: 0, limit5h: 0, pct5h: 0, resetAt: null };
  const limit5h = p.limit5h ?? DEFAULT_LIMIT_5H;
  const seen = new Set<string>(); // a message can appear in several files (resumed/forked sessions)
  let used5h = 0, used7d = 0, used30m = 0, oldest5h = Infinity;
  for (const f of jsonlFiles(path.join(configDir(p), 'projects'), now - WINDOW_7D)) {
    let entries: Map<string, Entry>;
    try { entries = readFile(f); } catch { continue; }
    for (const [id, e] of entries) {
      if (!(now - e.ts < WINDOW_7D) || seen.has(id)) continue;
      seen.add(id);
      used7d += e.tokens;
      if (now - e.ts < WINDOW_30M) used30m += e.tokens;
      if (now - e.ts < WINDOW_5H) { used5h += e.tokens; oldest5h = Math.min(oldest5h, e.ts); }
    }
  }
  return { ...base, used5h, used7d, used30m, limit5h, pct5h: used5h / limit5h, resetAt: oldest5h === Infinity ? null : oldest5h + WINDOW_5H };
}

// Least-spent account first; accounts with unknown usage (non-Claude) last, limited ones after the rest.
export function sortUsage(list: AccountUsage[]): AccountUsage[] {
  const rank = (u: AccountUsage) => (u.limited ? 2 : 0) + (u.limit5h ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.pct5h - b.pct5h || a.used7d - b.used7d);
}

// limitedAt: profileId → last time one of its agents went 'limited' (the hub tracks this).
export function allUsage(cfg: Config, limitedAt?: Map<string, number>): AccountUsage[] {
  const now = Date.now();
  return sortUsage(cfg.profiles.map((p) => profileUsage(p, limitedAt?.get(p.id), now)));
}

// Claude Code stores a project's logs under projects/<cwd with every non-alphanumeric char replaced by '-'>.
const encodeCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// Tokens one worker has spent: its project's logs since it started. Approximate when several agents of the
// same account share a cwd (they are counted together). null = unknown (non-Claude CLI).
export function agentTokens(p: Profile, cwd: string, since: number, now = Date.now()): number | null {
  if (!isClaude(p)) return null;
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch {}
  const seen = new Set<string>();
  let total = 0;
  for (const c of new Set([cwd, real])) {
    for (const f of jsonlFiles(path.join(configDir(p), 'projects', encodeCwd(c)), since)) {
      let entries: Map<string, Entry>;
      try { entries = readFile(f); } catch { continue; }
      for (const [id, e] of entries) {
        if (e.ts < since || e.ts > now || seen.has(id)) continue;
        seen.add(id);
        total += e.tokens;
      }
    }
  }
  return total;
}

export type Forecast = { remaining: number; remainPct: number; etaMs: number | null };

// What is left of an account's 5h budget, and (at the last 30 min's pace) how long until it runs out.
export function forecast(u: AccountUsage): Forecast | null {
  if (!u.limit5h) return null;
  const remaining = Math.max(0, u.limit5h - u.used5h);
  const rate = u.used30m / WINDOW_30M; // tokens per ms
  return { remaining, remainPct: remaining / u.limit5h, etaMs: !remaining ? 0 : rate > 0 ? remaining / rate : null };
}

export const fmtTokens = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
export const fmtEta = (ms: number | null) => (ms === null ? '' : ms >= 3600_000 ? `~${(ms / 3600_000).toFixed(1)}s` : `~${Math.max(1, Math.round(ms / 60_000))}dk`);
