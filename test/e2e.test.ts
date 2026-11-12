// End to end: the real TUI in a pty, fake agents, every coordination command through the CLI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startCoban, until, sleep, type Coban } from './helpers.ts';

let c: Coban;
after(async () => { await c?.stop(); });

test('orchestrator, workers, messages, board and rendering', async () => {
  c = await startCoban();
  assert.match(c.screen(), /ORKESTRATÖR/, 'graph shows the empty orchestrator bubble');

  // pick the orchestrator from the + bubble (Enter opens the picker, 1 picks the first profile)
  c.write('\r'); await sleep(300); c.write('1');
  await until(async () => (await c.cli('', 'agents')).includes('★'));

  assert.equal(await c.cli('orkestra', 'spawn', 'fake', 'HEDEF: yaz POST', '--name', 'w1'), 'açıldı: w1');
  assert.equal(await c.cli('orkestra', 'spawn', 'fake', 'HEDEF: sor ASK', '--name', 'w2'), 'açıldı: w2');

  // wait reports both settling: w2 blocked on its permission question, w1 idle
  const settled = new Set<string>();
  for (let i = 0; i < 4 && settled.size < 2; i++) {
    const r = await c.cli('orkestra', 'wait', 'w1', 'w2', '--timeout', '10');
    for (const m of r.matchAll(/(w[12]) (idle|blocked)/g)) settled.add(`${m[1]} ${m[2]}`);
  }
  assert.ok(settled.has('w2 blocked'), [...settled].join());
  assert.ok(settled.has('w1 idle'), [...settled].join());
  assert.match(await c.cli('', 'read', 'w2'), /Do you want to proceed/);

  // w1 messaged the orchestrator from inside its pty ("POST")
  assert.match(await c.cli('', 'log'), /w1→orkestra: w1 bitirdi/);

  // board: the author does not get its own note back, others get it exactly once
  await c.cli('w1', 'post', 'all', 'şema değişti');
  assert.equal(await c.cli('w1', 'inbox'), '(yeni mesaj yok)');
  assert.match(await c.cli('w2', 'inbox'), /\[ortak\] w1: şema değişti/);
  assert.equal(await c.cli('w2', 'inbox'), '(yeni mesaj yok)');
  assert.match(fs.readFileSync(path.join(c.dir, '.coban', 'board-s.md'), 'utf8'), /\*\*w1\*\*: şema değişti/);

  // answering the permission question unblocks w2
  await c.cli('orkestra', 'key', 'w2', 'y', 'enter');
  await until(async () => (await c.cli('', 'read', 'w2')).includes('approved'));

  // three-column layout: feed on the left, bubbles in the middle, chat title on the right
  await until(() => /Konuşmalar/.test(c.screen()) && /w2/.test(c.screen()));
  const s = c.screen();
  assert.match(s, /◆ Konuşmalar/);
  assert.match(s, /SOHBET/);
  assert.match(s, /w1 → ortak kutu|w1 →/);

  // persistent history: lifecycle events and messages landed in the JSONL file and `coban history` reads them
  const hist = await c.cli('', 'history', '--limit', '100');
  assert.match(hist, /w1: işçi açıldı/);
  assert.match(hist, /w1→all: şema değişti/);
  assert.equal((await c.cli('', 'history', '--limit', '1')).split('\n').length, 1);
  assert.match(fs.readFileSync(path.join(c.dir, 'history.jsonl'), 'utf8').split('\n')[0], /^\{"ts":/);

  assert.equal(await c.cli('', 'kill', 'w1'), 'kapatıldı: w1');
  assert.doesNotMatch(await c.cli('', 'agents'), /^w1 /m);
});

test('no frames are drawn while nothing moves', async () => {
  await c.cli('', 'kill', 'w2');
  await until(async () => /orkestra .*idle/.test(await c.cli('', 'agents')), 10000);
  await sleep(3000); // let fades, "done" notices and highlights finish
  const b0 = c.bytes();
  await sleep(1500);
  assert.equal(c.bytes() - b0, 0, 'idle UI writes nothing');
});
