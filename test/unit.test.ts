// Pure functions: context packing, screen compaction, usage accounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoMap, snippets } from '../src/context.ts';
import { compactScreen } from '../src/hub.ts';
import { profileUsage, sortUsage, WINDOW_5H } from '../src/usage.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coban-unit-'));

test('snippets: symbols, line ranges, python, missing symbols keep their order', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.ts'), [
    'export function one(x: number) {',
    '  if (x) { return `${x}`; }',
    '  return "}";',
    '}',
    'class K {',
    '  method(a: string) {',
    '    return a;',
    '  }',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(d, 'b.py'), 'def f(x):\n    return x\n\ndef g():\n    pass\n');
  const s = snippets(['a.ts#one,nope,method', 'a.ts:5-6', 'b.py#f'], d);
  assert.match(s, /### a\.ts#one {2}\(satır 1-4\)/);
  assert.ok(s.indexOf('#nope') > s.indexOf('#one') && s.indexOf('#nope') < s.indexOf('#method'), 'missing symbol stays in order');
  assert.match(s, /### a\.ts#method {2}\(satır 6-8\)/);
  assert.match(s, /### a\.ts:5-6/);
  assert.match(s, /### b\.py#f {2}\(satır 1-2\)\n {3}1│ def f\(x\):\n {3}2│ {5}return x(\n|$)/);
  assert.equal(snippets([], d), '');
});

test('repoMap lists files with line counts and symbols', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src', 'x.ts'), 'export const A = 1;\nexport function b() {}\n');
  fs.writeFileSync(path.join(d, 'notes.txt'), 'hi\n');
  const m = repoMap(d);
  assert.match(m, /^src\/x\.ts \(3\) {2}A:1 b:2$/m);
  assert.match(m, /^notes\.txt \(2\)$/m);
});

test('compactScreen drops agent UI chrome and blank runs', () => {
  const screen = [
    '⏺ Edited src/hub.ts',
    '',
    '',
    '  ⎿  2 lines changed',
    '────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt',
  ].join('\n');
  assert.equal(compactScreen(screen, 20), '⏺ Edited src/hub.ts\n\n  ⎿  2 lines changed');
  assert.equal(compactScreen(screen, 1), '  ⎿  2 lines changed');
});

test('usage: windows, dedupe by message id, cache reads excluded, sorting', () => {
  const d = tmp();
  const proj = path.join(d, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const now = Date.now();
  const line = (id: string, ago: number, u: object) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - ago).toISOString(), message: { id, usage: u } });
  fs.writeFileSync(path.join(proj, 's.jsonl'), [
    line('m1', 60_000, { input_tokens: 10, output_tokens: 90, cache_creation_input_tokens: 100, cache_read_input_tokens: 1e6 }),
    line('m1', 60_000, { input_tokens: 10, output_tokens: 90, cache_creation_input_tokens: 100 }), // same message, another block
    line('m2', WINDOW_5H + 60_000, { input_tokens: 0, output_tokens: 1000 }),                     // outside 5h, inside 7d
    line('m3', 8 * 24 * 3600_000, { output_tokens: 1e6 }),                                        // outside 7d
  ].join('\n'));
  const p = { id: 'h1', title: 'H1', cmd: 'claude', env: { CLAUDE_CONFIG_DIR: d }, limit5h: 1000 };
  const u = profileUsage(p, undefined, now);
  assert.equal(u.used5h, 200);
  assert.equal(u.used7d, 1200);
  assert.equal(u.pct5h, 0.2);
  assert.ok(u.resetAt && Math.abs(u.resetAt - (now - 60_000 + WINDOW_5H)) < 1000);

  const other = profileUsage({ id: 'codex', title: 'Codex', cmd: 'codex' }, undefined, now);
  assert.equal(other.limit5h, 0, 'non-Claude usage is unknown');
  const sorted = sortUsage([other, { ...u, profileId: 'busy', pct5h: 0.9 }, u, { ...u, profileId: 'lim', limited: true }]);
  assert.deepEqual(sorted.map((x) => x.profileId), ['h1', 'busy', 'codex', 'lim']);
});
