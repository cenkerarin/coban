// Orchestration helpers used by the hub: git worktrees for isolated workers and the verify gate's command runner.
import fs from 'node:fs';
import path from 'node:path';
import { exec, execFileSync } from 'node:child_process';
import { safeTest } from './config.ts';

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
  // A branch name is passed to git as an argument: never let it read as an option, and only accept valid ref names.
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(br) || br.includes('..')) throw new Error(`geçersiz dal adı: ${JSON.stringify(br)}`);
  git(root, 'check-ref-format', '--branch', br);
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
  const ok = allow.some((r) => { try { return safeTest(new RegExp(`^(?:${r})$`), cmd); } catch { return false; } });
  if (!ok) throw new Error(`doğrulama komutu verifyAllow listesinde değil: ${cmd}`);
}

export type MergeResult = { id?: string; branch: string; merged: boolean; upToDate?: boolean; tested?: 'pass' | 'skipped'; removed?: boolean; head: string; summary: string };

// Merges a worker's worktree branch into the branch checked out in `repo` (--no-ff). The main tree is left exactly as it was
// on a conflict (merge --abort) or a failing test (reset to the pre-merge commit). Throws with a readable message on refusal.
export async function mergeWorktree(repo: string, job: { worktree?: string; branch?: string }, opts: { test?: boolean; remove?: boolean } = {}): Promise<MergeResult> {
  const { worktree, branch } = job;
  if (!worktree || !branch) throw new Error('bu işçinin worktree dalı yok (--worktree ile açılmamış)');
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) || branch.includes('..')) throw new Error(`geçersiz dal adı: ${JSON.stringify(branch)}`);
  const root = git(repo, 'rev-parse', '--show-toplevel');
  if (git(worktree, 'status', '--porcelain')) throw new Error(`işçinin worktree'si kirli (commit edilmemiş değişiklik): ${worktree}`);
  if (path.resolve(git(worktree, 'rev-parse', '--show-toplevel')) === path.resolve(root)) throw new Error('hedef dal işçinin kendi worktree\'si; ana repoda çalıştır');
  if (git(root, 'status', '--porcelain', '--untracked-files=no')) throw new Error(`ana ağaç temiz değil: ${root}`);
  const current = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (current === branch) throw new Error(`ana ağaç zaten ${branch} dalında`);
  git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  const before = git(root, 'rev-parse', 'HEAD');
  const res = (r: Partial<MergeResult> & { merged: boolean; summary: string }): MergeResult => ({ branch, head: git(root, 'rev-parse', '--short', 'HEAD'), ...r });

  try {
    execFileSync('git', ['-C', root, 'merge', '--no-ff', '--no-edit', branch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) {
    let files: string[] = [];
    try { files = git(root, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean); } catch {}
    try { git(root, 'merge', '--abort'); } catch { try { git(root, 'reset', '--hard', before); } catch {} }
    if (files.length) throw new Error(`çakışma, birleştirme geri alındı (${branch}): ${files.join(', ')}`);
    throw new Error(`birleştirme başarısız, geri alındı: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  }
  if (git(root, 'rev-parse', 'HEAD') === before) return res({ merged: false, upToDate: true, summary: `${branch} zaten güncel, birleştirilecek bir şey yok` });

  let tested: 'pass' | 'skipped' = 'skipped';
  if (opts.test !== false) {
    let hasTest = false;
    try { hasTest = !!JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))?.scripts?.test; } catch {}
    if (hasTest) {
      const t = await runVerify('npm test', root);
      if (t.code !== 0) {
        git(root, 'reset', '--hard', before);
        throw new Error(`test başarısız (çıkış ${t.code}), birleştirme geri alındı (${branch}):\n${tail(t.out, 20, 2000)}`);
      }
      tested = 'pass';
    }
  }
  let removed = false;
  if (opts.remove) { removeWorktree(worktree); removed = true; }
  return res({ merged: true, tested, removed, summary: `${branch} → ${current} birleştirildi (${git(root, 'rev-parse', '--short', 'HEAD')}), test: ${tested === 'pass' ? 'geçti' : 'atlandı'}${removed ? ', worktree silindi' : ''}` });
}
