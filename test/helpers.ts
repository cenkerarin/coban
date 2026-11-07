// Shared helpers: run a real coban TUI inside a pseudo-terminal with fake agents, drive it through the CLI,
// and read what it drew through a headless xterm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BIN = path.join(ROOT, 'bin', 'coban');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-agent.mjs');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(f: () => boolean | Promise<boolean>, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await sleep(step);
  }
}

export type Profile = { id: string; title: string; cmd: string; promptArg?: string; color?: string; env?: Record<string, string> };
export const fakeProfile = (id = 'fake', title = 'Fake', color = '#8FDBFF'): Profile =>
  ({ id, title, cmd: `${process.execPath} ${FAKE}`, promptArg: '{prompt}', color });

export type Coban = {
  dir: string;
  term: any;
  cli: (as: string, ...args: string[]) => Promise<string>;
  screen: () => string;
  write: (s: string) => void;
  bytes: () => number;
  stop: () => Promise<void>;
};

export async function startCoban(cols = 200, rows = 46, profiles: Profile[] = [fakeProfile()], extra: Record<string, unknown> = {}): Promise<Coban> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-'));
  const sock = path.join(dir, 's.sock'); // unix socket paths are limited to ~104 bytes
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    orchestrator: profiles[0].id,
    profiles,
    ...extra,
  }));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    COBAN_CONFIG: path.join(dir, 'config.json'), COBAN_SOCK: sock,
    PATH: `${path.join(ROOT, 'bin')}:${path.dirname(process.execPath)}:${process.env.PATH}`,
  };
  delete env.COBAN_AGENT;
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  let bytes = 0;
  const p = pty.spawn(BIN, [], { cols, rows, cwd: dir, env, name: 'xterm-256color' });
  p.onData((d: string) => { bytes += d.length; term.write(d); });
  let exited = false;
  p.onExit(() => { exited = true; });

  const cli = (as: string, ...args: string[]) => new Promise<string>((resolve) =>
    execFile(BIN, args, { cwd: dir, encoding: 'utf8', env: as ? { ...env, COBAN_AGENT: as } : env },
      (err, so, se) => resolve(err ? `ERR ${se}` : so.trimEnd())));
  const screen = () => {
    const b = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < rows; y++) lines.push(b.getLine(y)?.translateToString(true).replace(/\s+$/, '') ?? '');
    return lines.join('\n');
  };
  await until(async () => !(await cli('', 'agents')).startsWith('ERR'));
  return {
    dir, term, cli, screen, write: (s) => p.write(s), bytes: () => bytes,
    stop: async () => {
      if (!exited) { p.write('\x02q'); await until(() => exited, 3000).catch(() => p.kill()); }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
