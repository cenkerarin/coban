import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

export type Profile = {
  id: string;
  title: string;
  cmd: string;                       // shell command that starts the agent
  model?: string;                    // appended as `--model <model>` (claude, codex, opencode and cursor-agent all accept it)
  promptArg?: string;                // how an initial task is passed, "{prompt}" is replaced (already quoted)
  env?: Record<string, string>;
  color?: string;
  limit5h?: number;                  // token budget per 5h window for `coban usage` (claude only; default in usage.ts)
  network?: boolean;                 // codex: opt in to network access inside its sandbox (see launchFor in hub.ts); off by default
};

export type Config = {
  orchestrator: string;          // profile preselected in the orchestrator picker
  orchestratorModel?: string;    // overrides the profile's model when it runs as orchestrator
  notify?: boolean;              // macOS notification when a worker waits for permission or hits a limit (default true)
  chatWidth?: number;            // chat column's share of the screen, 0.3-0.6; ^b ←/→ (or < / >) change and save it
  feedHidden?: boolean;          // feed column hidden (^b l); saved so the panel layout survives restarts
  rules?: ApprovalRule[];        // standing approvals, see `coban rule`; none by default
  verifyAllow?: string[];        // spawn --verify: when set, only commands fully matching one of these regexes may run
  verifyTries?: number;          // spawn --verify: how many failed runs are sent back to the worker before giving up (default 3)
  profiles: Profile[];
};

// Standing approval: a permission prompt is answered "yes" automatically when `match` (a regex, anchored: it must
// match the WHOLE prompt text as `coban approvals` shows it: title and every content line of the dialog, joined by
// " · ") fits and, if given, the agent runs in `cwd` (or below it) and uses `profile`.
export type ApprovalRule = { match: string; cwd?: string; profile?: string };

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const BIN_DIR = path.join(ROOT, 'bin');
export const STATE_DIR = path.join(os.homedir(), '.coban');
export const DEFAULT_SOCK = path.join(STATE_DIR, 'coban.sock');
export const SOCK = process.env.COBAN_SOCK || DEFAULT_SOCK;
// The human's credential for the hub socket: a random token written (0600) next to the socket each time coban starts.
// Agents get their own per-agent token in COBAN_TOKEN instead and never this one (see Hub.spawn / cli.ts call).
export const TOKEN_PATH = SOCK.replace(/\.sock$/, '') + '.token';
export const CONFIG_PATH = process.env.COBAN_CONFIG || path.join(os.homedir(), '.config', 'coban', 'config.json');

export const OPUS = 'claude-opus-5-5';
export const SONNET = 'claude-sonnet-5-5';

// Claude may run `coban ...` without a permission prompt.
const CLAUDE_CMD = "claude --allowedTools 'Bash(coban:*)'";
const claude = (n: number, model: string, color: string): Profile => ({
  id: `h${n}`,
  title: `Claude H${n}`,
  cmd: CLAUDE_CMD,
  model,
  promptArg: '-- {prompt}',
  env: { CLAUDE_CONFIG_DIR: `~/.claude-hesap${n}` },
  color,
});

const COLORS = ['#F6D5C8', '#FFD9A0', '#C8E6C9', '#FFC8DD', '#BDE0FE', '#E2CFEA'];

// `coban account add`: the next free hN, its config dir, and a profile ready to append to the config file.
export function nextAccount(cfg: Config): { profile: Profile; dir: string } {
  const used = new Set(cfg.profiles.map((p) => p.id));
  let n = 1;
  while (used.has(`h${n}`)) n++;
  return { profile: claude(n, SONNET, COLORS[(n - 1) % COLORS.length]), dir: path.join(os.homedir(), `.claude-hesap${n}`) };
}

export function saveLayout(patch: Pick<Config, 'chatWidth' | 'feedHidden'>) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;   // raw file: keep `~` paths unexpanded
  Object.assign(raw, patch);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
}
export const saveChatWidth = (share: number) => saveLayout({ chatWidth: share });

export function saveRules(rules: ApprovalRule[]) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
  raw.rules = rules;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
}

// Anchored on purpose: a rule for `rm -rf build` must never fire for `rm -rf build /`.
export function ruleRegex(match: string): RegExp {
  if (!match.trim()) throw new Error('boş regex olmaz');
  if (match.length > 500) throw new Error('regex çok uzun (en fazla 500 karakter)');
  return new RegExp(`^(?:${match})$`);
}

