import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Profile = {
  id: string;
  title: string;
  cmd: string;                       // shell command that starts the agent
  promptArg?: string;                // how an initial task is passed, "{prompt}" is replaced (already quoted)
  env?: Record<string, string>;
  color?: string;
};

export type Config = { orchestrator: string; profiles: Profile[] };

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const BIN_DIR = path.join(ROOT, 'bin');
export const STATE_DIR = path.join(os.homedir(), '.coban');
export const SOCK = process.env.COBAN_SOCK || path.join(STATE_DIR, 'coban.sock');
export const CONFIG_PATH = process.env.COBAN_CONFIG || path.join(os.homedir(), '.config', 'coban', 'config.json');

// Claude may run `coban ...` without a permission prompt.
const OPUS = "claude --model claude-opus-5-5 --allowedTools 'Bash(coban:*)'";
const claude = (n: number, color: string): Profile => ({
  id: `h${n}`,
  title: `Claude H${n}`,
  cmd: OPUS,
  promptArg: '-- {prompt}',
  env: { CLAUDE_CONFIG_DIR: `~/.claude-hesap${n}` },
  color,
});

export const DEFAULT_CONFIG: Config = {
  orchestrator: 'h1',
  profiles: [
    claude(1, '#F6D5C8'),
    claude(2, '#FFD9A0'),
    claude(3, '#C8E6C9'),
    { id: 'codex', title: 'Codex', cmd: 'codex', promptArg: '{prompt}', color: '#8FDBFF' },
    { id: 'opencode', title: 'OpenCode', cmd: 'opencode', promptArg: '--prompt {prompt}', color: '#B5E48C' },
    { id: 'cursor', title: 'Cursor', cmd: 'cursor-agent', promptArg: '{prompt}', color: '#D0B3FF' },
  ],
};

const expand = (v: string) => v.replace(/^~(?=\/|$)/, os.homedir());

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
  for (const p of cfg.profiles) {
    for (const k of Object.keys(p.env ?? {})) p.env![k] = expand(p.env![k]);
  }
  return cfg;
}
