// Orchestration helpers used by the hub: git worktrees for isolated workers and the verify gate's command runner.
import fs from 'node:fs';
import path from 'node:path';
import { exec, execFileSync } from 'node:child_process';

// Per-worker extras set at spawn time (`--worktree`, `--verify`).
export type Job = {
  worktree?: string;       // directory of the git worktree coban created for this worker
  branch?: string;
  verify?: string;         // shell command run in the worker's cwd whenever it settles after working
  verifyState?: 'running' | 'pass' | 'fail' | 'gaveup';
  verifyTries: number;
};

// A spawn waiting for other agents (`--after`).
export type Queued = { id: string; after: string[]; spawn: { profile: string; task?: string; cwd?: string; worktree?: string | true; verify?: string } };

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e: any) {
    throw new Error(`git ${args[0]}: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  }
}

// New worktree next to the repo (<repo>-<id>) on branch `branch` (default coban/<id>; reused if it already exists).
export function addWorktree(base: string, id: string, branch?: string): { dir: string; branch: string } {
  const root = git(base, 'rev-parse', '--show-toplevel');
  const br = branch || `coban/${id}`;
  let dir = path.join(path.dirname(root), `${path.basename(root)}-${id}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(path.dirname(root), `${path.basename(root)}-${id}-${n}`);
  let exists = true;
  try { git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${br}`); } catch { exists = false; }
  git(root, 'worktree', 'add', ...(exists ? [dir, br] : ['-b', br, dir]));
  return { dir, branch: br };
}

// Removes the worktree directory (refuses when it has uncommitted changes). The branch is kept: it may hold the work.
export function removeWorktree(dir: string) {
  const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  git(path.dirname(common), 'worktree', 'remove', dir);
}

export function runVerify(cmd: string, cwd: string, timeoutMs = 600_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, shell: '/bin/sh', timeout: timeoutMs, maxBuffer: 16 << 20 }, (err: any, so, se) => {
      const out = `${so}${se ? (so ? '\n' : '') + se : ''}`;
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: err?.killed ? out + '\n(zaman aşımı)' : out });
    });
  });
}

export function tail(text: string, lines = 40, chars = 3000): string {
  let t = text.trimEnd().split('\n').slice(-lines).join('\n');
  if (t.length > chars) t = '…' + t.slice(-chars);
  return t;
}

// Config `verifyAllow`: when set, a verify command must fully match one of these regexes; unset keeps the old behaviour.
export function checkVerify(cmd: string | undefined, allow: string[] | undefined) {
  if (!cmd || !allow) return;
  if (!allow.some((r) => new RegExp(`^(?:${r})$`).test(cmd))) throw new Error(`doğrulama komutu verifyAllow listesinde değil: ${cmd}`);
}