// Regexes from config (rules, verifyAllow) run against text an agent controls (its screen, its verify command):
// a pattern with catastrophic backtracking must not freeze the hub. Each test runs under a time limit; over it,
// or over MAX_MATCH_TEXT, counts as no match.
const MATCH_MS = 50;
export const MAX_MATCH_TEXT = 4000;
const reCtx = vm.createContext({ re: /$^/, s: '' });
const reRun = new vm.Script('re.test(s)');
export function safeTest(re: RegExp, text: string): boolean {
  if (text.length > MAX_MATCH_TEXT) return false;
  reCtx.re = re; reCtx.s = text;
  try { return reRun.runInContext(reCtx, { timeout: MATCH_MS }) === true; } catch { return false; } finally { reCtx.s = ''; }
}

// Agent ids end up in file names (worktree dir, .coban/reports/<id>.md), env and messages: keep them plain.
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
export function checkName(name: string, what = 'ad') {
  if (!NAME_RE.test(name) || name.includes('..')) throw new Error(`geçersiz ${what}: ${JSON.stringify(name)} (harf, rakam, . _ - ; en fazla 48)`);
}

export function ruleMatches(r: ApprovalRule, text: string, cwd: string, profile: string): boolean {
  if (r.profile && r.profile !== profile) return false;
  if (r.cwd) {
    const d = path.resolve(expand(r.cwd));
    if (cwd !== d && !cwd.startsWith(d + path.sep)) return false;
  }
  let re: RegExp;
  try { re = ruleRegex(r.match); } catch { return false; }
  return safeTest(re, text);
}

export function appendProfile(p: Profile) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;   // raw file: keep `~` paths unexpanded
  raw.profiles.push(p);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
}

const onPath = (bin: string) =>
  (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));

// First run on a fresh machine: only offer what is actually installed. A single `claude` login (~/.claude) becomes
// h1; extra accounts (h2, h3) appear only when their own config dir (~/.claude-hesapN) already exists.
export function detectConfig(): Config {
  const profiles: Profile[] = [];
  if (onPath('claude')) {
    const h1 = claude(1, OPUS, '#F6D5C8');
    if (!fs.existsSync(path.join(os.homedir(), '.claude-hesap1'))) delete h1.env;
    profiles.push(h1);
    for (const n of [2, 3]) {
      if (fs.existsSync(path.join(os.homedir(), `.claude-hesap${n}`))) profiles.push(claude(n, SONNET, n === 2 ? '#FFD9A0' : '#C8E6C9'));
    }
  }
  for (const p of DEFAULT_CONFIG.profiles) {
    if (!p.id.match(/^h\d$/) && onPath(p.cmd.split(' ')[0])) profiles.push(p);
  }
  if (!profiles.length) return DEFAULT_CONFIG;   // nothing found: keep the full template to edit
  const orchestrator = profiles[0].id;
  const cfg: Config = { ...DEFAULT_CONFIG, orchestrator, profiles };
  if (!/^h\d$/.test(orchestrator)) delete cfg.orchestratorModel;   // the Sonnet override is a Claude model id
  return cfg;
}

export const DEFAULT_CONFIG: Config = {
  orchestrator: 'h1',
  // Coordination is mostly reading and routing, so the orchestrator runs on Sonnet;
  // h1 keeps Opus for heavy coding work when it runs as a worker.
  orchestratorModel: SONNET,
  profiles: [
    claude(1, OPUS, '#F6D5C8'),
    claude(2, SONNET, '#FFD9A0'),
    claude(3, SONNET, '#C8E6C9'),
    { id: 'codex', title: 'Codex', cmd: 'codex', promptArg: '{prompt}', color: '#8FDBFF' },
    { id: 'opencode', title: 'OpenCode', cmd: 'opencode', promptArg: '--prompt {prompt}', color: '#B5E48C' },
    { id: 'cursor', title: 'Cursor', cmd: 'cursor-agent', promptArg: '{prompt}', color: '#D0B3FF' },
  ],
};

const expand = (v: string) => v.replace(/^~(?=\/|$)/, os.homedir());

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(detectConfig(), null, 2) + '\n');
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
  for (const p of cfg.profiles) {
    // Older configs baked the model into cmd; lift it into `model` so overrides work.
    const m = p.cmd.match(/\s--model[ =](\S+)/);
    if (m) { p.model ??= m[1]; p.cmd = p.cmd.replace(m[0], ''); }
    for (const k of Object.keys(p.env ?? {})) p.env![k] = expand(p.env![k]);
  }
  return cfg;
}
