import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTok, agentBreakdown, buildCost, priceFor, renderCost, ZERO_TOK, type CostInput } from '../src/usage.ts';
import { renderReport } from '../src/export.ts';
import { startCoban, until, ROOT, type Coban } from './helpers.ts';

const row = (id: string, profile: string, model: string, tok: CostInput['tok'], extra: Partial<CostInput> = {}): CostInput =>
  ({ id, profile, model, role: 'worker', status: 'idle', startedAt: 1000, endedAt: 61_000, tok, ...extra });
const A = { in: 1000, out: 500, cacheWrite: 2000, cacheRead: 100_000 };
const B = { in: 10, out: 20, cacheWrite: 30, cacheRead: 40 };

test('buildCost: sums, orders, groups per account and plan', () => {
  const c = buildCost([row('b', 'h2', 'm2', B, { plan: 'P' }), row('a', 'h1', 'm1', A, { plan: 'P' }), row('x', 'codex', '', null)]);
  assert.deepEqual(c.agents.map((r) => r.id), ['a', 'b', 'x'], 'most expensive first, unknown last');
  assert.equal(c.total.tokens, 3500 + 60);                       // in + out + cache write; cache read is not "spent"
  assert.deepEqual(c.total.tok, addTok(A, B));
  assert.equal(c.agents[0].ms, 60_000);
  assert.deepEqual(c.accounts.map((g) => [g.key, g.tokens]), [['h1', 3500], ['h2', 60], ['codex', 0]]);
  assert.deepEqual(c.plans.map((g) => [g.key, g.tokens, g.agents]), [['P', 3560, 2]]);
  assert.equal(buildCost([]).total.tokens, 0);
});

test('no prices → no $ anywhere; with prices → $ per agent and in total', () => {
  const rows = [row('a', 'h1', 'claude-sonnet-5-5', A), row('b', 'h2', 'other', B)];
  const none = buildCost(rows);
  assert.equal(none.pricesDefined, false);
  assert.equal(none.total.usd, undefined);
  assert.ok(none.agents.every((r) => r.usd === undefined));
  assert.doesNotMatch(renderCost(none), /~\$|\$\d/);
  assert.match(renderCost(none), /\$ gösterilmiyor/);

  const prices = { sonnet: { in: 3, out: 15, cacheRead: 0.3 } };
  const c = buildCost(rows, prices);
  const expect = ((1000 + 2000) * 3 + 500 * 15 + 100_000 * 0.3) / 1e6;
  assert.ok(Math.abs(c.agents.find((r) => r.id === 'a')!.usd! - expect) < 1e-12);
  assert.equal(c.agents.find((r) => r.id === 'b')!.usd, undefined, 'no price for that model → no $ for it');
  assert.ok(Math.abs(c.total.usd! - expect) < 1e-12);
  assert.match(renderCost(c), /~\$/);
  assert.equal(priceFor(prices, 'claude-sonnet-5-5'), prices.sonnet);
  assert.equal(priceFor({ ...prices, 'claude-sonnet-5-5': { in: 1, out: 1, cacheRead: 1 } }, 'claude-sonnet-5-5')!.in, 1, 'exact key wins');
  assert.equal(priceFor(prices, ''), undefined);
});

test('agentBreakdown: splits in / out / cache write / cache read from the session logs', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-cost-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-cwd-'));
  writeLog(cfg, cwd, [msg('m1', Date.now(), A), msg('m1', Date.now(), A), msg('m2', Date.now(), B)]);
  const p = { id: 'h1', title: 'H1', cmd: 'claude', env: { CLAUDE_CONFIG_DIR: cfg } };
  assert.deepEqual(agentBreakdown(p, cwd, Date.now() - 60_000), addTok(A, B));
  assert.deepEqual(agentBreakdown(p, cwd, Date.now() + 60_000), ZERO_TOK());
  assert.equal(agentBreakdown({ ...p, cmd: 'codex' }, cwd, 0), null);
});

