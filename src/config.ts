import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Profile = {
  id: string;
  title: string;
  cmd: string;                       // shell command that starts the agent
  model?: string;                    // appended as `--model <model>` (claude, codex, opencode and cursor-agent all accept it)
  promptArg?: string;                // how an initial task is passed, "{prompt}" is replaced (already quoted)
  env?: Record<string, string>;
  color?: string;
  limit5h?: number;                  // token budget per 5h window for `coban usage` (claude only; default in usage.ts)
};

export type Config = {
  orchestrator: string;          // profile preselected in the orchestrator picker
  orchestratorModel?: string;    // overrides the profile's model when it runs as orchestrator
  chatWidth?: number;            // chat column's share of the screen, 0.3-0.6; ^b ←/→ (or < / >) change and save it
  profiles: Profile[];
};

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const BIN_DIR = path.join(ROOT, 'bin');
export const STATE_DIR = path.join(os.homedir(), '.coban');
export const DEFAULT_SOCK = path.join(STATE_DIR, 'coban.sock');
export const SOCK = process.env.COBAN_SOCK || DEFAULT_SOCK;
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

export function saveChatWidth(share: number) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;   // raw file: keep `~` paths unexpanded
  raw.chatWidth = share;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
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
