// Per-worker token usage, limit forecast and persistent history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentTokens, forecast, fmtEta, profileUsage } from '../src/usage.ts';
import { appendHistory, readHistory } from '../src/history.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coban-obs-'));

test('agentTokens: only the worker project since it started; non-Claude is unknown', () => {
  const d = tmp(), cwd = tmp();
  const now = Date.now();
  const line = (id: string, ago: number, out: number) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - ago).toISOString(), message: { id, usage: { output_tokens: out } } });
  const mine = path.join(d, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(mine, { recursive: true });
  fs.mkdirSync(path.join(d, 'projects', 'other'), { recursive: true });
  fs.writeFileSync(path.join(mine, 's.jsonl'), [line('a', 60_000, 100), line('b', 120_000, 50), line('old', 3600_000, 999)].join('\n'));
  fs.writeFileSync(path.join(d, 'projects', 'other', 's.jsonl'), line('x', 1000, 7777));
  const p = { id: 'h1', title: 'H1', cmd: 'claude', env: { CLAUDE_CONFIG_DIR: d } };
  assert.equal(agentTokens(p, cwd, now - 300_000, now), 150);
  assert.equal(agentTokens({ id: 'c', title: 'C', cmd: 'codex' }, cwd, 0, now), null);
});

test('forecast: remaining budget and time to limit at the 30 min pace', () => {
  const now = Date.now(), d = tmp();
  const proj = path.join(d, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date(now - 60_000).toISOString(), message: { id: 'm', usage: { output_tokens: 300 } } }));
  const u = profileUsage({ id: 'h1', title: 'H1', cmd: 'claude', env: { CLAUDE_CONFIG_DIR: d }, limit5h: 1000 }, undefined, now);
  assert.equal(u.used30m, 300);
  const f = forecast(u)!;
  assert.equal(f.remaining, 700);
  assert.equal(f.remainPct, 0.7);
  assert.ok(Math.abs(f.etaMs! - 700 / (300 / (30 * 60_000))) < 1);
  assert.equal(forecast({ ...u, used30m: 0 })!.etaMs, null);
  assert.equal(forecast({ ...u, limit5h: 0 }), null);
  assert.equal(fmtEta(90 * 60_000), '~1.5s');
});

test('history: append, limit, torn line skipped', () => {
  const f = path.join(tmp(), 'h.jsonl');
  assert.deepEqual(readHistory(10, f), []);
  for (let i = 0; i < 5; i++) appendHistory({ ts: i, kind: i % 2 ? 'msg' : 'event', id: 'a', to: 'b', text: 'n' + i }, f);
  fs.appendFileSync(f, '{torn\n');
  const r = readHistory(3, f);
  assert.deepEqual(r.map((e) => e.text), ['n2', 'n3', 'n4']);
  appendHistory({ ts: 9, kind: 'event', id: 'a', text: 'x'.repeat(5000) }, f);
  assert.ok(readHistory(1, f)[0].text.length < 2100);
});