test('renderReport: cost table (no $ column without prices)', () => {
  const cost = { profile: 'h1', model: 'm', role: 'worker', status: 'exited', ms: 61_000, in: 1000, out: 500, cacheWrite: 2000, cacheRead: 9000, plan: 'Plan X' };
  const e = { ts: 5000, kind: 'cost' as const, id: 'w1', text: '3500 token', cost };
  const md = renderReport([{ ts: 1000, kind: 'event', id: 'w1', text: 'işçi açıldı · H1' }, e]);
  assert.match(md, /## Maliyet/);
  assert.match(md, /\| w1 \| h1\/m \| Plan X \| 1dk 1sn \| 1k \/ 500 \/ 2k \/ 9k \| 4k \| exited \|/);
  assert.match(md, /Plan "Plan X": 4k token/);
  assert.doesNotMatch(md, /~\$/);
  assert.match(renderReport([e, { ...e, cost: { ...cost, usd: 0.5 } }]), /~\$0\.500/);
});

// ── e2e: a fake "claude" whose session logs we write ourselves ──
const encode = (d: string) => d.replace(/[^a-zA-Z0-9]/g, '-');
const msg = (id: string, ts: number, t: typeof A) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { id, usage: { input_tokens: t.in, output_tokens: t.out, cache_creation_input_tokens: t.cacheWrite, cache_read_input_tokens: t.cacheRead } } });
function writeLog(cfg: string, cwd: string, lines: string[]) {
  for (const d of new Set([cwd, fs.realpathSync(cwd)])) {
    const dir = path.join(cfg, 'projects', encode(d));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), lines.join('\n') + '\n');
  }
}

let c: Coban | undefined;
after(async () => { await c?.stop(); });

test('coban cost: live agent, then kept after kill; $ only with prices', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec ${process.execPath} ${path.join(ROOT, 'test', 'fixtures', 'fake-agent.mjs')}\n`, { mode: 0o755 });
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-cfg-'));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const prof = { id: 'h1', title: 'H1', cmd: 'claude', model: 'claude-sonnet-5-5', promptArg: '{prompt}', env: { CLAUDE_CONFIG_DIR: cfg } };
    c = await startCoban(200, 46, [prof]);
  } finally { process.env.PATH = oldPath; }
  assert.match(await c.cli('', 'spawn', 'h1', 'HEDEF: iş', '--name', 'w1'), /açıldı: w1/);
  writeLog(cfg, c.dir, [msg('m1', Date.now() + 50, A), msg('m2', Date.now() + 60, B)]);

  const j = JSON.parse(await c.cli('', 'cost', '--json'));
  assert.equal(j.pricesDefined, false);
  assert.equal(j.total.tokens, 3560);
  assert.equal(j.total.usd, undefined);
  const w1 = j.agents.find((r: any) => r.id === 'w1');
  assert.equal(w1.tokens, 3560);
  assert.equal(w1.tok.cacheRead, 100_040);
  const txt = await c.cli('', 'cost');
  assert.match(txt, /OTURUM TOPLAMI: 4k token/);
  assert.match(txt, /w1\s+h1\/sonnet-5-5\s+\S+\s+4k\s+\S+/);
  assert.match(txt, /HESAP BAŞINA\n {2}h1: 4k token/);
  assert.doesNotMatch(txt, /~\$/);

  // killed → leaves the graph but stays in the session total and in history as a 'cost' entry
  await c.cli('', 'kill', 'w1');
  await until(async () => !(await c!.cli('', 'agents')).includes('w1  '));
  const j2 = JSON.parse(await c.cli('', 'cost', '--json'));
  assert.equal(j2.total.tokens, 3560);
  assert.equal(j2.agents.find((r: any) => r.id === 'w1').status, 'kapatıldı');
  const hist = fs.readFileSync(path.join(c.dir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'cost');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].id, 'w1');
  assert.equal(hist[0].cost.in + hist[0].cost.out + hist[0].cost.cacheWrite, 3560);
  await c.stop(); c = undefined;
});

test('coban cost with config prices shows $', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec ${process.execPath} ${path.join(ROOT, 'test', 'fixtures', 'fake-agent.mjs')}\n`, { mode: 0o755 });
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-cfg-'));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const prof = { id: 'h1', title: 'H1', cmd: 'claude', model: 'claude-sonnet-5-5', promptArg: '{prompt}', env: { CLAUDE_CONFIG_DIR: cfg } };
    c = await startCoban(200, 46, [prof], { prices: { sonnet: { in: 3, out: 15, cacheRead: 0.3 } } });
  } finally { process.env.PATH = oldPath; }
  await c.cli('', 'spawn', 'h1', 'HEDEF: iş', '--name', 'w1');
  writeLog(cfg, c.dir, [msg('m1', Date.now() + 50, A)]);
  const j = JSON.parse(await c.cli('', 'cost', '--json'));
  assert.equal(j.pricesDefined, true);
  assert.ok(Math.abs(j.total.usd - ((3000 * 3 + 500 * 15 + 100_000 * 0.3) / 1e6)) < 1e-9);
  assert.match(await c.cli('', 'cost'), /\$\s+durum[\s\S]*\$0\.0\d+/);
});
