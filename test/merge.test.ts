// mergeWorktree: clean merge, conflict rollback, dirty worktree refusal, failing-test rollback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addWorktree, mergeWorktree } from '../src/orch.ts';

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
function repo(testScript = 'exit 0') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coban-merge-')));
  const r = path.join(dir, 'r'); fs.mkdirSync(r);
  g(r, 'init', '-q', '-b', 'main');
  g(r, 'config', 'user.name', 't'); g(r, 'config', 'user.email', 't@t'); // CI runners have no global git identity; mergeWorktree commits
  fs.writeFileSync(path.join(r, 'package.json'), JSON.stringify({ scripts: { test: testScript } }));
  fs.writeFileSync(path.join(r, 'a.txt'), 'base\n');
  g(r, 'add', '.'); g(r, 'commit', '-qm', 'base');
  return { r, wt: addWorktree(r, 'w') };
}
const commit = (d: string, f: string, text: string) => { fs.writeFileSync(path.join(d, f), text); g(d, 'add', '.'); g(d, 'commit', '-qm', `edit ${f}`); };

test('clean merge, --rm removes the worktree', async () => {
  const { r, wt } = repo();
  commit(wt.dir, 'b.txt', 'new\n');
  const res = await mergeWorktree(r, { worktree: wt.dir, branch: wt.branch }, { remove: true });
  assert.ok(res.merged && res.removed && res.tested === 'pass');
  assert.ok(fs.existsSync(path.join(r, 'b.txt')));
  assert.ok(!fs.existsSync(wt.dir));
  assert.match(g(r, 'log', '-1', '--format=%p'), / /, 'merge commit (--no-ff)');
});

test('conflict aborts and leaves the main tree clean', async () => {
  const { r, wt } = repo();
  commit(wt.dir, 'a.txt', 'worker\n');
  commit(r, 'a.txt', 'main\n');
  const head = g(r, 'rev-parse', 'HEAD');
  await assert.rejects(mergeWorktree(r, { worktree: wt.dir, branch: wt.branch }), /çakışma.*a\.txt/);
  assert.equal(g(r, 'status', '--porcelain'), '');
  assert.equal(g(r, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), 'main\n');
});

test('dirty worker worktree or dirty main tree is refused', async () => {
  const { r, wt } = repo();
  commit(wt.dir, 'b.txt', 'x\n');
  fs.writeFileSync(path.join(wt.dir, 'untracked.txt'), 'u');
  await assert.rejects(mergeWorktree(r, { worktree: wt.dir, branch: wt.branch }), /worktree'si kirli/);
  fs.rmSync(path.join(wt.dir, 'untracked.txt'));
  fs.appendFileSync(path.join(r, 'a.txt'), 'dirty\n');
  await assert.rejects(mergeWorktree(r, { worktree: wt.dir, branch: wt.branch }), /ana ağaç temiz değil/);
  await assert.rejects(mergeWorktree(r, { worktree: wt.dir, branch: '--evil' }), /geçersiz dal adı/);
});

test('failing test rolls the merge back; --no-test skips it', async () => {
  const { r, wt } = repo('echo BOOM; exit 3');
  commit(wt.dir, 'b.txt', 'x\n');
  const head = g(r, 'rev-parse', 'HEAD');
  await assert.rejects(mergeWorktree(r, { worktree: wt.dir, branch: wt.branch }), /test başarısız[\s\S]*BOOM/);
  assert.equal(g(r, 'rev-parse', 'HEAD'), head);
  assert.ok(!fs.existsSync(path.join(r, 'b.txt')));
  const res = await mergeWorktree(r, { worktree: wt.dir, branch: wt.branch }, { test: false });
  assert.ok(res.merged && res.tested === 'skipped');
});
